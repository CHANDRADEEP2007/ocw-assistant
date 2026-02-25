import { z } from 'zod';

import { id } from '../lib/id.js';
import { writeAuditLog } from '../services/auditLog.js';
import { getCalendarConflicts, getCalendarSummary, listCalendarEvents } from '../services/calendarService.js';
import { createDraftEmail } from '../services/emailDraftService.js';
import { ollamaChat } from '../services/ollamaClient.js';
import { prepareAction } from '../services/approvalEngine.js';
import {
  appendAgentTrace,
  createOrchestrationRun,
  logToolExecution,
  saveContextPack,
  saveExecutionPlan,
  saveJudgeDecision,
  updateOrchestrationRun,
} from '../services/orchestrationStore.js';
import type {
  ChatMessage,
  ContextPack,
  ExecutionPlan,
  JudgeDecision,
  OrchestratorInput,
  OrchestrationResponse,
  QuickAction,
  ToolCall,
  ToolExecutionResult,
  UiCard,
} from './types.js';

const plannerSchema = z.object({
  intent: z.string().min(1),
  steps: z.array(z.string()).default([]),
  toolCalls: z
    .array(
      z.object({
        tool: z.string(),
        args: z.record(z.unknown()).optional().default({}),
        sideEffect: z.boolean().optional(),
      }),
    )
    .default([]),
  artifacts: z.array(z.string()).default([]),
  riskLevel: z.enum(['low', 'medium', 'high']).default('low'),
});

function latestUserMessage(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i].content.trim();
  }
  return messages[messages.length - 1]?.content?.trim() || '';
}

function summarizeConversation(messages: ChatMessage[]) {
  const trimmed = messages
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
    .join('\n');
  return trimmed.slice(0, 700);
}

function maskSensitive(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|secret|password/i.test(k) ? '[redacted]' : maskSensitive(v);
    }
    return out;
  }
  return value;
}

type AgentPhase = 'reader' | 'thinker' | 'judge' | 'tool_executor' | 'responder' | 'run';

async function audit(traceId: string, phase: AgentPhase, status: string, details?: Record<string, unknown>, errorDetails?: string) {
  await writeAuditLog({
    actionType: `maoe_${phase}`,
    targetType: 'conversation',
    targetRef: traceId,
    status,
    details: details ? (maskSensitive(details) as Record<string, unknown>) : undefined,
    errorDetails,
  });
  await appendAgentTrace({
    runId: traceId,
    agent: phase,
    status,
    details: details ? (maskSensitive(details) as Record<string, unknown>) : undefined,
    errorDetails,
  });
}

function buildContextPack(input: OrchestratorInput): ContextPack {
  const latest = latestUserMessage(input.messages);
  const lc = latest.toLowerCase();
  const intentGuess =
    /calendar|agenda|schedule/.test(lc) ? 'calendar_query'
    : /draft email|compose email|write email/.test(lc) ? 'email_draft'
    : /send email/.test(lc) ? 'email_send'
    : /create event|schedule meeting/.test(lc) ? 'calendar_create'
    : /delete|remove|cancel/.test(lc) ? 'delete_action'
    : 'general_chat';

  return {
    intentGuess,
    conversationSummary: summarizeConversation(input.messages),
    toolContext: {
      enabledTools: input.tools ?? [],
      attachments: input.attachments ?? [],
    },
    constraints: {
      mode: input.mode,
      channel: input.channel ?? 'in_app',
      requiresLocalFirst: true,
    },
    userPrefs: input.userPrefs ?? {},
    latestUserMessage: latest,
  };
}

function extractAnchorDate(text: string): string | undefined {
  const m = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m?.[1];
}

function extractEmails(text: string): string[] {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

function parseEmailSendArgs(text: string): Record<string, unknown> {
  const to = extractEmails(text);
  const subjectMatch =
    text.match(/subject\s*:\s*([\s\S]*?)(?=\s+\bbody\s*:|\n|$)/i) ??
    text.match(/subject\s+"([^"]+)"/i) ??
    text.match(/subject\s+'([^']+)'/i);
  const bodyLineMatch = text.match(/\bbody\s*:\s*([\s\S]+)/i);
  const bodySectionMatch = text.match(/(?:^|\n)body\s*:\s*\n([\s\S]+)/i);
  const subject = (subjectMatch?.[1] ?? '').trim();
  let body = '';
  if (bodySectionMatch?.[1]) {
    body = bodySectionMatch[1].trim();
  } else if (bodyLineMatch?.[1]) {
    body = bodyLineMatch[1].trim();
    if (subject && body.toLowerCase().startsWith(subject.toLowerCase())) {
      body = body.slice(subject.length).trim();
    }
  }
  return {
    to,
    subject,
    body,
    requestedBy: 'local-user',
    source: 'chat',
  };
}

function parseCalendarCreateArgs(text: string): Record<string, unknown> {
  const titleMatch =
    text.match(/title\s*:\s*([\s\S]*?)(?=\s+\bon\s+20\d{2}-\d{2}-\d{2}\b|\s+\bat\s+\d{1,2}:\d{2}\b|\n|$)/i) ??
    text.match(/(?:create|schedule)\s+(?:an?\s+)?(?:event|meeting)\s+(.+?)\s+(?:on|at)\s/i);
  const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const timeMatches = [...text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
  const startTime = timeMatches[0] ? `${timeMatches[0][1]}:${timeMatches[0][2]}` : '';
  const endTime = timeMatches[1] ? `${timeMatches[1][1]}:${timeMatches[1][2]}` : '';
  return {
    eventTitle: (titleMatch?.[1] ?? '').trim(),
    startDate: dateMatch?.[1] ?? '',
    startTime,
    endTime,
    requestedBy: 'local-user',
    source: 'chat',
  };
}

function buildToolCall(tool: string, args: Record<string, unknown> = {}, callId?: string): ToolCall | null {
  const idValue = callId || id('tool');
  if (tool === 'calendar.summary') {
    const mode = args.mode === 'week' ? 'week' : 'today';
    const anchorDate = typeof args.anchorDate === 'string' ? args.anchorDate : undefined;
    return { id: idValue, tool, args: { mode, ...(anchorDate ? { anchorDate } : {}) }, sideEffect: false };
  }
  if (tool === 'calendar.events') {
    const mode = args.mode === 'week' ? 'week' : 'today';
    const anchorDate = typeof args.anchorDate === 'string' ? args.anchorDate : undefined;
    return { id: idValue, tool, args: { mode, ...(anchorDate ? { anchorDate } : {}) }, sideEffect: false };
  }
  if (tool === 'email.draft.generate') {
    const to = Array.isArray(args.to) ? args.to.filter((x): x is string => typeof x === 'string') : [];
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    const tone = args.tone === 'friendly' || args.tone === 'concise' || args.tone === 'professional' ? args.tone : undefined;
    const requestedBy = typeof args.requestedBy === 'string' ? args.requestedBy : undefined;
    return { id: idValue, tool, args: { to, prompt, ...(tone ? { tone } : {}), ...(requestedBy ? { requestedBy } : {}) }, sideEffect: true };
  }
  if (tool === 'email.send') return { id: idValue, tool, args, sideEffect: true };
  if (tool === 'calendar.event.create') return { id: idValue, tool, args, sideEffect: true };
  if (tool === 'delete.resource') return { id: idValue, tool, args, sideEffect: true };
  return null;
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}

async function planWithLlm(context: ContextPack, model: string): Promise<{ plan: ExecutionPlan; source: 'llm' } | null> {
  const system = [
    'You are the Thinker (Planner) Agent for a local-first assistant.',
    'Return only JSON matching this shape: {intent, steps:string[], toolCalls:[{tool,args,sideEffect}], artifacts:string[], riskLevel}.',
    'Allowed tools: calendar.summary, calendar.events, email.draft.generate, email.send, calendar.event.create, delete.resource',
    'Do not execute tools. Prefer clarification when fields are missing by leaving args incomplete.',
  ].join(' ');
  const user = JSON.stringify(
    {
      context,
      examples: {
        email_send_args: { to: ['a@example.com'], subject: '...', body: '...' },
        calendar_event_create_args: { eventTitle: '...', startDate: '2026-02-25', startTime: '14:00', endTime: '14:30' },
      },
    },
    null,
    2,
  );

  try {
    const res = await ollamaChat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
    });
    const content = res.message?.content?.trim() || '';
    const jsonText = extractJsonObject(content);
    if (!jsonText) return null;
    const raw = plannerSchema.parse(JSON.parse(jsonText));
    const toolCalls = raw.toolCalls
      .map((t) => buildToolCall(t.tool, t.args as Record<string, unknown>, id('tool')))
      .filter((t): t is ToolCall => Boolean(t));
    return {
      source: 'llm',
      plan: {
        intent: raw.intent,
        steps: raw.steps,
        toolCalls,
        artifacts: raw.artifacts,
        riskLevel: raw.riskLevel,
      },
    };
  } catch {
    return null;
  }
}

function planFromContext(context: ContextPack): ExecutionPlan {
  const text = context.latestUserMessage.toLowerCase();
  const anchorDate = extractAnchorDate(context.latestUserMessage);
  const toolCalls: ToolCall[] = [];
  const steps: string[] = [];
  const artifacts: string[] = [];
  let intent = context.intentGuess;
  let riskLevel: ExecutionPlan['riskLevel'] = 'low';

  if (context.intentGuess === 'calendar_query') {
    const mode = /week|this week|weekly/.test(text) ? 'week' : 'today';
    const wantsList = /list|show events|what do i have|agenda items/.test(text);
    toolCalls.push({
      id: id('tool'),
      tool: wantsList ? 'calendar.events' : 'calendar.summary',
      args: { mode, ...(anchorDate ? { anchorDate } : {}) },
      sideEffect: false,
    } as ToolCall);
    steps.push('Load calendar data', 'Compute summary/conflicts', 'Compose user-facing answer');
    artifacts.push('calendar_summary');
    intent = wantsList ? 'calendar_events' : 'calendar_summary';
    riskLevel = 'low';
  } else if (context.intentGuess === 'email_draft') {
    const recipients = extractEmails(context.latestUserMessage);
    toolCalls.push({
      id: id('tool'),
      tool: 'email.draft.generate',
      args: {
        to: recipients,
        prompt: context.latestUserMessage,
        requestedBy: 'local-user',
      },
      sideEffect: true,
    });
    steps.push('Extract recipients and drafting intent', 'Generate draft email', 'Return draft preview and approval action');
    artifacts.push('draft_email_preview', 'approval_action');
    intent = 'email_draft';
    riskLevel = 'medium';
  } else if (context.intentGuess === 'email_send') {
    toolCalls.push({ id: id('tool'), tool: 'email.send', args: parseEmailSendArgs(context.latestUserMessage), sideEffect: true });
    steps.push('Validate recipient/subject/body', 'Require approval before send', 'Execute only after approval');
    artifacts.push('approval_action');
    riskLevel = 'high';
  } else if (context.intentGuess === 'calendar_create') {
    toolCalls.push({ id: id('tool'), tool: 'calendar.event.create', args: parseCalendarCreateArgs(context.latestUserMessage), sideEffect: true });
    steps.push('Collect event fields', 'Require approval', 'Create calendar event after approval');
    artifacts.push('approval_action');
    riskLevel = 'high';
  } else if (context.intentGuess === 'delete_action') {
    toolCalls.push({ id: id('tool'), tool: 'delete.resource', args: {}, sideEffect: true });
    steps.push('Confirm target and scope', 'Block until explicit confirmation');
    artifacts.push('clarification');
    riskLevel = 'high';
  } else {
    steps.push('Answer using model response');
    artifacts.push('chat_response');
    riskLevel = context.constraints.mode === 'deep' ? 'medium' : 'low';
  }

  return { intent, steps, toolCalls, artifacts, riskLevel };
}

function judgePlan(context: ContextPack, plan: ExecutionPlan): JudgeDecision {
  const requiredFields: string[] = [];
  const policyNotes: string[] = [];
  void context;

  for (const toolCall of plan.toolCalls) {
    if (toolCall.tool === 'email.send') {
      const to = Array.isArray(toolCall.args.to) ? toolCall.args.to.filter((x): x is string => typeof x === 'string') : [];
      const subject = typeof toolCall.args.subject === 'string' ? toolCall.args.subject.trim() : '';
      const body = typeof toolCall.args.body === 'string' ? toolCall.args.body.trim() : '';
      if (to.length === 0) requiredFields.push('recipient');
      if (!subject) requiredFields.push('subject');
      if (!body) requiredFields.push('body');
      policyNotes.push('Email sending requires explicit approval.');
    }
    if (toolCall.tool === 'calendar.event.create') {
      const title = typeof toolCall.args.eventTitle === 'string' ? toolCall.args.eventTitle.trim() : '';
      const startDate = typeof toolCall.args.startDate === 'string' ? toolCall.args.startDate.trim() : '';
      const startTime = typeof toolCall.args.startTime === 'string' ? toolCall.args.startTime.trim() : '';
      const endTime = typeof toolCall.args.endTime === 'string' ? toolCall.args.endTime.trim() : '';
      if (!title) requiredFields.push('eventTitle');
      if (!startDate) requiredFields.push('startDate');
      if (!startTime) requiredFields.push('startTime');
      if (!endTime) requiredFields.push('endTime');
      policyNotes.push('Calendar event creation requires explicit approval.');
    }
    if (toolCall.tool === 'delete.resource') {
      policyNotes.push('Deletion requires explicit confirmation and approval.');
      return {
        status: 'blocked',
        requiredFields: ['confirmDeleteTarget'],
        policyNotes,
        requiresApproval: true,
      };
    }
    if (toolCall.tool === 'email.draft.generate' && toolCall.args.to.length === 0) {
      requiredFields.push('recipient');
      policyNotes.push('Need at least one email recipient to generate a draft.');
    }
  }

  if (requiredFields.length > 0) {
    return {
      status: 'needs_clarification',
      requiredFields: [...new Set(requiredFields)],
      policyNotes,
      requiresApproval: plan.toolCalls.some((t) => t.sideEffect),
    };
  }

  const requiresApproval = plan.toolCalls.some((t) => ['email.send', 'calendar.event.create', 'delete.resource'].includes(t.tool));
  if (requiresApproval) {
    return {
      status: 'requires_approval',
      requiredFields: [],
      policyNotes: policyNotes.length ? policyNotes : ['External action requires approval.'],
      requiresApproval: true,
    };
  }

  return { status: 'proceed', requiredFields: [], policyNotes, requiresApproval: false };
}

async function prepareApprovalArtifacts(traceId: string, toolCalls: ToolCall[]): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for (const toolCall of toolCalls) {
    if (toolCall.tool !== 'email.send' && toolCall.tool !== 'calendar.event.create') continue;
    const startedAt = new Date().toISOString();
    await audit(traceId, 'tool_executor', 'prepared', { tool: `${toolCall.tool}.approval_prepare`, toolCallId: toolCall.id });
    await logToolExecution({ runId: traceId, toolCall, status: 'prepared', startedAt });
    try {
      const approval = await prepareAction({
        actionType: toolCall.tool === 'email.send' ? 'email.send' : 'calendar.event.create',
        targetType: toolCall.tool === 'email.send' ? 'email_send_request' : 'calendar_event_request',
        payload: toolCall.args,
        requestedBy: (typeof toolCall.args.requestedBy === 'string' && toolCall.args.requestedBy) || 'local-user',
      });
      const result: ToolExecutionResult = {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        ok: true,
        data: { approvalAction: approval, preparedOnly: true },
      };
      results.push(result);
      await logToolExecution({
        runId: traceId,
        toolCall,
        status: 'executed',
        startedAt,
        finishedAt: new Date().toISOString(),
        result,
      });
      await audit(traceId, 'tool_executor', 'executed', { tool: `${toolCall.tool}.approval_prepare`, toolCallId: toolCall.id, preparedOnly: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: ToolExecutionResult = { toolCallId: toolCall.id, tool: toolCall.tool, ok: false, error: message };
      results.push(failure);
      await logToolExecution({
        runId: traceId,
        toolCall,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        result: failure,
        errorDetails: message,
      });
      await audit(traceId, 'tool_executor', 'failed', { tool: `${toolCall.tool}.approval_prepare`, toolCallId: toolCall.id }, message);
    }
  }
  return results;
}

async function executeToolCalls(traceId: string, toolCalls: ToolCall[]): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];

  for (const toolCall of toolCalls) {
    const startedAt = new Date().toISOString();
    await audit(traceId, 'tool_executor', 'prepared', { tool: toolCall.tool, toolCallId: toolCall.id });
    await logToolExecution({ runId: traceId, toolCall, status: 'prepared', startedAt });
    try {
      if (toolCall.tool === 'calendar.summary') {
        const data = await getCalendarSummary(toolCall.args.mode, toolCall.args.anchorDate);
        results.push({ toolCallId: toolCall.id, tool: toolCall.tool, ok: true, data });
      } else if (toolCall.tool === 'calendar.events') {
        const [events, conflicts] = await Promise.all([
          listCalendarEvents(toolCall.args.mode, toolCall.args.anchorDate),
          getCalendarConflicts(toolCall.args.mode, toolCall.args.anchorDate),
        ]);
        results.push({ toolCallId: toolCall.id, tool: toolCall.tool, ok: true, data: { events, conflicts } });
      } else if (toolCall.tool === 'email.draft.generate') {
        const data = await createDraftEmail(toolCall.args);
        results.push({ toolCallId: toolCall.id, tool: toolCall.tool, ok: true, data });
      } else {
        results.push({ toolCallId: toolCall.id, tool: toolCall.tool, ok: false, error: 'tool_not_implemented' });
      }
      const finishedAt = new Date().toISOString();
      const last = results[results.length - 1];
      await logToolExecution({
        runId: traceId,
        toolCall,
        status: last?.ok ? 'executed' : 'failed',
        startedAt,
        finishedAt,
        result: last,
        errorDetails: last?.ok ? undefined : last?.error,
      });
      await audit(traceId, 'tool_executor', 'executed', { tool: toolCall.tool, toolCallId: toolCall.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: ToolExecutionResult = { toolCallId: toolCall.id, tool: toolCall.tool, ok: false, error: message };
      results.push(failure);
      await logToolExecution({
        runId: traceId,
        toolCall,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        result: failure,
        errorDetails: message,
      });
      await audit(traceId, 'tool_executor', 'failed', { tool: toolCall.tool, toolCallId: toolCall.id }, message);
    }
  }

  return results;
}

function postToolJudge(initial: JudgeDecision, toolResults: ToolExecutionResult[]): JudgeDecision {
  if (initial.status !== 'proceed') return initial;
  const failed = toolResults.find((r) => !r.ok);
  if (!failed) return initial;
  return {
    status: 'blocked',
    requiredFields: [],
    policyNotes: [`Tool execution failed: ${failed.tool} (${failed.error || 'unknown_error'})`],
    requiresApproval: false,
  };
}

function buildClarificationPrompt(requiredFields: string[]) {
  const labels = requiredFields.join(', ');
  return `I need a bit more information before I can continue: ${labels}.`;
}

function buildCards(decision: JudgeDecision, toolResults: ToolExecutionResult[]): UiCard[] {
  const cards: UiCard[] = [];

  if (decision.status === 'needs_clarification') {
    cards.push({
      type: 'ClarificationPromptCard',
      title: 'Clarification Needed',
      data: {
        requiredFields: decision.requiredFields,
        prompt: buildClarificationPrompt(decision.requiredFields),
      },
    });
    return cards;
  }

  for (const result of toolResults) {
    if (!result.ok) continue;

    if (result.tool === 'calendar.summary') {
      const data = result.data as Record<string, unknown>;
      cards.push({
        type: 'CalendarSummaryCard',
        title: 'Calendar Summary',
        summary: typeof data.conciseSummary === 'string' ? data.conciseSummary : 'Calendar summary',
        data,
      });
    }

    if (result.tool === 'email.draft.generate') {
      const data = result.data as { draft?: Record<string, unknown>; approvalAction?: Record<string, unknown> };
      if (data.draft) {
        cards.push({
          type: 'DraftEmailPreviewCard',
          title: 'Draft Email Preview',
          data: data.draft,
        });
      }
      if (data.approvalAction) {
        cards.push({
          type: 'ApprovalActionCard',
          title: 'Approval Required To Send',
          data: data.approvalAction,
        });
      }
    }

    if (result.ok && (result.tool === 'email.send' || result.tool === 'calendar.event.create')) {
      const data = result.data as { approvalAction?: Record<string, unknown>; preparedOnly?: boolean } | undefined;
      if (data?.approvalAction) {
        cards.push({
          type: 'ApprovalActionCard',
          title: result.tool === 'email.send' ? 'Approval Required To Send Email' : 'Approval Required To Create Event',
          data: data.approvalAction,
        });
      }
    }
  }

  if (decision.status === 'requires_approval') {
    const approvalPrepared = toolResults.find((r) => r.ok && (r.tool === 'email.send' || r.tool === 'calendar.event.create'));
    cards.push({
      type: 'ApprovalActionCard',
      title: 'Approval Required',
      data: {
        status: 'prepared',
        note: decision.policyNotes.join(' '),
        approvalPrepared: Boolean(approvalPrepared),
      },
    });
  }

  return cards;
}

function buildQuickActions(decision: JudgeDecision, cards: UiCard[]): QuickAction[] {
  if (decision.status === 'needs_clarification') {
    return [{ id: id('qa'), label: 'Provide details', action: 'clarify' }];
  }
  if (decision.status === 'requires_approval') {
    return [
      { id: id('qa'), label: 'Open approvals', action: 'open_actions' },
      { id: id('qa'), label: 'Approve', action: 'approve' },
    ];
  }
  if (decision.status === 'blocked') {
    return [{ id: id('qa'), label: 'Retry', action: 'retry' }];
  }
  if (cards.some((c) => c.type === 'CalendarSummaryCard')) {
    return [{ id: id('qa'), label: 'View calendar', action: 'view_calendar' }];
  }
  if (cards.some((c) => c.type === 'DraftEmailPreviewCard')) {
    return [{ id: id('qa'), label: 'View draft', action: 'view_draft' }];
  }
  return [];
}

async function buildMessageText(input: OrchestratorInput, decision: JudgeDecision, toolResults: ToolExecutionResult[]): Promise<string> {
  if (decision.status === 'needs_clarification') {
    return buildClarificationPrompt(decision.requiredFields);
  }

  if (decision.status === 'requires_approval') {
    const prepared = toolResults.find((r) => r.ok && (r.tool === 'email.send' || r.tool === 'calendar.event.create'));
    if (prepared) {
      return 'I prepared an approval action. Review the approval card and approve before execution.';
    }
    return decision.policyNotes[0] || 'This action requires approval before execution.';
  }

  if (decision.status === 'blocked') {
    return decision.policyNotes[0] || 'I cannot proceed with that request.';
  }

  const summaryResult = toolResults.find((r) => r.ok && r.tool === 'calendar.summary');
  if (summaryResult && summaryResult.data && typeof summaryResult.data === 'object' && 'conciseSummary' in (summaryResult.data as Record<string, unknown>)) {
    return String((summaryResult.data as Record<string, unknown>).conciseSummary || 'Calendar summary ready.');
  }

  const draftResult = toolResults.find((r) => r.ok && r.tool === 'email.draft.generate');
  if (draftResult) {
    return 'I created a draft email and prepared an approval action for sending. Review the preview card before approving.';
  }

  const upstream = await ollamaChat({ model: input.model, messages: input.messages, stream: false });
  return upstream.message?.content?.trim() || '(No response text from model)';
}

export async function runMultiAgentOrchestration(input: OrchestratorInput): Promise<OrchestrationResponse> {
  const traceId = id('maoe');
  await createOrchestrationRun({
    runId: traceId,
    conversationId: input.conversationId,
    channel: input.channel ?? 'in_app',
    mode: input.mode,
    model: input.model,
    status: 'prepared',
  });
  await audit(traceId, 'run', 'prepared', { mode: input.mode, channel: input.channel ?? 'in_app' });

  try {
    const context = buildContextPack(input);
    await saveContextPack(traceId, context);
    await audit(traceId, 'reader', 'executed', { intentGuess: context.intentGuess, tools: context.toolContext.enabledTools });

    const llmPlanResult = input.mode === 'deep' ? await planWithLlm(context, input.model) : null;
    const plan = llmPlanResult?.plan ?? planFromContext(context);
    const plannerSource: 'heuristic' | 'llm' | 'heuristic_fallback' =
      llmPlanResult?.source === 'llm' ? 'llm' : input.mode === 'deep' ? 'heuristic_fallback' : 'heuristic';
    await saveExecutionPlan(traceId, plan);
    await audit(traceId, 'thinker', 'executed', {
      intent: plan.intent,
      riskLevel: plan.riskLevel,
      toolCalls: plan.toolCalls.map((t) => ({ tool: t.tool, sideEffect: t.sideEffect })),
      plannerSource,
    });

    const firstDecision = judgePlan(context, plan);
    await saveJudgeDecision(traceId, 'pre_tool', firstDecision);
    await audit(traceId, 'judge', 'executed', {
      status: firstDecision.status,
      requiresApproval: firstDecision.requiresApproval,
      requiredFields: firstDecision.requiredFields,
    });

    const toolResults =
      firstDecision.status === 'proceed'
        ? (plan.toolCalls.length > 0 ? await executeToolCalls(traceId, plan.toolCalls) : [])
        : firstDecision.status === 'requires_approval'
          ? await prepareApprovalArtifacts(traceId, plan.toolCalls)
          : [];

    const finalDecision = postToolJudge(firstDecision, toolResults);
    if (toolResults.length > 0) {
      await saveJudgeDecision(traceId, 'post_tool', finalDecision);
    }
    if (finalDecision.status !== firstDecision.status) {
      await audit(traceId, 'judge', 'executed', { status: finalDecision.status, policyNotes: finalDecision.policyNotes });
    }

    const cards = buildCards(finalDecision, toolResults);
    const quickActions = buildQuickActions(finalDecision, cards);
    const messageText = await buildMessageText(input, finalDecision, toolResults);

    await audit(traceId, 'responder', 'executed', {
      decision: finalDecision.status,
      cards: cards.map((c) => c.type),
      quickActions: quickActions.map((q) => q.action),
    });
    await updateOrchestrationRun({ runId: traceId, status: 'executed' });
    await audit(traceId, 'run', 'executed', { decision: finalDecision.status });

    return {
      runId: traceId,
      messageText,
      cards,
      quickActions,
      decision: finalDecision,
      toolResults,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateOrchestrationRun({ runId: traceId, status: 'failed', errorDetails: message });
    await audit(traceId, 'run', 'failed', undefined, message);
    throw error;
  }
}

export const __test__ = {
  extractEmails,
  parseEmailSendArgs,
  parseCalendarCreateArgs,
  planFromContext,
  judgePlan,
  buildContextPack,
};
