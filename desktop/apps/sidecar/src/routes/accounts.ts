import type { Express } from 'express';
import { z } from 'zod';

import { disconnectAccount, listConnectedAccounts, saveGoogleConnectedAccount } from '../services/accountService.js';
import { completeGoogleOAuth, googleOAuthStatus, startGoogleOAuth } from '../services/googleOAuth.js';

const startSchema = z.object({
  scopes: z.array(z.string()).optional(),
});

const completeSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

export function registerAccountRoutes(app: Express) {
  app.get('/api/accounts', async (_req, res) => {
    res.json({ items: await listConnectedAccounts() });
  });

  app.get('/api/accounts/google/oauth/status', (_req, res) => {
    res.json(googleOAuthStatus());
  });

  app.post('/api/accounts/google/oauth/start', (req, res) => {
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      res.json(startGoogleOAuth(parsed.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/accounts/google/oauth/complete', async (req, res) => {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const oauth = await completeGoogleOAuth(parsed.data);
      const account = await saveGoogleConnectedAccount({
        accountEmail: oauth.accountEmail,
        scopes: oauth.scopes,
        tokenBundle: oauth.tokenBundle,
      });
      res.json({ item: account });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/accounts/:accountId', async (req, res) => {
    try {
      await disconnectAccount(req.params.accountId);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'account_not_found' ? 404 : 400).json({ error: message });
    }
  });
}
