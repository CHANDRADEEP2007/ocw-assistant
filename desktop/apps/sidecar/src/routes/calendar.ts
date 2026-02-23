import type { Express } from 'express';
import { z } from 'zod';

import { writeAuditLog } from '../services/auditLog.js';
import { ensureDemoGoogleCalendarSeed, getCalendarConflicts, getCalendarSummary, listCalendarEvents } from '../services/calendarService.js';
import { syncGoogleCalendars } from '../services/googleCalendarSync.js';

const syncSchema = z.object({
  accountId: z.string().optional(),
});

export function registerCalendarRoutes(app: Express) {
  app.post('/api/calendar/demo-seed', async (_req, res) => {
    await ensureDemoGoogleCalendarSeed();
    res.json({ ok: true });
  });

  app.post('/api/calendar/google/sync', async (req, res) => {
    const parsed = syncSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    try {
      const result = await syncGoogleCalendars(parsed.data);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeAuditLog({
        actionType: 'google_calendar_sync',
        targetType: 'calendar',
        status: 'failed',
        errorDetails: message,
      });
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/calendar/today', async (req, res) => {
    const anchor = typeof req.query.anchorDate === 'string' ? req.query.anchorDate : undefined;
    const events = await listCalendarEvents('today', anchor);
    const conflicts = await getCalendarConflicts('today', anchor);
    await writeAuditLog({ actionType: 'calendar_today_view', targetType: 'calendar', status: 'executed', details: { count: events.length } });
    res.json({ events, conflicts });
  });

  app.get('/api/calendar/week', async (req, res) => {
    const anchor = typeof req.query.anchorDate === 'string' ? req.query.anchorDate : undefined;
    const events = await listCalendarEvents('week', anchor);
    const conflicts = await getCalendarConflicts('week', anchor);
    await writeAuditLog({ actionType: 'calendar_week_view', targetType: 'calendar', status: 'executed', details: { count: events.length } });
    res.json({ events, conflicts });
  });

  app.get('/api/calendar/conflicts', async (req, res) => {
    const mode = req.query.mode === 'week' ? 'week' : 'today';
    const anchor = typeof req.query.anchorDate === 'string' ? req.query.anchorDate : undefined;
    const conflicts = await getCalendarConflicts(mode, anchor);
    res.json({ items: conflicts });
  });

  app.get('/api/calendar/summary', async (req, res) => {
    const mode = req.query.mode === 'week' ? 'week' : 'today';
    const anchor = typeof req.query.anchorDate === 'string' ? req.query.anchorDate : undefined;
    const summary = await getCalendarSummary(mode, anchor);
    await writeAuditLog({ actionType: 'calendar_summary', targetType: 'calendar', status: 'executed', details: { mode } });
    res.json({ summary });
  });
}
