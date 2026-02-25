import express from 'express';
import cors from 'cors';
import type { Express } from 'express';

import './db/client.js';
import { runMigrations } from './db/migrate.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerEmailRoutes } from './routes/email.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';

export function createApp(): Express {
  runMigrations();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  registerHealthRoutes(app);
  registerChatRoutes(app);
  registerAccountRoutes(app);
  registerCalendarRoutes(app);
  registerEmailRoutes(app);
  registerActionRoutes(app);
  registerOrchestrationRoutes(app);

  return app;
}

