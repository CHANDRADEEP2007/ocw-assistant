import type { ApprovalAction, AuditEntry, ChatMessage } from '../types';

const BASE = (import.meta.env.VITE_SIDECAR_URL as string | undefined) || 'http://127.0.0.1:4318';

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `http_${res.status}`);
  return data as T;
}

export async function health() {
  return j<{ ok: boolean; service: string; port: number }>('/health');
}

export async function chat(input: {
  mode: 'quick' | 'deep';
  model?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: string[];
}) {
  return j<{ ok: true; profile: unknown; message: { role: 'assistant'; content: string } }>('/api/chat', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function prepareAction(input: {
  actionType: string;
  targetType: string;
  targetRef?: string;
  payload: Record<string, unknown>;
  requestedBy?: string;
}) {
  return j<{ item: ApprovalAction }>('/api/actions/prepare', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function transitionAction(actionId: string, nextStatus: 'approved' | 'executed' | 'failed' | 'cancelled') {
  return j<{ item: ApprovalAction }>(`/api/actions/${actionId}/transition`, {
    method: 'POST',
    body: JSON.stringify({ nextStatus, approvedBy: 'local-user' }),
  });
}

export async function listActions() {
  return j<{ items: ApprovalAction[] }>('/api/actions');
}

export async function listAuditLogs() {
  return j<{ items: AuditEntry[] }>('/api/audit-logs?limit=50');
}

export type ConnectedAccount = {
  id: string;
  provider: string;
  accountEmail: string | null;
  status: string;
  scopes: string[];
  tokenRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listAccounts() {
  return j<{ items: ConnectedAccount[] }>('/api/accounts');
}

export async function googleOAuthStatus() {
  return j<{ configured: boolean; redirectUri: string; scopes: string[] }>('/api/accounts/google/oauth/status');
}

export async function googleOAuthStart() {
  return j<{ provider: 'google'; state: string; scopes: string[]; redirectUri: string; authUrl: string }>(
    '/api/accounts/google/oauth/start',
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export async function googleOAuthComplete(input: { state: string; code: string }) {
  return j<{ item: ConnectedAccount }>('/api/accounts/google/oauth/complete', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function disconnectAccount(accountId: string) {
  return j<{ ok: true }>(`/api/accounts/${accountId}`, { method: 'DELETE' });
}

export type CalendarEvent = {
  id: string;
  calendarId: string;
  provider: string;
  title: string;
  status: 'confirmed' | 'tentative';
  startAt: string;
  endAt: string;
  timezone: string;
  attendees: string[];
  calendarName?: string;
};

export type CalendarConflict = {
  type: 'hard' | 'soft';
  eventIds: [string, string];
  startAt: string;
  endAt: string;
  explanation: string;
};

export type CalendarSummary = {
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

export async function calendarToday() {
  return j<{ events: CalendarEvent[]; conflicts: CalendarConflict[] }>('/api/calendar/today');
}

export async function calendarWeek() {
  return j<{ events: CalendarEvent[]; conflicts: CalendarConflict[] }>('/api/calendar/week');
}

export async function calendarSummary(mode: 'today' | 'week') {
  return j<{ summary: CalendarSummary }>(`/api/calendar/summary?mode=${mode}`);
}

export async function syncGoogleCalendar(accountId?: string) {
  return j<{ items: Array<{ accountId: string; accountEmail: string | null; calendarsSynced: number; eventsSynced: number }> }>(
    '/api/calendar/google/sync',
    {
      method: 'POST',
      body: JSON.stringify(accountId ? { accountId } : {}),
    },
  );
}

export type DraftEmail = {
  id: string;
  accountId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  sourcePrompt: string | null;
  tone: string | null;
  status: string;
  approvalActionId: string | null;
  gmailMessageId: string | null;
  errorDetails: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listEmailDrafts() {
  return j<{ items: DraftEmail[] }>('/api/email/drafts?limit=50');
}

export async function generateEmailDraft(input: {
  accountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subjectHint?: string;
  prompt: string;
  tone?: 'professional' | 'friendly' | 'concise';
}) {
  return j<{ draft: DraftEmail; approvalAction: ApprovalAction }>('/api/email/drafts/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function generateReplyDraftFromThread(threadId: string, input?: {
  accountId?: string;
  prompt?: string;
  tone?: 'professional' | 'friendly' | 'concise';
}) {
  return j<{ draft: DraftEmail; approvalAction: ApprovalAction; thread: GmailThread }>(
    `/api/email/threads/${encodeURIComponent(threadId)}/reply-draft`,
    {
      method: 'POST',
      body: JSON.stringify(input || {}),
    },
  );
}

export async function approveSendEmailDraft(draftId: string) {
  return j<{ draftId: string; gmailMessageId: string | null; status: string }>(`/api/email/drafts/${draftId}/approve-send`, {
    method: 'POST',
    body: JSON.stringify({ approvedBy: 'local-user' }),
  });
}

export type GmailThreadListItem = {
  id: string;
  snippet: string;
  historyId?: string;
};

export type GmailThreadMessage = {
  id: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  sentAt: string;
  snippet: string;
  bodyPreview: string;
  messageIdHeader: string;
  referencesHeader: string;
};

export type GmailThread = {
  id: string;
  subject: string;
  messages: GmailThreadMessage[];
  snippet: string;
};

export async function searchGmailThreads(input?: { q?: string; maxResults?: number; accountId?: string }) {
  const params = new URLSearchParams();
  if (input?.q) params.set('q', input.q);
  if (input?.maxResults) params.set('maxResults', String(input.maxResults));
  if (input?.accountId) params.set('accountId', input.accountId);
  const query = params.toString();
  return j<{ accountId: string; items: GmailThreadListItem[]; resultSizeEstimate: number }>(`/api/email/threads${query ? `?${query}` : ''}`);
}

export async function getGmailThread(threadId: string, accountId?: string) {
  const q = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return j<{ item: GmailThread }>(`/api/email/threads/${encodeURIComponent(threadId)}${q}`);
}

export function toChatMessage(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `${role}_${Math.random().toString(36).slice(2, 10)}`, role, content, createdAt: new Date().toISOString() };
}
