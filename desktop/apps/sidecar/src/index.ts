import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import './db/client.js';
import { runMigrations } from './db/migrate.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerEmailRoutes } from './routes/email.js';
import { registerHealthRoutes } from './routes/health.js';

async function boot() {
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

  app.listen(config.port, () => {
    console.log(`ocw-sidecar listening on http://127.0.0.1:${config.port}`);
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
