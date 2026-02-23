import type { Express } from 'express';
import { z } from 'zod';

import { approveAndSendDraftEmail, createDraftEmail, createReplyDraftFromThread, getDraftEmail, listDraftEmails } from '../services/emailDraftService.js';
import { getGmailThread, listGmailThreads } from '../services/gmailThreadService.js';

const generateSchema = z.object({
  accountId: z.string().optional(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subjectHint: z.string().optional(),
  prompt: z.string().min(1),
  tone: z.enum(['professional', 'friendly', 'concise']).optional(),
  requestedBy: z.string().optional(),
});

const approveSchema = z.object({
  approvedBy: z.string().optional(),
});

const replyDraftSchema = z.object({
  accountId: z.string().optional(),
  prompt: z.string().optional(),
  tone: z.enum(['professional', 'friendly', 'concise']).optional(),
  requestedBy: z.string().optional(),
});

const threadListSchema = z.object({
  accountId: z.string().optional(),
  q: z.string().optional(),
  maxResults: z.coerce.number().int().min(1).max(25).optional(),
});

export function registerEmailRoutes(app: Express) {
  app.get('/api/email/drafts', async (req, res) => {
    const limit = Number(req.query.limit || 50);
    res.json({ items: await listDraftEmails(Number.isFinite(limit) ? limit : 50) });
  });

  app.get('/api/email/drafts/:draftId', async (req, res) => {
    const item = await getDraftEmail(req.params.draftId);
    if (!item) return res.status(404).json({ error: 'draft_not_found' });
    res.json({ item });
  });

  app.get('/api/email/threads', async (req, res) => {
    const parsed = threadListSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const result = await listGmailThreads(parsed.data);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/email/threads/:threadId', async (req, res) => {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    try {
      const result = await getGmailThread({ threadId: req.params.threadId, accountId });
      res.json({ item: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/email/threads/:threadId/reply-draft', async (req, res) => {
    const parsed = replyDraftSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const result = await createReplyDraftFromThread({ threadId: req.params.threadId, ...parsed.data });
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/email/drafts/generate', async (req, res) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const result = await createDraftEmail(parsed.data);
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/email/drafts/:draftId/approve-send', async (req, res) => {
    const parsed = approveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const result = await approveAndSendDraftEmail({ draftId: req.params.draftId, approvedBy: parsed.data.approvedBy });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === 'draft_not_found' ? 404 : 400;
      res.status(code).json({ error: message });
    }
  });
}
