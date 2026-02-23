import type { Express } from 'express';

import { config } from '../config.js';

export function registerHealthRoutes(app: Express) {
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'ocw-sidecar', port: config.port });
  });
}
