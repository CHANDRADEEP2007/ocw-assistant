import { getConnectedAccountsByProvider } from './accountService.js';
import { writeAuditLog } from './auditLog.js';
import { forceRefreshGoogleAccessToken, getValidGoogleAccessToken } from './googleOAuth.js';

type GmailThreadsListResponse = {
  threads?: Array<{ id?: string; snippet?: string; historyId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type GmailThreadResponse = {
  id?: string;
  historyId?: string;
  messages?: GmailMessage[];
  snippet?: string;
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPayload;
};

type GmailPayload = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailPayload[];
};

export type GmailThreadListItem = {
  id: string;
  snippet: string;
  historyId?: string;
};

export type GmailThreadMessageDTO = {
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

export type GmailThreadDTO = {
  id: string;
  subject: string;
  messages: GmailThreadMessageDTO[];
  snippet: string;
};

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function header(payload: GmailPayload | undefined, name: string): string {
  const headers = payload?.headers || [];
  const match = headers.find((h) => (h.name || '').toLowerCase() === name.toLowerCase());
  return match?.value || '';
}

function extractBody(payload?: GmailPayload): string {
  if (!payload) return '';
  const mime = payload.mimeType || '';
  if (mime.startsWith('text/plain') && payload.body?.data) {
    try {
      return base64UrlDecode(payload.body.data);
    } catch {
      return '';
    }
  }
  for (const part of payload.parts || []) {
    const text = extractBody(part);
    if (text.trim()) return text;
  }
  if (payload.body?.data) {
    try {
      return base64UrlDecode(payload.body.data);
    } catch {
      return '';
    }
  }
  return '';
}

async function resolveGoogleAccountId(accountId?: string): Promise<string> {
  if (accountId) return accountId;
  const accounts = await getConnectedAccountsByProvider('google');
  if (!accounts.length) throw new Error('no_google_accounts_connected');
  return accounts[0].id;
}

async function gmailFetchJson<T>(accessToken: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const bodyText = await res.text();
  let body: unknown = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = bodyText;
  }
  if (!res.ok) {
    throw new Error(`gmail_http_${res.status}:${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body as T;
}

function isUnauthorized(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('gmail_http_401:');
}

async function gmailFetchJsonWithRefresh<T>(accountId: string, url: string): Promise<T> {
  let token = await getValidGoogleAccessToken(accountId);
  try {
    return await gmailFetchJson<T>(token, url);
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
    token = await forceRefreshGoogleAccessToken(accountId);
    return await gmailFetchJson<T>(token, url);
  }
}

export async function listGmailThreads(input?: { accountId?: string; q?: string; maxResults?: number }) {
  const accountId = await resolveGoogleAccountId(input?.accountId);
  const params = new URLSearchParams({
    maxResults: String(Math.max(1, Math.min(input?.maxResults || 10, 25))),
  });
  if (input?.q?.trim()) params.set('q', input.q.trim());

  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}`;
  const data = await gmailFetchJsonWithRefresh<GmailThreadsListResponse>(accountId, url);
  const items: GmailThreadListItem[] = (data.threads || [])
    .filter((t): t is { id: string; snippet?: string; historyId?: string } => Boolean(t.id))
    .map((t) => ({ id: t.id, snippet: t.snippet || '', historyId: t.historyId }));

  await writeAuditLog({
    actionType: 'gmail_threads_list',
    targetType: 'email_thread',
    targetRef: accountId,
    status: 'executed',
    details: { count: items.length, q: input?.q || null },
  });

  return { accountId, items, resultSizeEstimate: data.resultSizeEstimate ?? items.length };
}

export async function getGmailThread(input: { threadId: string; accountId?: string }): Promise<GmailThreadDTO> {
  const accountId = await resolveGoogleAccountId(input.accountId);
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(input.threadId)}?format=full`;
  const data = await gmailFetchJsonWithRefresh<GmailThreadResponse>(accountId, url);

  const messages: GmailThreadMessageDTO[] = (data.messages || [])
    .map((m) => {
      const payload = m.payload;
      const body = extractBody(payload).trim();
      const subject = header(payload, 'Subject') || '(No Subject)';
      const from = header(payload, 'From') || '';
      const to = header(payload, 'To') || '';
      const cc = header(payload, 'Cc') || '';
      const replyTo = header(payload, 'Reply-To') || '';
      const messageIdHeader = header(payload, 'Message-Id') || header(payload, 'Message-ID') || '';
      const referencesHeader = header(payload, 'References') || '';
      const dateRaw = header(payload, 'Date');
      const sentAt = dateRaw ? new Date(dateRaw).toISOString() : (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString());
      return {
        id: m.id || `msg_${Math.random().toString(36).slice(2, 8)}`,
        from,
        to,
        cc,
        replyTo,
        subject,
        sentAt,
        snippet: m.snippet || '',
        bodyPreview: (body || m.snippet || '').slice(0, 1200),
        messageIdHeader,
        referencesHeader,
      };
    })
    .sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));

  const subject = messages[0]?.subject || '(No Subject)';
  const thread: GmailThreadDTO = {
    id: data.id || input.threadId,
    subject,
    messages,
    snippet: data.snippet || messages[messages.length - 1]?.snippet || '',
  };

  await writeAuditLog({
    actionType: 'gmail_thread_get',
    targetType: 'email_thread',
    targetRef: thread.id,
    status: 'executed',
    details: { messageCount: messages.length, accountId },
  });

  return thread;
}
