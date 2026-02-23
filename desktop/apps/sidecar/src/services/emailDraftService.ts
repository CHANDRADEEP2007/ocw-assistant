import { desc, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { draftEmails } from '../db/schema.js';
import { id } from '../lib/id.js';
import { getConnectedAccountsByProvider } from './accountService.js';
import { writeAuditLog } from './auditLog.js';
import { prepareAction, transitionAction } from './approvalEngine.js';
import { getGmailThread } from './gmailThreadService.js';
import { forceRefreshGoogleAccessToken, getValidGoogleAccessToken } from './googleOAuth.js';

function now() {
  return new Date().toISOString();
}

type DraftRow = typeof draftEmails.$inferSelect;

export type DraftEmailDTO = {
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

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toDto(row: DraftRow): DraftEmailDTO {
  return {
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    inReplyTo: row.inReplyTo,
    referencesHeader: row.referencesHeader,
    to: parseJsonArray(row.toJson),
    cc: parseJsonArray(row.ccJson),
    bcc: parseJsonArray(row.bccJson),
    subject: row.subject,
    body: row.body,
    sourcePrompt: row.sourcePrompt,
    tone: row.tone,
    status: row.status,
    approvalActionId: row.approvalActionId,
    gmailMessageId: row.gmailMessageId,
    errorDetails: row.errorDetails,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function inferSubject(prompt: string, subjectHint?: string) {
  if (subjectHint?.trim()) return subjectHint.trim();
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  return cleaned ? `Re: ${cleaned.slice(0, 60)}` : 'Follow-up';
}

function generateBody(input: { prompt: string; tone: string; recipientName?: string }) {
  const greeting = input.recipientName ? `Hi ${input.recipientName},` : 'Hi,';
  const toneLine =
    input.tone === 'concise'
      ? 'Thanks for the update.'
      : input.tone === 'friendly'
        ? 'Thanks for the update and for taking the time to share the details.'
        : 'Thank you for the update.';
  return [
    greeting,
    '',
    toneLine,
    `Following up on: ${input.prompt.trim()}`,
    '',
    'Proposed next steps:',
    '- Confirm priorities and timeline',
    '- Share any blockers',
    '- Align on the next checkpoint',
    '',
    'Best,',
    'OCW Assistant (Draft)',
  ].join('\n');
}

export async function listDraftEmails(limit = 100): Promise<DraftEmailDTO[]> {
  const rows = await db.select().from(draftEmails).orderBy(desc(draftEmails.updatedAt)).limit(limit);
  return rows.map(toDto);
}

export async function getDraftEmail(draftId: string): Promise<DraftEmailDTO | null> {
  const rows = await db.select().from(draftEmails).where(eq(draftEmails.id, draftId)).limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export async function createDraftEmail(input: {
  accountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subjectHint?: string;
  prompt: string;
  tone?: 'professional' | 'friendly' | 'concise';
  requestedBy?: string;
}) {
  const ts = now();
  let accountId = input.accountId ?? null;
  if (!accountId) {
    const googleAccounts = await getConnectedAccountsByProvider('google');
    accountId = googleAccounts[0]?.id ?? null;
  }
  const tone = input.tone || 'professional';
  const subject = inferSubject(input.prompt, input.subjectHint);
  const body = generateBody({ prompt: input.prompt, tone, recipientName: input.to[0]?.split('@')[0] });

  const draftId = id('draft');
  const approval = await prepareAction({
    actionType: 'email.send',
    targetType: 'draft_email',
    targetRef: draftId,
    payload: { subject, to: input.to },
    requestedBy: input.requestedBy || 'local-user',
  });

  const row: DraftRow = {
    id: draftId,
    accountId,
    threadId: null,
    inReplyTo: null,
    referencesHeader: null,
    toJson: JSON.stringify(input.to),
    ccJson: JSON.stringify(input.cc || []),
    bccJson: JSON.stringify(input.bcc || []),
    subject,
    body,
    sourcePrompt: input.prompt,
    tone,
    status: 'prepared',
    approvalActionId: approval.id,
    gmailMessageId: null,
    errorDetails: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(draftEmails).values(row);
  await writeAuditLog({ actionType: 'email_draft_created', targetType: 'draft_email', targetRef: draftId, status: 'prepared' });
  return { draft: toDto(row), approvalAction: approval };
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildMimeMessage(draft: DraftEmailDTO) {
  const headers = [
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc.length ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${draft.subject}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`] : []),
    ...(draft.referencesHeader ? [`References: ${draft.referencesHeader}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    draft.body,
  ];
  return headers.join('\r\n');
}

async function gmailSendRaw(accessToken: string, raw: string, threadId?: string | null) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
  });
  const body = (await res.json()) as { id?: string; error?: unknown };
  if (!res.ok) {
    throw new Error(`gmail_send_http_${res.status}`);
  }
  return body;
}

async function gmailSendRawWithRefresh(accountId: string, raw: string, threadId?: string | null) {
  let accessToken = await getValidGoogleAccessToken(accountId);
  try {
    return await gmailSendRaw(accessToken, raw, threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('gmail_send_http_401')) throw error;
    accessToken = await forceRefreshGoogleAccessToken(accountId);
    return await gmailSendRaw(accessToken, raw, threadId);
  }
}

function normalizeReplySubject(subject: string) {
  const s = subject.trim();
  if (!s) return 'Re: (No Subject)';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function extractEmailAddress(value: string): string | null {
  const m = value.match(/<([^>]+)>/);
  if (m?.[1]) return m[1].trim();
  const raw = value.split(',')[0]?.trim();
  if (!raw) return null;
  return /\S+@\S+\.\S+/.test(raw) ? raw.replace(/^["']|["']$/g, '') : null;
}

function quoteForReply(messages: Array<{ from: string; sentAt: string; bodyPreview: string }>) {
  const last = messages[messages.length - 1];
  if (!last) return '';
  const quoted = (last.bodyPreview || '')
    .split('\n')
    .slice(0, 12)
    .map((line) => `> ${line}`)
    .join('\n');
  return [``, `On ${new Date(last.sentAt).toLocaleString()}, ${last.from} wrote:`, quoted].join('\n');
}

export async function createReplyDraftFromThread(input: {
  threadId: string;
  accountId?: string;
  prompt?: string;
  tone?: 'professional' | 'friendly' | 'concise';
  requestedBy?: string;
}) {
  const thread = await getGmailThread({ threadId: input.threadId, accountId: input.accountId });
  const latest = thread.messages[thread.messages.length - 1];
  if (!latest) throw new Error('thread_has_no_messages');

  const replyToHeader = latest.replyTo || latest.from;
  const toAddr = extractEmailAddress(replyToHeader);
  if (!toAddr) throw new Error('thread_reply_recipient_not_found');

  const prompt = (input.prompt || `Reply to thread: ${thread.subject}`).trim();
  const tone = input.tone || 'professional';
  const baseBody = generateBody({ prompt, tone, recipientName: toAddr.split('@')[0] });
  const body = `${baseBody}${quoteForReply(thread.messages)}`;
  const subject = normalizeReplySubject(thread.subject);
  const referencesValue = [latest.referencesHeader, latest.messageIdHeader].filter(Boolean).join(' ').trim() || null;

  const ts = now();
  let accountId = input.accountId ?? null;
  if (!accountId) {
    const googleAccounts = await getConnectedAccountsByProvider('google');
    accountId = googleAccounts[0]?.id ?? null;
  }

  const draftId = id('draft');
  const approval = await prepareAction({
    actionType: 'email.send',
    targetType: 'draft_email',
    targetRef: draftId,
    payload: { subject, to: [toAddr], threadId: thread.id },
    requestedBy: input.requestedBy || 'local-user',
  });

  const row: DraftRow = {
    id: draftId,
    accountId,
    threadId: thread.id,
    inReplyTo: latest.messageIdHeader || null,
    referencesHeader: referencesValue,
    toJson: JSON.stringify([toAddr]),
    ccJson: JSON.stringify([]),
    bccJson: JSON.stringify([]),
    subject,
    body,
    sourcePrompt: prompt,
    tone,
    status: 'prepared',
    approvalActionId: approval.id,
    gmailMessageId: null,
    errorDetails: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(draftEmails).values(row);

  await writeAuditLog({
    actionType: 'email_reply_draft_created',
    targetType: 'email_thread',
    targetRef: thread.id,
    status: 'prepared',
    details: { draftId, subject, to: [toAddr] },
  });
  return { draft: toDto(row), approvalAction: approval, thread };
}

export async function approveAndSendDraftEmail(input: { draftId: string; approvedBy?: string }) {
  const rows = await db.select().from(draftEmails).where(eq(draftEmails.id, input.draftId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error('draft_not_found');
  const draft = toDto(row);
  if (!draft.accountId) throw new Error('google_account_required');
  if (!draft.approvalActionId) throw new Error('approval_action_missing');

  await transitionAction({ actionId: draft.approvalActionId, nextStatus: 'approved', approvedBy: input.approvedBy || 'local-user' });
  await db.update(draftEmails).set({ status: 'approved', updatedAt: now() }).where(eq(draftEmails.id, draft.id));

  try {
    const mime = buildMimeMessage(draft);
    const raw = base64UrlEncode(mime);
    const sent = await gmailSendRawWithRefresh(draft.accountId, raw, draft.threadId);

    await transitionAction({ actionId: draft.approvalActionId, nextStatus: 'executed', approvedBy: input.approvedBy || 'local-user' });
    await db
      .update(draftEmails)
      .set({
        status: 'sent',
        gmailMessageId: sent.id || null,
        errorDetails: null,
        updatedAt: now(),
      })
      .where(eq(draftEmails.id, draft.id));

    await writeAuditLog({ actionType: 'email_sent', targetType: 'draft_email', targetRef: draft.id, status: 'executed', details: { gmailMessageId: sent.id || null } });
    return { draftId: draft.id, gmailMessageId: sent.id || null, status: 'sent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transitionAction({ actionId: draft.approvalActionId, nextStatus: 'failed', approvedBy: input.approvedBy || 'local-user', errorDetails: message });
    await db
      .update(draftEmails)
      .set({ status: 'failed', errorDetails: message, updatedAt: now() })
      .where(eq(draftEmails.id, draft.id));
    await writeAuditLog({ actionType: 'email_sent', targetType: 'draft_email', targetRef: draft.id, status: 'failed', errorDetails: message });
    throw error;
  }
}
