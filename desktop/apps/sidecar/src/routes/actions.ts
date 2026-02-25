import type { Express } from 'express';
import { z } from 'zod';

import { listAuditLogs } from '../services/auditLog.js';
import { executeApprovedAction } from '../services/actionExecutor.js';
import { listActions, prepareAction, reaffirmAction, transitionAction } from '../services/approvalEngine.js';

const prepareSchema = z.object({
  actionType: z.string().min(1),
  targetType: z.string().min(1),
  targetRef: z.string().optional(),
  payload: z.record(z.any()).default({}),
  requestedBy: z.string().default('local-user'),
});

const transitionSchema = z.object({
  nextStatus: z.enum(['approved', 'executed', 'failed', 'cancelled']),
  approvedBy: z.string().optional(),
  errorDetails: z.string().optional(),
});

const reaffirmSchema = z.object({
  approvedBy: z.string().optional(),
});

export function registerActionRoutes(app: Express) {
  app.get('/api/actions', async (_req, res) => {
    res.json({ items: await listActions(200) });
  });

  app.post('/api/actions/prepare', async (req, res) => {
    const parsed = prepareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const action = await prepareAction(parsed.data);
    res.status(201).json({ item: action });
  });

  app.post('/api/actions/:actionId/transition', async (req, res) => {
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      if (parsed.data.nextStatus === 'executed') {
        const result = await executeApprovedAction({ actionId: req.params.actionId, approvedBy: parsed.data.approvedBy });
        return res.json(result);
      }
      const action = await transitionAction({ actionId: req.params.actionId, ...parsed.data });
      return res.json({ item: action });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === 'action_not_found' ? 404 : 400;
      res.status(code).json({ error: message });
    }
  });

  app.post('/api/actions/:actionId/reaffirm', async (req, res) => {
    const parsed = reaffirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const item = await reaffirmAction({ actionId: req.params.actionId, approvedBy: parsed.data.approvedBy });
      return res.json({ item });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === 'action_not_found' ? 404 : 400;
      return res.status(code).json({ error: message });
    }
  });

  app.get('/api/audit-logs', async (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.json({ items: await listAuditLogs(Number.isFinite(limit) ? limit : 100) });
  });
}
