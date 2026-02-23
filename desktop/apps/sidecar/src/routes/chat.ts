import type { Express } from 'express';
import { z } from 'zod';

import { writeAuditLog } from '../services/auditLog.js';
import { resolveModelProfile } from '../services/modelRegistry.js';
import { ollamaChat } from '../services/ollamaClient.js';

const chatSchema = z.object({
  conversationId: z.string().min(1).optional(),
  mode: z.enum(['quick', 'deep']).default('quick'),
  model: z.string().min(1).optional(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().min(1),
    }),
  ).min(1),
  tools: z.array(z.string()).optional(),
});

export function registerChatRoutes(app: Express) {
  app.post('/api/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const profile = resolveModelProfile(parsed.data.mode, parsed.data.model);
    try {
      const upstream = await ollamaChat({ model: profile.model, messages: parsed.data.messages, stream: false });
      const text = upstream.message?.content?.trim() || '';
      await writeAuditLog({
        actionType: 'chat_completion',
        targetType: 'conversation',
        targetRef: parsed.data.conversationId,
        status: 'executed',
        details: { mode: profile.mode, model: profile.model, toolUse: profile.toolUse },
      });
      return res.json({
        ok: true,
        profile,
        message: { role: 'assistant', content: text || '(No response text from model)' },
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
