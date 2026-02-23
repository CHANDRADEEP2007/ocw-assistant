import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../db/client.js';
import { calendarEvents, calendars } from '../db/schema.js';
import { id } from '../lib/id.js';
import { getConnectedAccount, getConnectedAccountsByProvider } from './accountService.js';
import { writeAuditLog } from './auditLog.js';
import { forceRefreshGoogleAccessToken, getValidGoogleAccessToken } from './googleOAuth.js';

type GoogleCalendarList = {
  items?: Array<{
    id?: string;
    summary?: string;
    timeZone?: string;
    backgroundColor?: string;
    primary?: boolean;
  }>;
};

type GoogleEventsList = {
  items?: Array<{
    id?: string;
    summary?: string;
    description?: string;
    location?: string;
    status?: string;
    attendees?: Array<{ email?: string }>;
    start?: { dateTime?: string; date?: string; timeZone?: string };
    end?: { dateTime?: string; date?: string; timeZone?: string };
  }>;
};

function now() {
  return new Date().toISOString();
}

function normalizeEventTime(input?: { dateTime?: string; date?: string }, end = false): string | null {
  if (!input) return null;
  if (input.dateTime) return new Date(input.dateTime).toISOString();
  if (input.date) {
    const d = new Date(`${input.date}T00:00:00.000Z`);
    if (end) d.setUTCDate(d.getUTCDate());
    return d.toISOString();
  }
  return null;
}

async function googleFetchJson<T>(accessToken: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google_calendar_http_${res.status}:${text}`);
  }
  return (await res.json()) as T;
}

function isUnauthorizedGoogleError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.startsWith('google_calendar_http_401:');
}

async function googleFetchJsonWithRefresh<T>(accountId: string, url: string): Promise<T> {
  let accessToken = await getValidGoogleAccessToken(accountId);
  try {
    return await googleFetchJson<T>(accessToken, url);
  } catch (error) {
    if (!isUnauthorizedGoogleError(error)) throw error;
    accessToken = await forceRefreshGoogleAccessToken(accountId);
    return await googleFetchJson<T>(accessToken, url);
  }
}

async function syncOneGoogleAccount(accountId: string) {
  const account = await getConnectedAccount(accountId);
  if (!account || account.provider !== 'google') {
    throw new Error('google_account_not_found');
  }
  const ts = now();
  const calList = await googleFetchJsonWithRefresh<GoogleCalendarList>(
    accountId,
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  );
  const remoteCals = calList.items ?? [];

  const existingCals = await db.select().from(calendars).where(and(eq(calendars.provider, 'google'), eq(calendars.accountId, accountId)));
  const existingCalIds = existingCals.map((c) => c.id);
  if (existingCalIds.length) {
    await db.delete(calendarEvents).where(inArray(calendarEvents.calendarId, existingCalIds));
    await db.delete(calendars).where(and(eq(calendars.provider, 'google'), eq(calendars.accountId, accountId)));
  }

  const insertedCals: Array<{ localId: string; remoteId: string; name: string; timezone: string }> = [];
  for (const cal of remoteCals) {
    const localId = id('cal');
    const remoteId = cal.id || localId;
    await db.insert(calendars).values({
      id: localId,
      provider: 'google',
      accountId,
      name: cal.summary || 'Untitled Calendar',
      timezone: cal.timeZone || 'UTC',
      color: cal.backgroundColor || null,
      included: '1',
      createdAt: ts,
      updatedAt: ts,
    });
    insertedCals.push({ localId, remoteId, name: cal.summary || 'Untitled Calendar', timezone: cal.timeZone || 'UTC' });
  }

  const timeMin = new Date();
  timeMin.setUTCDate(timeMin.getUTCDate() - 7);
  const timeMax = new Date();
  timeMax.setUTCDate(timeMax.getUTCDate() + 30);

  let totalEvents = 0;
  for (const cal of insertedCals) {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: '250',
    });
    const events = await googleFetchJsonWithRefresh<GoogleEventsList>(
      accountId,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.remoteId)}/events?${params.toString()}`,
    );

    for (const event of events.items ?? []) {
      const startAt = normalizeEventTime(event.start, false);
      const endAt = normalizeEventTime(event.end, true);
      if (!startAt || !endAt) continue;
      await db.insert(calendarEvents).values({
        id: id('evt'),
        calendarId: cal.localId,
        provider: 'google',
        sourceEventId: event.id || null,
        title: event.summary || '(Untitled Event)',
        description: event.description || null,
        location: event.location || null,
        status: event.status === 'tentative' ? 'tentative' : 'confirmed',
        startAt,
        endAt,
        timezone: event.start?.timeZone || cal.timezone || 'UTC',
        attendeesJson: JSON.stringify((event.attendees || []).map((a) => a.email).filter(Boolean)),
        createdAt: ts,
        updatedAt: ts,
      });
      totalEvents += 1;
    }
  }

  await writeAuditLog({
    actionType: 'google_calendar_sync',
    targetType: 'calendar',
    targetRef: accountId,
    status: 'executed',
    details: { calendars: insertedCals.length, events: totalEvents },
  });

  return {
    accountId,
    accountEmail: account.accountEmail,
    calendarsSynced: insertedCals.length,
    eventsSynced: totalEvents,
  };
}

export async function syncGoogleCalendars(input?: { accountId?: string }) {
  if (input?.accountId) {
    return { items: [await syncOneGoogleAccount(input.accountId)] };
  }
  const googleAccounts = await getConnectedAccountsByProvider('google');
  if (!googleAccounts.length) {
    throw new Error('no_google_accounts_connected');
  }
  const items = [];
  for (const acct of googleAccounts) {
    items.push(await syncOneGoogleAccount(acct.id));
  }
  return { items };
}
