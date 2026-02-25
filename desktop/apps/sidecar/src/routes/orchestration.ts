import type { Express } from 'express';
import { z } from 'zod';

import { getOrchestrationRunDetails, listOrchestrationRuns } from '../services/orchestrationStore.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function registerOrchestrationRoutes(app: Express) {
  app.get('/api/orchestration/runs', async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const limit = parsed.data.limit ?? 50;
    return res.json({ items: await listOrchestrationRuns(limit) });
  });

  app.get('/api/orchestration/runs/:runId', async (req, res) => {
    const item = await getOrchestrationRunDetails(req.params.runId);
    if (!item) {
      return res.status(404).json({ error: 'orchestration_run_not_found' });
    }
    return res.json({ item });
  });
}

