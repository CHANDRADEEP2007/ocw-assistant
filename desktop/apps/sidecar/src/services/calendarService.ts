import { and, asc, eq, gte, lte } from 'drizzle-orm';

import { db } from '../db/client.js';
import { calendarEvents, calendars } from '../db/schema.js';
import { id } from '../lib/id.js';
import { getConnectedAccountsByProvider } from './accountService.js';
import { writeAuditLog } from './auditLog.js';

type CalendarEventDTO = {
  id: string;
  calendarId: string;
  provider: string;
  title: string;
  status: 'confirmed' | 'tentative';
  startAt: string;
  endAt: string;
  timezone: string;
  attendees: string[];
};

type ConflictDTO = {
  type: 'hard' | 'soft';
  eventIds: [string, string];
  startAt: string;
  endAt: string;
  explanation: string;
};

type DaySummary = {
  date: string;
  timezone: string;
  totalEvents: number;
  hardConflicts: number;
  softConflicts: number;
  backToBackChains: number;
  focusBlockSuggestions: Array<{ startAt: string; endAt: string; minutes: number }>;
  prepSuggestions: string[];
  conciseSummary: string;
};

function now() {
  return new Date().toISOString();
}

function parseISO(s: string): Date {
  return new Date(s);
}

function toDTO(row: typeof calendarEvents.$inferSelect): CalendarEventDTO {
  return {
    id: row.id,
    calendarId: row.calendarId,
    provider: row.provider,
    title: row.title,
    status: (row.status === 'tentative' ? 'tentative' : 'confirmed') as 'confirmed' | 'tentative',
    startAt: row.startAt,
    endAt: row.endAt,
    timezone: row.timezone,
    attendees: row.attendeesJson ? (JSON.parse(row.attendeesJson) as string[]) : [],
  };
}

function rangeUtc(date: Date, mode: 'today' | 'week') {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  if (mode === 'week') {
    const day = start.getUTCDay();
    const diffToMonday = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - diffToMonday);
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (mode === 'today' ? 1 : 7));
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function detectConflicts(events: CalendarEventDTO[]): ConflictDTO[] {
  const sorted = [...events].sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  const out: ConflictDTO[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const left = sorted[i];
    const leftEnd = parseISO(left.endAt).getTime();
    for (let j = i + 1; j < sorted.length; j += 1) {
      const right = sorted[j];
      const rightStart = parseISO(right.startAt).getTime();
      if (rightStart >= leftEnd) break;
      const overlapStart = new Date(Math.max(parseISO(left.startAt).getTime(), rightStart)).toISOString();
      const overlapEnd = new Date(Math.min(leftEnd, parseISO(right.endAt).getTime())).toISOString();
      if (overlapStart >= overlapEnd) continue;
      const type = left.status === 'confirmed' && right.status === 'confirmed' ? 'hard' : 'soft';
      out.push({
        type,
        eventIds: [left.id, right.id],
        startAt: overlapStart,
        endAt: overlapEnd,
        explanation: `${type} conflict: ${left.title} overlaps with ${right.title}`,
      });
    }
  }
  return out;
}

function detectBackToBackChains(events: CalendarEventDTO[]) {
  const sorted = [...events].sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  let chains = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = parseISO(sorted[i - 1].endAt).getTime();
    const currStart = parseISO(sorted[i].startAt).getTime();
    const gapMin = (currStart - prevEnd) / 60000;
    if (gapMin >= 0 && gapMin <= 10) chains += 1;
  }
  return chains;
}

function focusBlocks(events: CalendarEventDTO[], startIso: string, endIso: string) {
  const sorted = [...events].sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  const blocks: Array<{ startAt: string; endAt: string; minutes: number }> = [];
  let cursor = parseISO(startIso).getTime();
  const end = parseISO(endIso).getTime();

  for (const event of sorted) {
    const evStart = parseISO(event.startAt).getTime();
    const evEnd = parseISO(event.endAt).getTime();
    if (evEnd <= cursor) continue;
    if (evStart > cursor) {
      const gap = evStart - cursor;
      if (gap >= 60 * 60000) {
        blocks.push({
          startAt: new Date(cursor).toISOString(),
          endAt: new Date(evStart).toISOString(),
          minutes: Math.floor(gap / 60000),
        });
      }
    }
    cursor = Math.max(cursor, evEnd);
  }

  if (end > cursor) {
    const gap = end - cursor;
    if (gap >= 60 * 60000) {
      blocks.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(end).toISOString(), minutes: Math.floor(gap / 60000) });
    }
  }
  return blocks.slice(0, 3);
}

export async function ensureDemoGoogleCalendarSeed(): Promise<void> {
  const existing = await db.select().from(calendars).limit(1);
  if (existing.length > 0) {
    return;
  }

  const ts = now();
  const cal1 = { id: id('cal'), provider: 'google', accountId: 'google_demo', name: 'Google Work', timezone: 'UTC', color: '#0b63d0', included: '1', createdAt: ts, updatedAt: ts };
  const cal2 = { id: id('cal'), provider: 'google', accountId: 'google_demo', name: 'Google Personal', timezone: 'UTC', color: '#0f766e', included: '1', createdAt: ts, updatedAt: ts };
  await db.insert(calendars).values([cal1, cal2]);

  const base = new Date();
  const d0 = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0, 0));
  const mk = (calendarId: string, dayOffset: number, h: number, m: number, durMin: number, title: string, status: 'confirmed' | 'tentative' = 'confirmed') => {
    const start = new Date(d0);
    start.setUTCDate(start.getUTCDate() + dayOffset);
    start.setUTCHours(h, m, 0, 0);
    const end = new Date(start.getTime() + durMin * 60000);
    return {
      id: id('evt'),
      calendarId,
      provider: 'google',
      sourceEventId: null,
      title,
      description: null,
      location: null,
      status,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      timezone: 'UTC',
      attendeesJson: JSON.stringify([]),
      createdAt: ts,
      updatedAt: ts,
    };
  };

  await db.insert(calendarEvents).values([
    mk(cal1.id, 0, 9, 30, 30, 'Daily Standup'),
    mk(cal1.id, 0, 10, 0, 60, 'Product Review'),
    mk(cal2.id, 0, 10, 30, 45, 'Doctor Call', 'tentative'),
    mk(cal1.id, 0, 13, 0, 30, '1:1 with Design'),
    mk(cal1.id, 0, 13, 35, 25, 'Follow-up Sync'),
    mk(cal2.id, 0, 16, 0, 60, 'Gym Block', 'tentative'),
    mk(cal1.id, 1, 11, 0, 60, 'Sprint Planning'),
    mk(cal1.id, 2, 14, 0, 60, 'Client Demo'),
    mk(cal2.id, 4, 18, 0, 90, 'Family Dinner'),
  ]);

  await writeAuditLog({ actionType: 'calendar_seed_demo', targetType: 'calendar', status: 'executed' });
}

async function ensureCalendarDataAvailable() {
  const googleAccounts = await getConnectedAccountsByProvider('google');
  const anyCalendars = await db.select().from(calendars).limit(1);
  if (googleAccounts.length > 0) {
    return;
  }
  if (anyCalendars.length === 0) {
    await ensureDemoGoogleCalendarSeed();
  }
}

export async function listCalendarEvents(mode: 'today' | 'week', anchorDateIso?: string) {
  await ensureCalendarDataAvailable();
  const anchor = anchorDateIso ? new Date(anchorDateIso) : new Date();
  const { start, end } = rangeUtc(anchor, mode);

  const rows = await db
    .select({
      event: calendarEvents,
      calendar: calendars,
    })
    .from(calendarEvents)
    .innerJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
    .where(
      and(
        eq(calendars.included, '1'),
        gte(calendarEvents.startAt, start),
        lte(calendarEvents.startAt, end),
      ),
    )
    .orderBy(asc(calendarEvents.startAt));

  return rows.map((r) => ({
    ...toDTO(r.event),
    calendarName: r.calendar.name,
    calendarIncluded: r.calendar.included === '1',
  }));
}

export async function getCalendarConflicts(mode: 'today' | 'week', anchorDateIso?: string) {
  const events = await listCalendarEvents(mode, anchorDateIso);
  return detectConflicts(events);
}

export async function getCalendarSummary(mode: 'today' | 'week', anchorDateIso?: string): Promise<DaySummary> {
  const anchor = anchorDateIso ? new Date(anchorDateIso) : new Date();
  const { start, end } = rangeUtc(anchor, mode);
  const events = await listCalendarEvents(mode, anchorDateIso);
  const conflicts = detectConflicts(events);
  const hardConflicts = conflicts.filter((c) => c.type === 'hard').length;
  const softConflicts = conflicts.filter((c) => c.type === 'soft').length;
  const backToBackChains = detectBackToBackChains(events);
  const focusBlockSuggestions = focusBlocks(events, start, end);

  const prepSuggestions = events.slice(0, 3).map((e) => `Prep for ${e.title} (${e.startAt})`);
  const conciseSummary =
    mode === 'today'
      ? `You have ${events.length} events today, with ${hardConflicts} hard conflicts and ${backToBackChains} back-to-back handoffs.`
      : `This week includes ${events.length} events, ${hardConflicts} hard conflicts, and ${focusBlockSuggestions.length} suggested focus blocks.`;

  return {
    date: start.slice(0, 10),
    timezone: 'UTC',
    totalEvents: events.length,
    hardConflicts,
    softConflicts,
    backToBackChains,
    focusBlockSuggestions,
    prepSuggestions,
    conciseSummary,
  };
}

function combineDateTimeUtc(date: string, time: string) {
  const iso = `${date}T${time.length === 5 ? `${time}:00` : time}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('invalid_datetime');
  }
  return parsed.toISOString();
}

export async function createLocalCalendarEventFromApprovedAction(input: {
  actionId: string;
  payload: Record<string, unknown>;
}) {
  const ts = now();
  let calendar = (await db.select().from(calendars).where(eq(calendars.included, '1')).limit(1))[0];
  if (!calendar) {
    const created = {
      id: id('cal'),
      provider: 'local',
      accountId: null,
      name: 'Local Action Calendar',
      timezone: 'UTC',
      color: '#2563eb',
      included: '1',
      createdAt: ts,
      updatedAt: ts,
    } as const;
    await db.insert(calendars).values(created);
    calendar = created as unknown as typeof calendars.$inferSelect;
  }

  const title = typeof input.payload.eventTitle === 'string' && input.payload.eventTitle.trim() ? input.payload.eventTitle.trim() : 'Untitled Event';
  const startDate = typeof input.payload.startDate === 'string' ? input.payload.startDate.trim() : '';
  const startTime = typeof input.payload.startTime === 'string' ? input.payload.startTime.trim() : '';
  const endTime = typeof input.payload.endTime === 'string' ? input.payload.endTime.trim() : '';
  if (!startDate || !startTime || !endTime) {
    throw new Error('calendar_event_fields_missing');
  }

  const startAt = combineDateTimeUtc(startDate, startTime);
  const endAt = combineDateTimeUtc(startDate, endTime);
  if (endAt <= startAt) {
    throw new Error('calendar_event_end_before_start');
  }

  const event = {
    id: id('evt'),
    calendarId: calendar.id,
    provider: calendar.provider,
    sourceEventId: null,
    title,
    description: typeof input.payload.description === 'string' ? input.payload.description : null,
    location: typeof input.payload.location === 'string' ? input.payload.location : null,
    status: 'confirmed',
    startAt,
    endAt,
    timezone: 'UTC',
    attendeesJson: JSON.stringify(
      Array.isArray(input.payload.attendees) ? input.payload.attendees.filter((x): x is string => typeof x === 'string') : [],
    ),
    createdAt: ts,
    updatedAt: ts,
  } as const;
  await db.insert(calendarEvents).values(event);
  await writeAuditLog({
    actionType: 'calendar_event_created_from_action',
    targetType: 'calendar_event',
    targetRef: event.id,
    status: 'executed',
    details: { actionId: input.actionId, calendarId: calendar.id },
  });

  return { event };
}
