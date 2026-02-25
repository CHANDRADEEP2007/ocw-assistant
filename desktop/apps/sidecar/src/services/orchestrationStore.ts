import { asc, desc, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import {
  agentTraces,
  contextPacks,
  executionPlans,
  judgeDecisions,
  orchestrationRuns,
  toolExecutionLogs,
} from '../db/schema.js';
import { id } from '../lib/id.js';
import type { ContextPack, ExecutionPlan, JudgeDecision, ToolCall, ToolExecutionResult } from '../orchestration/types.js';

function now() {
  return new Date().toISOString();
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function createOrchestrationRun(input: {
  runId?: string;
  conversationId?: string;
  channel: string;
  mode: string;
  model: string;
  status?: string;
}) {
  const ts = now();
  const row = {
    id: input.runId ?? id('maoe'),
    conversationId: input.conversationId ?? null,
    channel: input.channel,
    mode: input.mode,
    model: input.model,
    status: input.status ?? 'prepared',
    errorDetails: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(orchestrationRuns).values(row);
  return row;
}

export async function updateOrchestrationRun(input: { runId: string; status: string; errorDetails?: string | null }) {
  await db
    .update(orchestrationRuns)
    .set({
      status: input.status,
      errorDetails: input.errorDetails ?? null,
      updatedAt: now(),
    })
    .where(eq(orchestrationRuns.id, input.runId));
}

export async function saveContextPack(runId: string, context: ContextPack) {
  await db.insert(contextPacks).values({
    id: id('ctx'),
    runId,
    intentGuess: context.intentGuess,
    payloadJson: json(context),
    createdAt: now(),
  });
}

export async function saveExecutionPlan(runId: string, plan: ExecutionPlan) {
  await db.insert(executionPlans).values({
    id: id('plan'),
    runId,
    intent: plan.intent,
    riskLevel: plan.riskLevel,
    payloadJson: json(plan),
    createdAt: now(),
  });
}

export async function saveJudgeDecision(runId: string, stage: 'pre_tool' | 'post_tool', decision: JudgeDecision) {
  await db.insert(judgeDecisions).values({
    id: id('dec'),
    runId,
    stage,
    status: decision.status,
    requiresApproval: decision.requiresApproval ? '1' : '0',
    requiredFieldsJson: json(decision.requiredFields),
    policyNotesJson: json(decision.policyNotes),
    payloadJson: json(decision),
    createdAt: now(),
  });
}

export async function appendAgentTrace(input: {
  runId: string;
  agent: 'reader' | 'thinker' | 'judge' | 'tool_executor' | 'responder' | 'run';
  status: string;
  details?: Record<string, unknown>;
  errorDetails?: string;
}) {
  await db.insert(agentTraces).values({
    id: id('trace'),
    runId: input.runId,
    agent: input.agent,
    status: input.status,
    detailsJson: input.details ? json(input.details) : null,
    errorDetails: input.errorDetails ?? null,
    createdAt: now(),
  });
}

export async function logToolExecution(input: {
  runId: string;
  toolCall: ToolCall;
  status: 'prepared' | 'executed' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  result?: ToolExecutionResult | unknown;
  errorDetails?: string;
}) {
  await db.insert(toolExecutionLogs).values({
    id: id('texec'),
    runId: input.runId,
    toolCallId: input.toolCall.id,
    tool: input.toolCall.tool,
    status: input.status,
    argsJson: json(input.toolCall.args),
    resultJson: input.result ? json(input.result) : null,
    errorDetails: input.errorDetails ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    createdAt: now(),
  });
}

export async function listOrchestrationRuns(limit = 50) {
  const rows = await db.select().from(orchestrationRuns).orderBy(desc(orchestrationRuns.createdAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    channel: row.channel,
    mode: row.mode,
    model: row.model,
    status: row.status,
    errorDetails: row.errorDetails,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getOrchestrationRun(runId: string) {
  const rows = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId)).limit(1);
  return rows[0] ?? null;
}

export async function getOrchestrationRunDetails(runId: string) {
  const run = await getOrchestrationRun(runId);
  if (!run) return null;

  const [contexts, plans, decisions, traces, toolLogs] = await Promise.all([
    db.select().from(contextPacks).where(eq(contextPacks.runId, runId)).orderBy(asc(contextPacks.createdAt)),
    db.select().from(executionPlans).where(eq(executionPlans.runId, runId)).orderBy(asc(executionPlans.createdAt)),
    db.select().from(judgeDecisions).where(eq(judgeDecisions.runId, runId)).orderBy(asc(judgeDecisions.createdAt)),
    db.select().from(agentTraces).where(eq(agentTraces.runId, runId)).orderBy(asc(agentTraces.createdAt)),
    db.select().from(toolExecutionLogs).where(eq(toolExecutionLogs.runId, runId)).orderBy(asc(toolExecutionLogs.createdAt)),
  ]);

  return {
    run: {
      id: run.id,
      conversationId: run.conversationId,
      channel: run.channel,
      mode: run.mode,
      model: run.model,
      status: run.status,
      errorDetails: run.errorDetails,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    contextPacks: contexts.map((row) => ({
      id: row.id,
      runId: row.runId,
      intentGuess: row.intentGuess,
      payload: parseJson<Record<string, unknown>>(row.payloadJson),
      createdAt: row.createdAt,
    })),
    plans: plans.map((row) => ({
      id: row.id,
      runId: row.runId,
      intent: row.intent,
      riskLevel: row.riskLevel,
      payload: parseJson<Record<string, unknown>>(row.payloadJson),
      createdAt: row.createdAt,
    })),
    decisions: decisions.map((row) => ({
      id: row.id,
      runId: row.runId,
      stage: row.stage,
      status: row.status,
      requiresApproval: row.requiresApproval === '1',
      requiredFields: parseJson<string[]>(row.requiredFieldsJson) ?? [],
      policyNotes: parseJson<string[]>(row.policyNotesJson) ?? [],
      payload: parseJson<Record<string, unknown>>(row.payloadJson),
      createdAt: row.createdAt,
    })),
    traces: traces.map((row) => ({
      id: row.id,
      runId: row.runId,
      agent: row.agent,
      status: row.status,
      details: parseJson<Record<string, unknown>>(row.detailsJson),
      errorDetails: row.errorDetails,
      createdAt: row.createdAt,
    })),
    toolExecutions: toolLogs.map((row) => ({
      id: row.id,
      runId: row.runId,
      toolCallId: row.toolCallId,
      tool: row.tool,
      status: row.status,
      args: parseJson<Record<string, unknown>>(row.argsJson),
      result: parseJson<Record<string, unknown>>(row.resultJson),
      errorDetails: row.errorDetails,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
    })),
  };
}
