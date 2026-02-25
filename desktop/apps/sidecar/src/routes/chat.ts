import type { Express } from 'express';
import { z } from 'zod';

import { writeAuditLog } from '../services/auditLog.js';
import { resolveModelProfile } from '../services/modelRegistry.js';
import { runMultiAgentOrchestration } from '../orchestration/engine.js';

const chatSchema = z.object({
  conversationId: z.string().min(1).optional(),
  mode: z.enum(['quick', 'deep']).default('quick'),
  model: z.string().min(1).optional(),
  channel: z.enum(['in_app', 'telegram']).optional(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().min(1),
    }),
  ).min(1),
  tools: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
  userPrefs: z.record(z.unknown()).optional(),
});

export function registerChatRoutes(app: Express) {
  app.post('/api/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const profile = resolveModelProfile(parsed.data.mode, parsed.data.model);
    try {
      const orchestration = await runMultiAgentOrchestration({
        conversationId: parsed.data.conversationId,
        mode: profile.mode,
        model: profile.model,
        messages: parsed.data.messages,
        tools: parsed.data.tools,
        channel: parsed.data.channel,
        attachments: parsed.data.attachments,
        userPrefs: parsed.data.userPrefs,
      });
      await writeAuditLog({
        actionType: 'chat_completion',
        targetType: 'conversation',
        targetRef: parsed.data.conversationId,
        status: 'executed',
        details: {
          mode: profile.mode,
          model: profile.model,
          toolUse: profile.toolUse,
          orchestrationDecision: orchestration.decision.status,
          orchestrationCards: orchestration.cards.map((c) => c.type),
        },
      });
      return res.json({
        ok: true,
        profile,
        message: { role: 'assistant', content: orchestration.messageText || '(No response text from model)' },
        cards: orchestration.cards,
        quickActions: orchestration.quickActions,
        orchestration: {
          runId: orchestration.runId,
          decision: orchestration.decision,
          toolResults: orchestration.toolResults.map((r) => ({
            toolCallId: r.toolCallId,
            tool: r.tool,
            ok: r.ok,
            error: r.error,
          })),
        },
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      await writeAuditLog({
        actionType: 'chat_completion',
        targetType: 'conversation',
        targetRef: parsed.data.conversationId,
        status: 'failed',
        errorDetails: details,
      });
      return res.status(502).json({ error: 'ollama_error', details });
    }
  });
}
