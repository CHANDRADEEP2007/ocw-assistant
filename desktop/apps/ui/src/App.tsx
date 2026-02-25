import { useEffect, useRef, useState, useTransition } from 'react';
import type { ChangeEvent } from 'react';

import { InlineCard } from './components/InlineCard';
import {
  calendarSummary,
  calendarToday,
  calendarWeek,
  chat,
  generateEmailDraft,
  generateReplyDraftFromThread,
  getGmailThread,
  googleOAuthComplete,
  googleOAuthStart,
  googleOAuthStatus,
  health,
  listOrchestrationRuns,
  getOrchestrationRun,
  listEmailDrafts,
  listActions,
  listAccounts,
  listAuditLogs,
  prepareAction,
  reaffirmAction as reaffirmApprovalAction,
  searchGmailThreads,
  syncGoogleCalendar,
  toChatMessage,
  transitionAction,
  approveSendEmailDraft,
} from './lib/api';
import type { ApprovalAction, AuditEntry, ChatMessage } from './types';
import type { CalendarConflict, CalendarEvent, CalendarSummary, OrchestrationRunDetails, OrchestrationRunListItem } from './lib/api';

const TOOL_OPTIONS = ['Calendar', 'Email', 'Projects'] as const;

function slashSuggestions(input: string) {
  const all = ['/schedule', '/summarize', '/draft', '/projects', '/today', '/week'];
  const q = input.trim().toLowerCase();
  return q.startsWith('/') ? all.filter((x) => x.startsWith(q)).slice(0, 5) : [];
}

function formatDateTimeLabel(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatTimeRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${start} -> ${end}`;
  return `${s.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - ${e.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function startOfWeek(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export default function App() {
  type CalendarPreviewCard =
    | {
        id: string;
        kind: 'today';
        title: string;
        summary: string;
        metrics: { totalEvents: number; hardConflicts: number; softConflicts: number; backToBackChains: number };
        focusBlocks: Array<{ startAt: string; endAt: string; minutes: number }>;
        topEvents: Array<{ startAt: string; title: string; calendarName?: string }>;
      }
    | {
        id: string;
        kind: 'week';
        title: string;
        summary: string;
        metrics: { totalEvents: number; hardConflicts: number; softConflicts: number };
        conflicts: Array<{ type: string; explanation: string }>;
        prepSuggestions: string[];
      };

  type EmailPreviewCard =
    | {
        id: string;
        kind: 'draft';
        title: string;
        recipients: string[];
        subject: string;
        bodyPreview: string;
        status: string;
        threadId?: string | null;
      }
    | {
        id: string;
        kind: 'thread';
        title: string;
        subject: string;
        threadId: string;
        messageCount: number;
        participants: string[];
        snippet: string;
        latestFrom?: string;
      };

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspaceView, setWorkspaceView] = useState<'assistant' | 'calendar' | 'drafts' | 'tools' | 'actions' | 'audit' | 'orchestration' | 'projects' | 'settings'>('assistant');
  const [composer, setComposer] = useState('');
  const [model, setModel] = useState('llama3:8b');
  const [mode, setMode] = useState<'quick' | 'deep'>('quick');
  const [tools, setTools] = useState<string[]>([]);
  const [status, setStatus] = useState('Checking sidecar...');
  const [actions, setActions] = useState<ApprovalAction[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [orchestrationRuns, setOrchestrationRuns] = useState<OrchestrationRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [selectedRunDetails, setSelectedRunDetails] = useState<OrchestrationRunDetails | null>(null);
  const [orchestrationStatus, setOrchestrationStatus] = useState('');
  const [accounts, setAccounts] = useState<Array<{ id: string; provider: string; accountEmail: string | null; status: string }>>([]);
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null);
  const [googleRedirectUri, setGoogleRedirectUri] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthState, setOauthState] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectProvider, setConnectProvider] = useState<'google' | 'outlook'>('google');
  const [toolsDrawerOpen, setToolsDrawerOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; size: number; type: string }>>([]);
  const [calendarSyncStatus, setCalendarSyncStatus] = useState('');
  const [emailDrafts, setEmailDrafts] = useState<Array<{ id: string; subject: string; status: string; to: string[]; body: string; approvalActionId: string | null; threadId?: string | null }>>([]);
  const [emailTo, setEmailTo] = useState('recipient@example.com');
  const [emailSubjectHint, setEmailSubjectHint] = useState('Follow-up');
  const [emailPrompt, setEmailPrompt] = useState('Draft a professional follow-up about timelines and next steps.');
  const [emailTone, setEmailTone] = useState<'professional' | 'friendly' | 'concise'>('professional');
  const [emailStatus, setEmailStatus] = useState('');
  const [emailThreadQuery, setEmailThreadQuery] = useState('in:inbox newer_than:14d');
  const [emailThreadResults, setEmailThreadResults] = useState<Array<{ id: string; snippet: string }>>([]);
  const [calendarPreviewCards, setCalendarPreviewCards] = useState<CalendarPreviewCard[]>([]);
  const [emailPreviewCards, setEmailPreviewCards] = useState<EmailPreviewCard[]>([]);
  const [maoeCards, setMaoeCards] = useState<Array<{ id: string; type: string; title: string; data?: Record<string, unknown>; summary?: string }>>([]);
  const [maoeQuickActions, setMaoeQuickActions] = useState<Array<{ id: string; label: string; action: string }>>([]);
  const [todayData, setTodayData] = useState<{ events: CalendarEvent[]; conflicts: CalendarConflict[] } | null>(null);
  const [weekData, setWeekData] = useState<{ events: CalendarEvent[]; conflicts: CalendarConflict[] } | null>(null);
  const [todaySummary, setTodaySummary] = useState<CalendarSummary | null>(null);
  const [weekSummary, setWeekSummary] = useState<CalendarSummary | null>(null);
  const [calendarSideTab, setCalendarSideTab] = useState<'today_agenda' | 'today_overview' | 'week_overview'>('today_agenda');
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const suggestions = slashSuggestions(composer);
  const tokenEstimate = Math.max(1, Math.floor((messages.map((m) => m.content).join('\n').length + composer.length) / 4));
  const contextWindow = mode === 'quick' ? 8000 : 32000;
  const costEstimate = (tokenEstimate / 1000) * (mode === 'quick' ? 0.0015 : 0.0035);

  async function refreshOps() {
    try {
      const [a, logs, accts, drafts] = await Promise.all([listActions(), listAuditLogs(), listAccounts(), listEmailDrafts()]);
      setActions(a.items);
      setAudit(logs.items);
      setAccounts(accts.items.map((x) => ({ id: x.id, provider: x.provider, accountEmail: x.accountEmail, status: x.status })));
      setEmailDrafts(drafts.items.map((d) => ({ id: d.id, subject: d.subject, status: d.status, to: d.to, body: d.body, approvalActionId: d.approvalActionId, threadId: d.threadId })));
    } catch {
      // no-op for UI shell
    }
  }

  async function refreshOrchestration(selectedId?: string) {
    try {
      const runs = await listOrchestrationRuns(40);
      setOrchestrationRuns(runs.items);
      const runId = selectedId || selectedRunId || runs.items[0]?.id;
      if (!runId) {
        setSelectedRunId('');
        setSelectedRunDetails(null);
        return;
      }
      const details = await getOrchestrationRun(runId);
      setSelectedRunId(runId);
      setSelectedRunDetails(details.item);
      setOrchestrationStatus(`Loaded ${runs.items.length} MAOE run(s)`);
    } catch (err) {
      setOrchestrationStatus(`MAOE load error: ${String(err)}`);
    }
  }

  useEffect(() => {
    health()
      .then((h) => setStatus(`Sidecar online · ${h.service} · :${h.port}`))
      .catch(() => setStatus('Sidecar offline (start apps/sidecar)'));
    googleOAuthStatus()
      .then((s) => {
        setGoogleConfigured(s.configured);
        setGoogleRedirectUri(s.redirectUri);
      })
      .catch(() => {
        setGoogleConfigured(false);
      });
    void refreshOps();
    void refreshOrchestration();
  }, []);

  async function startGoogleConnect() {
    try {
      const s = await googleOAuthStart();
      setOauthUrl(s.authUrl);
      setOauthState(s.state);
      if (typeof window !== 'undefined') {
        window.open(s.authUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setMessages((prev) => [...prev, toChatMessage('assistant', `Google OAuth start error: ${String(err)}`)]);
    }
  }

  function openConnectModal(provider: 'google' | 'outlook') {
    setConnectProvider(provider);
    setShowConnectModal(true);
  }

  function onAttachClick() {
    fileInputRef.current?.click();
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setAttachedFiles((prev) => {
      const existing = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const next = [...prev];
      for (const file of files) {
        const key = `${file.name}:${file.size}`;
        if (existing.has(key)) continue;
        next.push({
          id: `${file.name}_${file.size}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
        });
      }
      return next.slice(0, 12);
    });
    e.currentTarget.value = '';
  }

  function removeAttachedFile(id: string) {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function extractApprovalActionIdFromCard(card: { data?: Record<string, unknown> }) {
    const data = card.data;
    if (!data) return null;
    const directId = typeof data.id === 'string' ? data.id : null;
    if (directId) return directId;
    const nested = data.item;
    if (nested && typeof nested === 'object' && nested !== null && 'id' in nested) {
      const idVal = (nested as { id?: unknown }).id;
      return typeof idVal === 'string' ? idVal : null;
    }
    return null;
  }

  function extractApprovalActionStatusFromCard(card: { data?: Record<string, unknown> }) {
    const data = card.data;
    if (!data) return null;
    const directStatus = typeof data.status === 'string' ? data.status : null;
    if (directStatus && ['prepared', 'approved', 'executed', 'failed', 'cancelled'].includes(directStatus)) return directStatus;
    const nested = data.item;
    if (nested && typeof nested === 'object' && nested !== null && 'status' in nested) {
      const statusVal = (nested as { status?: unknown }).status;
      if (typeof statusVal === 'string' && ['prepared', 'approved', 'executed', 'failed', 'cancelled'].includes(statusVal)) return statusVal;
    }
    return null;
  }

  function patchMaoeCardApprovalStatus(actionId: string, nextStatus: 'approved' | 'executed' | 'cancelled' | 'failed') {
    setMaoeCards((prev) =>
      prev.map((card) => {
        if (extractApprovalActionIdFromCard(card) !== actionId) return card;
        const data = card.data ? { ...card.data } : {};
        if (typeof data.id === 'string') {
          data.status = nextStatus;
        } else if (data.item && typeof data.item === 'object') {
          data.item = { ...(data.item as Record<string, unknown>), status: nextStatus };
        } else {
          data.status = nextStatus;
        }
        return { ...card, data };
      }),
    );
  }

  async function approveFromMaoeCard(actionId: string) {
    try {
      await transitionAction(actionId, 'approved');
      patchMaoeCardApprovalStatus(actionId, 'approved');
      setMessages((prev) => [...prev, toChatMessage('assistant', `✅ Approval granted for action ${actionId}`)]);
      await refreshOps();
      await refreshOrchestration();
    } catch (err) {
      setMessages((prev) => [...prev, toChatMessage('assistant', `Approval error: ${String(err)}`)]);
    }
  }

  async function reaffirmFromMaoeCard(actionId: string) {
    try {
      await reaffirmApprovalAction(actionId);
      patchMaoeCardApprovalStatus(actionId, 'approved');
      setMessages((prev) => [...prev, toChatMessage('assistant', `Approval refreshed for action ${actionId}`)]);
      await refreshOps();
      await refreshOrchestration();
    } catch (err) {
      setMessages((prev) => [...prev, toChatMessage('assistant', `Re-approve error: ${String(err)}`)]);
    }
  }

  async function cancelFromMaoeCard(actionId: string) {
    try {
      await transitionAction(actionId, 'cancelled');
      patchMaoeCardApprovalStatus(actionId, 'cancelled');
      setMessages((prev) => [...prev, toChatMessage('assistant', `Cancelled action ${actionId}`)]);
      await refreshOps();
      await refreshOrchestration();
    } catch (err) {
      setMessages((prev) => [...prev, toChatMessage('assistant', `Cancel error: ${String(err)}`)]);
    }
  }

  async function executeFromMaoeCard(actionId: string) {
    try {
      const res = await transitionAction(actionId, 'executed');
      patchMaoeCardApprovalStatus(actionId, 'executed');
      setMessages((prev) => [...prev, toChatMessage('assistant', `Executed action ${actionId}`)]);
      if (res.execution) {
        const exec = res.execution;
        let title = 'Execution Result';
        let payload: Record<string, unknown> = exec;
        if (exec && typeof exec === 'object' && 'draft' in exec) {
          title = 'Local Draft Materialized';
        }
        if (exec && typeof exec === 'object' && 'event' in exec) {
          title = 'Local Calendar Event Created';
        }
        setMaoeCards((prev) => [
          {
            id: `${Date.now()}_exec_${actionId}`,
            type: 'ExecutionResultCard',
            title,
            data: payload,
          },
          ...prev,
        ].slice(0, 20));
      }
      await refreshOps();
      await refreshOrchestration();
    } catch (err) {
      const message = String(err);
      if (message.includes('execution_policy_blocked:approval_stale_reapproval_required')) {
        setMessages((prev) => [
          ...prev,
          toChatMessage('assistant', `Execution blocked: approval is stale for ${actionId}. Re-approve the action, then execute again.`),
        ]);
      } else {
        setMessages((prev) => [...prev, toChatMessage('assistant', `Execute error: ${message}`)]);
      }
    }
  }

  function runMaoeQuickAction(action: { id: string; label: string; action: string }) {
    if (action.action === 'open_actions' || action.action === 'approve') {
      setWorkspaceView('actions');
      return;
    }
    if (action.action === 'view_calendar') {
      setWorkspaceView('calendar');
      return;
    }
    if (action.action === 'view_draft') {
      setWorkspaceView('drafts');
      return;
    }
    if (action.action === 'clarify') {
      setWorkspaceView('assistant');
      return;
    }
    if (action.action === 'retry') {
      setWorkspaceView('assistant');
      setStatus(`Quick action: ${action.label}`);
      return;
    }
    setStatus(`Quick action unsupported: ${action.label}`);
  }

  async function completeGoogleConnect() {
    if (!oauthState.trim() || !oauthCode.trim()) return;
    try {
      const res = await googleOAuthComplete({ state: oauthState.trim(), code: oauthCode.trim() });
      setMessages((prev) => [
        ...prev,
        toChatMessage('assistant', `Google account connected${res.item.accountEmail ? `: ${res.item.accountEmail}` : ''}`),
      ]);
      setOauthCode('');
      setOauthUrl('');
      setOauthState('');
      setShowConnectModal(false);
      await refreshOps();
    } catch (err) {
      setMessages((prev) => [...prev, toChatMessage('assistant', `Google OAuth complete error: ${String(err)}`)]);
    }
  }

  async function runGoogleCalendarSync(accountId?: string) {
    try {
      setCalendarSyncStatus('Syncing Google Calendar...');
      const res = await syncGoogleCalendar(accountId);
      const lines = res.items.map((i) => `${i.accountEmail || i.accountId}: ${i.calendarsSynced} calendars, ${i.eventsSynced} events`);
      setCalendarSyncStatus(`Sync complete · ${lines.join(' | ')}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `✅ Google Calendar sync complete\n${lines.join('\n')}`)]);
      await refreshOps();
    } catch (err) {
      setCalendarSyncStatus(`Sync failed: ${String(err)}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `Google Calendar sync error: ${String(err)}`)]);
    }
  }

  async function createEmailDraft() {
    try {
      setEmailStatus('Generating draft...');
      const to = emailTo.split(',').map((x) => x.trim()).filter(Boolean);
      const res = await generateEmailDraft({
        to,
        subjectHint: emailSubjectHint,
        prompt: emailPrompt,
        tone: emailTone,
      });
      setEmailStatus(`Draft created: ${res.draft.id} (approval required)`);
      setMessages((prev) => [
        ...prev,
        toChatMessage(
          'assistant',
          [
            '✉️ Draft Email Prepared',
            `To: ${res.draft.to.join(', ')}`,
            `Subject: ${res.draft.subject}`,
            `Approval Action: ${res.draft.approvalActionId || 'n/a'}`,
            '',
            res.draft.body,
          ].join('\n'),
        ),
      ]);
      setEmailPreviewCards((prev) => [
        {
          id: `draft_${res.draft.id}`,
          kind: 'draft',
          title: 'Draft Email Preview',
          recipients: res.draft.to,
          subject: res.draft.subject,
          bodyPreview: res.draft.body,
          status: res.draft.status,
          threadId: res.draft.threadId,
        },
        ...prev.filter((c) => c.id !== `draft_${res.draft.id}`).slice(0, 7),
      ]);
      await refreshOps();
    } catch (err) {
      setEmailStatus(`Draft failed: ${String(err)}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `Email draft error: ${String(err)}`)]);
    }
  }

  async function createReplyDraft(threadId: string) {
    try {
      setEmailStatus(`Preparing reply draft for ${threadId}...`);
      const res = await generateReplyDraftFromThread(threadId, { tone: emailTone });
      setEmailStatus(`Reply draft created: ${res.draft.id} (approval required)`);
      setEmailPreviewCards((prev) => [
        {
          id: `draft_${res.draft.id}`,
          kind: 'draft',
          title: 'Reply Draft Preview',
          recipients: res.draft.to,
          subject: res.draft.subject,
          bodyPreview: res.draft.body,
          status: res.draft.status,
          threadId: res.draft.threadId,
        },
        ...prev.filter((c) => c.id !== `draft_${res.draft.id}`).slice(0, 7),
      ]);
      setMessages((prev) => [
        ...prev,
        toChatMessage('assistant', `✉️ Reply draft prepared for thread ${threadId}\nSubject: ${res.draft.subject}\nTo: ${res.draft.to.join(', ')}`),
      ]);
      await refreshOps();
    } catch (err) {
      setEmailStatus(`Reply draft failed: ${String(err)}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `Reply draft error: ${String(err)}`)]);
    }
  }

  function insertDraftIntoComposer(input: { subject: string; body: string; to?: string[] }) {
    setComposer(
      [
        `Email Draft`,
        `Subject: ${input.subject}`,
        ...(input.to?.length ? [`To: ${input.to.join(', ')}`] : []),
        '',
        input.body,
      ].join('\n'),
    );
    setWorkspaceView('assistant');
    setEmailStatus('Draft inserted into composer');
  }

  async function approveAndSendDraft(draftId: string) {
    try {
      setEmailStatus(`Sending draft ${draftId}...`);
      const res = await approveSendEmailDraft(draftId);
      setEmailStatus(`Sent draft ${res.draftId}${res.gmailMessageId ? ` (${res.gmailMessageId})` : ''}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `✅ Email sent for draft ${res.draftId}`)]);
      await refreshOps();
    } catch (err) {
      setEmailStatus(`Send failed: ${String(err)}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `Email send error: ${String(err)}`)]);
      await refreshOps();
    }
  }

  async function runThreadSearch() {
    try {
      setEmailStatus('Searching Gmail threads...');
      const res = await searchGmailThreads({ q: emailThreadQuery, maxResults: 10 });
      setEmailThreadResults(res.items.map((i) => ({ id: i.id, snippet: i.snippet })));
      setEmailStatus(`Found ${res.items.length} thread(s)`);
    } catch (err) {
      setEmailStatus(`Thread search failed: ${String(err)}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `Gmail search error: ${String(err)}`)]);
    }
  }

  async function openThread(threadId: string) {
    try {
      setEmailStatus(`Loading thread ${threadId}...`);
      const res = await getGmailThread(threadId);
      const thread = res.item;
      const participants = Array.from(new Set(thread.messages.map((m) => m.from).filter(Boolean))).slice(0, 6);
      setEmailPreviewCards((prev) => [
        {
          id: `thread_${thread.id}`,
          kind: 'thread',
          title: 'Gmail Thread Preview',
          subject: thread.subject,
          threadId: thread.id,
          messageCount: thread.messages.length,
          participants,
          snippet: thread.messages.map((m) => `${m.from}: ${m.bodyPreview}`).join('\n\n').slice(0, 1800),
          latestFrom: thread.messages[thread.messages.length - 1]?.from,
        },
        ...prev.filter((c) => c.id !== `thread_${thread.id}`).slice(0, 7),
      ]);
      setMessages((prev) => [
        ...prev,
        toChatMessage(
          'assistant',
          [
            `📨 Thread: ${thread.subject}`,
            `Messages: ${thread.messages.length}`,
            ...thread.messages.slice(0, 5).map((m) => `- ${m.sentAt} | ${m.from} | ${m.snippet || m.bodyPreview.slice(0, 120)}`),
          ].join('\n'),
        ),
      ]);
      setWorkspaceView('assistant');
      setEmailStatus(`Loaded thread ${thread.id}`);
      await refreshOps();
    } catch (err) {
      setEmailStatus(`Open thread failed: ${String(err)}`);
      setMessages((prev) => [...prev, toChatMessage('assistant', `Gmail thread error: ${String(err)}`)]);
    }
  }

  async function refreshCalendarPanel(modeToLoad: 'today' | 'week') {
    try {
      if (modeToLoad === 'today') {
        const [day, summaryRes] = await Promise.all([calendarToday(), calendarSummary('today')]);
        setTodayData(day);
        setTodaySummary(summaryRes.summary);
      } else {
        const [week, summaryRes] = await Promise.all([calendarWeek(), calendarSummary('week')]);
        setWeekData(week);
        setWeekSummary(summaryRes.summary);
      }
      setWorkspaceView('calendar');
    } catch (err) {
      setMessages((prev) => [...prev, toChatMessage('assistant', `Calendar refresh error: ${String(err)}`)]);
    }
  }

  async function onSend() {
    const input = composer.trim();
    if (!input) return;

    const nextUser = toChatMessage('user', input);
    setMessages((prev) => [...prev, nextUser]);
    setComposer('');

    if (input.toLowerCase().includes('schedule') || input.startsWith('/schedule')) {
      const prepared = await prepareAction({
        actionType: 'calendar.draft_invite',
        targetType: 'calendar_event',
        payload: { prompt: input, durationMinutes: 30, source: 'in-app' },
      });
      const actionId = prepared.item.id;
      setMessages((prev) => [
        ...prev,
        toChatMessage(
          'assistant',
          [
            '📅 Scheduling with Google Calendar (placeholder)',
            'Duration: 30 mins',
            'Conflicts Found: 0',
            'Suggested Times: 2:00 PM, 3:30 PM',
            `Draft Action: ${actionId} (approval required)`,
          ].join('\n'),
        ),
      ]);
      void refreshOps();
      return;
    }

    if (input === '/today' || input.toLowerCase().includes("what's my day") || input.toLowerCase().includes('what is my day')) {
      try {
        const [day, summaryRes] = await Promise.all([calendarToday(), calendarSummary('today')]);
        const summary = summaryRes.summary;
        setTodayData(day);
        setTodaySummary(summary);
        setCalendarPreviewCards((prev) => [
          {
            id: `cal_today_${summary.date}`,
            kind: 'today',
            title: 'Calendar Today Preview',
            summary: summary.conciseSummary,
            metrics: {
              totalEvents: summary.totalEvents,
              hardConflicts: summary.hardConflicts,
              softConflicts: summary.softConflicts,
              backToBackChains: summary.backToBackChains,
            },
            focusBlocks: summary.focusBlockSuggestions,
            topEvents: day.events.slice(0, 6).map((e) => ({ startAt: e.startAt, title: e.title, calendarName: e.calendarName })),
          },
          ...prev.filter((c) => c.id !== `cal_today_${summary.date}`).slice(0, 5),
        ]);
        setMessages((prev) => [
          ...prev,
          toChatMessage(
            'assistant',
            [
              '📅 Unified Today View (Google Calendar MVP)',
              summary.conciseSummary,
              `Events: ${summary.totalEvents} | Hard conflicts: ${summary.hardConflicts} | Soft conflicts: ${summary.softConflicts}`,
              `Back-to-back handoffs: ${summary.backToBackChains}`,
              ...(summary.focusBlockSuggestions.length
                ? ['Focus blocks:', ...summary.focusBlockSuggestions.map((f) => `- ${f.startAt} → ${f.endAt} (${f.minutes}m)`)]
                : ['No 60m+ focus blocks found.']),
              ...(day.events.slice(0, 5).length ? ['Top events:', ...day.events.slice(0, 5).map((e) => `- ${e.startAt} ${e.title} (${e.calendarName ?? e.provider})`)] : []),
            ].join('\n'),
          ),
        ]);
        void refreshOps();
      } catch (err) {
        setMessages((prev) => [...prev, toChatMessage('assistant', `Calendar error: ${String(err)}`)]);
      }
      return;
    }

    if (input === '/week' || input.toLowerCase().includes('my week')) {
      try {
        const [week, summaryRes] = await Promise.all([calendarWeek(), calendarSummary('week')]);
        const summary = summaryRes.summary;
        setWeekData(week);
        setWeekSummary(summary);
        setCalendarPreviewCards((prev) => [
          {
            id: `cal_week_${summary.date}`,
            kind: 'week',
            title: 'Calendar Week Preview',
            summary: summary.conciseSummary,
            metrics: {
              totalEvents: summary.totalEvents,
              hardConflicts: summary.hardConflicts,
              softConflicts: summary.softConflicts,
            },
            conflicts: week.conflicts.slice(0, 6).map((c) => ({ type: c.type, explanation: c.explanation })),
            prepSuggestions: summary.prepSuggestions.slice(0, 6),
          },
          ...prev.filter((c) => c.id !== `cal_week_${summary.date}`).slice(0, 5),
        ]);
        setMessages((prev) => [
          ...prev,
          toChatMessage(
            'assistant',
            [
              '🗓️ Unified Week View (Google Calendar MVP)',
              summary.conciseSummary,
              `Events: ${summary.totalEvents} | Hard conflicts: ${summary.hardConflicts} | Soft conflicts: ${summary.softConflicts}`,
              ...(week.conflicts.length ? ['Conflicts:', ...week.conflicts.slice(0, 5).map((c) => `- ${c.type}: ${c.explanation}`)] : ['No conflicts found this week.']),
              ...(summary.prepSuggestions.length ? ['Prep suggestions:', ...summary.prepSuggestions.map((p) => `- ${p}`)] : []),
            ].join('\n'),
          ),
        ]);
        void refreshOps();
      } catch (err) {
        setMessages((prev) => [...prev, toChatMessage('assistant', `Calendar error: ${String(err)}`)]);
      }
      return;
    }

    startTransition(() => {
      chat({
        mode,
        model,
        messages: [...messages, nextUser].map((m) => ({ role: m.role, content: m.content })),
        tools,
        channel: 'in_app',
        attachments: attachedFiles.map((f) => ({ id: f.id, name: f.name, mimeType: f.type })),
      })
        .then((res) => {
          setMessages((prev) => [...prev, toChatMessage('assistant', res.message.content)]);
          const responseCards = res.cards ?? [];
          const responseQuickActions = res.quickActions ?? [];
          if (responseCards.length > 0) {
            setMaoeCards((prev) => [
              ...responseCards.map((c, idx) => ({ ...c, id: `${Date.now()}_${idx}_${c.type}` })),
              ...prev,
            ].slice(0, 20));
          }
          setMaoeQuickActions(responseQuickActions);
          if (res.orchestration?.runId) {
            void refreshOrchestration(res.orchestration.runId);
          } else {
            void refreshOrchestration();
          }
          void refreshOps();
        })
        .catch((err) => {
          setMessages((prev) => [...prev, toChatMessage('assistant', `Error: ${String(err)}`)]);
        });
    });

    // Clear attachments after submitting the prompt to keep composer state predictable.
    setAttachedFiles([]);
  }

  const weekEventsByDay = (weekData?.events || []).reduce<Record<string, CalendarEvent[]>>((acc, ev) => {
    const key = new Date(ev.startAt).toISOString().slice(0, 10);
    (acc[key] ||= []).push(ev);
    return acc;
  }, {});
  const weekDayKeys = Object.keys(weekEventsByDay).sort();
  const calendarAnchorDate = weekDayKeys[0] ? new Date(`${weekDayKeys[0]}T00:00:00`) : new Date();
  const calendarWeekStart = startOfWeek(calendarAnchorDate);
  const calendarWeekDays = Array.from({ length: 7 }, (_, i) => addDays(calendarWeekStart, i));
  const calendarHourStart = 7;
  const calendarHourEnd = 21;
  const calendarHourCount = calendarHourEnd - calendarHourStart;
  const hourRowHeight = 56;
  const calendarGridHeight = calendarHourCount * hourRowHeight;
  const hardConflictEventIds = new Set(
    (weekData?.conflicts || []).filter((c) => c.type === 'hard').flatMap((c) => c.eventIds),
  );
  const uniqueDraftsForDisplay = (() => {
    const seen = new Set<string>();
    return emailDrafts.filter((d) => {
      const key = `${d.subject}::${d.to.join(',')}::${d.body.trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

  function getEventLayout(ev: CalendarEvent) {
    const start = new Date(ev.startAt);
    const end = new Date(ev.endAt);
    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const endMinutes = end.getHours() * 60 + end.getMinutes();
    const minMinutes = calendarHourStart * 60;
    const maxMinutes = calendarHourEnd * 60;
    const clampedStart = Math.max(minMinutes, Math.min(startMinutes, maxMinutes - 15));
    const clampedEnd = Math.max(clampedStart + 15, Math.min(endMinutes, maxMinutes));
    const top = ((clampedStart - minMinutes) / 60) * hourRowHeight;
    const height = Math.max(20, ((clampedEnd - clampedStart) / 60) * hourRowHeight - 2);
    return { top, height };
  }

  const renderCalendarWorkspace = () => (
    <div className="calendar-workspace">
      <div className="calendar-workspace-head">
        <div>
          <div className="calendar-workspace-title">Unified Calendar</div>
          <div className="calendar-workspace-sub">
            Single calendar view across all connected accounts/calendars. Today it aggregates Google calendars; Outlook will join this same timeline next.
          </div>
        </div>
        <div className="calendar-workspace-actions">
          <button onClick={() => void refreshCalendarPanel('today')}>Refresh Today</button>
          <button onClick={() => void refreshCalendarPanel('week')}>Refresh Week</button>
        </div>
      </div>

      <div className="calendar-hybrid-grid">
        <div className="calendar-week-board pro-calendar-board">
          <div className="calendar-top-toolbar">
            <div className="calendar-toolbar-left">
              <button className="mini-icon-btn" onClick={() => void refreshCalendarPanel('week')}>↻</button>
              <button className="calendar-nav-btn">Today</button>
              <button className="mini-icon-btn">‹</button>
              <button className="mini-icon-btn">›</button>
              <div className="calendar-month-label">
                {calendarWeekDays[0].toLocaleDateString([], { month: 'long', year: 'numeric' })}
              </div>
            </div>
            <div className="calendar-toolbar-right">
              <span className="calendar-view-pill">Week</span>
            </div>
          </div>

          <div className="calendar-grid-shell">
            <div className="calendar-grid-head">
              <div className="time-header-cell" />
              {calendarWeekDays.map((day) => {
                const key = day.toISOString().slice(0, 10);
                const isToday = key === new Date().toISOString().slice(0, 10);
                return (
                  <div key={`head_${key}`} className={`day-header-cell ${isToday ? 'today' : ''}`}>
                    <div className="day-header-weekday">{day.toLocaleDateString([], { weekday: 'short' }).toUpperCase()}</div>
                    <div className="day-header-date">{day.getDate()}</div>
                  </div>
                );
              })}
            </div>

            <div className="calendar-grid-body" style={{ height: calendarGridHeight }}>
              <div className="time-column">
                {Array.from({ length: calendarHourCount }, (_, i) => {
                  const hour = calendarHourStart + i;
                  const label = new Date(2026, 0, 1, hour, 0).toLocaleTimeString([], { hour: 'numeric' });
                  return (
                    <div key={`t_${hour}`} className="time-slot-label" style={{ height: hourRowHeight }}>
                      {label}
                    </div>
                  );
                })}
              </div>

              <div className="days-grid-wrap">
                <div className="hour-lines">
                  {Array.from({ length: calendarHourCount + 1 }, (_, i) => (
                    <div key={`line_${i}`} className="hour-line" style={{ top: i * hourRowHeight }} />
                  ))}
                </div>
                <div className="day-columns">
                  {calendarWeekDays.map((day) => {
                    const dayKey = day.toISOString().slice(0, 10);
                    const dayEvents = (weekEventsByDay[dayKey] || [])
                      .slice()
                      .sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
                    return (
                      <div key={`col_${dayKey}`} className="day-column">
                        {dayEvents.map((e) => {
                          const layout = getEventLayout(e);
                          const conflict = hardConflictEventIds.has(e.id);
                          return (
                            <div
                              key={e.id}
                              className={`calendar-event-block ${e.status === 'tentative' ? 'tentative' : ''} ${conflict ? 'conflict' : ''}`}
                              style={{ top: layout.top, height: layout.height }}
                              title={`${e.title}\n${formatTimeRange(e.startAt, e.endAt)}`}
                            >
                              <div className="calendar-event-time">{formatTimeRange(e.startAt, e.endAt)}</div>
                              <div className="calendar-event-title">{e.title}</div>
                              <div className="calendar-event-meta">{e.calendarName || e.provider}</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="calendar-agenda-side">
          <div className="calendar-side-tabs">
            <button className={calendarSideTab === 'today_agenda' ? 'active' : ''} onClick={() => setCalendarSideTab('today_agenda')}>Today Agenda</button>
            <button className={calendarSideTab === 'today_overview' ? 'active' : ''} onClick={() => setCalendarSideTab('today_overview')}>Today Overview</button>
            <button className={calendarSideTab === 'week_overview' ? 'active' : ''} onClick={() => setCalendarSideTab('week_overview')}>Week Overview</button>
          </div>

          {calendarSideTab === 'today_agenda' && (
            <>
              <div className="calendar-panel-title">Today Agenda</div>
              <div className="agenda-list">
                {!todayData?.events?.length && <div className="agenda-empty">No today data loaded</div>}
                {(todayData?.events || []).slice(0, 12).map((e) => (
                  <div className="agenda-row" key={`panel_${e.id}`}>
                    <div className="agenda-time">{formatTimeRange(e.startAt, e.endAt)}</div>
                    <div className="agenda-dot" />
                    <div className="agenda-body">
                      <div className="agenda-title">{e.title}</div>
                      <div className="agenda-sub">{e.calendarName || e.provider}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {calendarSideTab === 'today_overview' && (
            <>
              <div className="calendar-panel-title">Today Overview</div>
              {todaySummary ? (
                <>
                  <div className="calendar-workspace-summary-text">{todaySummary.conciseSummary}</div>
                  <div className="calendar-inline-metrics">
                    <span className="calendar-badge neutral">Events {todaySummary.totalEvents}</span>
                    <span className={`calendar-badge ${todaySummary.hardConflicts ? 'danger' : 'neutral'}`}>Hard {todaySummary.hardConflicts}</span>
                    <span className={`calendar-badge ${todaySummary.softConflicts ? 'warn' : 'neutral'}`}>Soft {todaySummary.softConflicts}</span>
                    <span className={`calendar-badge ${todaySummary.backToBackChains ? 'accent' : 'neutral'}`}>Back-to-back {todaySummary.backToBackChains}</span>
                  </div>
                </>
              ) : (
                <div className="agenda-empty">Run `/today` or click Refresh Today</div>
              )}
            </>
          )}

          {calendarSideTab === 'week_overview' && (
            <>
              <div className="calendar-panel-title">Week Overview</div>
              {weekSummary ? (
                <>
                  <div className="calendar-workspace-summary-text">{weekSummary.conciseSummary}</div>
                  <div className="calendar-inline-metrics" style={{ marginBottom: 10 }}>
                    <span className="calendar-badge neutral">Events {weekSummary.totalEvents}</span>
                    <span className={`calendar-badge ${weekSummary.hardConflicts ? 'danger' : 'neutral'}`}>Hard {weekSummary.hardConflicts}</span>
                    <span className={`calendar-badge ${weekSummary.softConflicts ? 'warn' : 'neutral'}`}>Soft {weekSummary.softConflicts}</span>
                  </div>
                </>
              ) : (
                <div className="agenda-empty">Run `/week` or click Refresh Week</div>
              )}
              <div className="calendar-panel-title" style={{ marginTop: 12 }}>Conflicts</div>
              <div className="agenda-list">
                {!weekData?.conflicts?.length && <div className="agenda-empty">No conflict data loaded</div>}
                {(weekData?.conflicts || []).slice(0, 8).map((c, idx) => (
                  <div className="conflict-row" key={`panel_conflict_${idx}`}>
                    <span className={`calendar-badge ${c.type === 'hard' ? 'danger' : 'warn'}`}>{c.type}</span>
                    <div className="conflict-text">{c.explanation}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const renderOrchestrationWorkspace = () => (
    <div className="drafts-workspace">
      <div className="ops-card drafts-workbench-card">
        <div className="section-head">Multi-Agent Orchestration Trace</div>
        <div className="muted small">Reader → Thinker → Judge → Tool Executor → Responder (persisted in SQLite)</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button onClick={() => void refreshOrchestration()}>Refresh Runs</button>
          <button onClick={() => selectedRunId && void refreshOrchestration(selectedRunId)} disabled={!selectedRunId}>Reload Selected</button>
          {orchestrationStatus && <span className="muted small">{orchestrationStatus}</span>}
        </div>
      </div>

      <div className="orchestration-grid">
        <div className="ops-card">
          <div className="section-head" style={{ marginBottom: 8 }}>Runs</div>
          <div className="action-list" style={{ maxHeight: 520 }}>
            {orchestrationRuns.length === 0 && <div className="muted">No MAOE runs yet</div>}
            {orchestrationRuns.map((run) => (
              <button
                key={run.id}
                className={`orchestration-run-row ${selectedRunId === run.id ? 'active' : ''}`}
                onClick={() => void refreshOrchestration(run.id)}
              >
                <div className="orchestration-run-id">{run.id}</div>
                <div className="orchestration-run-meta">
                  <span>{run.mode}</span>
                  <span>{run.status}</span>
                  <span>{new Date(run.createdAt).toLocaleTimeString()}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="ops-card">
          <div className="section-head" style={{ marginBottom: 8 }}>Selected Run</div>
          {!selectedRunDetails && <div className="muted">Select a run to inspect</div>}
          {selectedRunDetails && (
            <div className="orchestration-detail-stack">
              <div className="orchestration-strip">
                <span className="calendar-badge neutral">{selectedRunDetails.run.mode}</span>
                <span className={`calendar-badge ${selectedRunDetails.run.status === 'failed' ? 'danger' : 'accent'}`}>{selectedRunDetails.run.status}</span>
                <span className="calendar-badge neutral">{selectedRunDetails.run.channel}</span>
                <span className="calendar-badge neutral">{selectedRunDetails.run.model}</span>
                {typeof thinkerPlannerSource === 'string' && <span className="calendar-badge neutral">planner {thinkerPlannerSource}</span>}
              </div>

              <div className="orchestration-section">
                <div className="calendar-panel-title">Trace Timeline</div>
                <div className="audit-list">
                  {selectedRunDetails.traces.map((t) => (
                    <div key={t.id} className="audit-row">
                      <div className="small mono">{new Date(t.createdAt).toLocaleTimeString()}</div>
                      <div>{t.agent}</div>
                      <div className="muted small">{t.status}</div>
                    </div>
                  ))}
                  {selectedRunDetails.traces.length === 0 && <div className="muted">No traces</div>}
                </div>
              </div>

              <div className="orchestration-section">
                <div className="calendar-panel-title">Decisions</div>
                <div className="action-list">
                  {selectedRunDetails.decisions.map((d) => (
                    <div key={d.id} className="action-row">
                      <div>
                        <div className="action-id">{d.stage}</div>
                        <div className="muted small">{d.status} · approval {d.requiresApproval ? 'yes' : 'no'}</div>
                        {d.requiredFields.length > 0 && <div className="muted small">Fields: {d.requiredFields.join(', ')}</div>}
                      </div>
                    </div>
                  ))}
                  {selectedRunDetails.decisions.length === 0 && <div className="muted">No decisions</div>}
                </div>
              </div>

              <div className="orchestration-section">
                <div className="calendar-panel-title">Tool Executions</div>
                <div className="action-list">
                  {selectedRunDetails.toolExecutions.map((t) => (
                    <div key={t.id} className="action-row">
                      <div>
                        <div className="action-id">{t.tool}</div>
                        <div className="muted small">{t.status} · {t.toolCallId}</div>
                        {t.errorDetails && <div className="muted small">Error: {t.errorDetails}</div>}
                      </div>
                    </div>
                  ))}
                  {selectedRunDetails.toolExecutions.length === 0 && <div className="muted">No tool executions</div>}
                </div>
              </div>

              <div className="orchestration-section">
                <div className="calendar-panel-title">Planner Snapshot</div>
                <pre className="orchestration-json">
                  {JSON.stringify(
                    {
                      context: selectedRunDetails.contextPacks[0]?.payload ?? null,
                      plan: selectedRunDetails.plans[0]?.payload ?? null,
                      decisions: selectedRunDetails.decisions.map((d) => ({ stage: d.stage, status: d.status, requiredFields: d.requiredFields })),
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const thinkerPlannerSource = selectedRunDetails?.traces.find((t) => t.agent === 'thinker')?.details?.plannerSource;

  return (
    <div className="workspace-root">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand">OC<span>W</span></div>
          <div className="workspace-pill"><span>Workspace</span><span className="pill-caret">▾</span></div>
          <button className="topbar-connect-btn" onClick={() => openConnectModal('google')}>Connect</button>
        </div>
        <div className="topbar-center">
          <div className="nav-tabs">
            <button className={`nav-tab ${workspaceView === 'assistant' ? 'active' : ''}`} onClick={() => setWorkspaceView('assistant')}>Assistant</button>
            <button className={`nav-tab ${workspaceView === 'calendar' ? 'active' : ''}`} onClick={() => setWorkspaceView('calendar')}>Calendar</button>
            <button className={`nav-tab ${workspaceView === 'drafts' ? 'active' : ''}`} onClick={() => setWorkspaceView('drafts')}>Drafts</button>
            <button className={`nav-tab ${workspaceView === 'tools' ? 'active' : ''}`} onClick={() => setWorkspaceView('tools')}>Tools</button>
            <button className={`nav-tab ${workspaceView === 'actions' ? 'active' : ''}`} onClick={() => setWorkspaceView('actions')}>Actions</button>
            <button className={`nav-tab ${workspaceView === 'audit' ? 'active' : ''}`} onClick={() => setWorkspaceView('audit')}>Audit</button>
            <button className={`nav-tab ${workspaceView === 'orchestration' ? 'active' : ''}`} onClick={() => setWorkspaceView('orchestration')}>MAOE</button>
          </div>
        </div>
        <div className="topbar-right">
          <div className="status-pill"><span className="status-dot" />{status}</div>
          <button className="profile-pill">P</button>
        </div>
      </header>

      <div className="workspace-shell">
        <aside className="sidebar">
          <button className="primary-btn">+ New Chat</button>
          <div className="sidebar-block">
            <div className="sidebar-title">Recents</div>
            <ul>
              <li>Budget Summary</li>
              <li>Client Sync Draft</li>
              <li>API Debug</li>
            </ul>
          </div>
          <div className="sidebar-block">
            <div className="sidebar-title">Pinned</div>
            <ul>
              <li>Product Strategy</li>
            </ul>
          </div>
          <div className="sidebar-nav">
            <button className={`sidebar-nav-item ${toolsDrawerOpen ? 'active' : ''}`} onClick={() => setToolsDrawerOpen((v) => !v)}>
              <span>🔌</span> Connectivity
            </button>
            <div className="sidebar-divider" />
            <button className={`sidebar-nav-item ${workspaceView === 'assistant' ? 'active' : ''}`} onClick={() => setWorkspaceView('assistant')}><span>💬</span> Assistant</button>
            <button className={`sidebar-nav-item ${workspaceView === 'calendar' ? 'active' : ''}`} onClick={() => setWorkspaceView('calendar')}><span>📅</span> Calendar</button>
            <button className={`sidebar-nav-item ${workspaceView === 'drafts' ? 'active' : ''}`} onClick={() => setWorkspaceView('drafts')}><span>📝</span> Drafts</button>
            <button className={`sidebar-nav-item ${workspaceView === 'tools' ? 'active' : ''}`} onClick={() => setWorkspaceView('tools')}><span>🧰</span> Tools</button>
            <button className={`sidebar-nav-item ${workspaceView === 'actions' ? 'active' : ''}`} onClick={() => setWorkspaceView('actions')}><span>🕒</span> Pending Actions</button>
            <button className={`sidebar-nav-item ${workspaceView === 'audit' ? 'active' : ''}`} onClick={() => setWorkspaceView('audit')}><span>📜</span> Audit Log</button>
            <button className={`sidebar-nav-item ${workspaceView === 'orchestration' ? 'active' : ''}`} onClick={() => setWorkspaceView('orchestration')}><span>🧠</span> MAOE Trace</button>
            <button className={`sidebar-nav-item ${workspaceView === 'settings' ? 'active' : ''}`} onClick={() => setWorkspaceView('settings')}><span>⚙️</span> Settings</button>
          </div>
        </aside>

        <main className="main-canvas">
          <section className="chat-canvas">
            <div className="canvas-head-row">
              <div className="section-head" style={{ marginBottom: 0 }}>
                {workspaceView === 'calendar'
                  ? 'Unified Calendar'
                  : workspaceView === 'drafts'
                    ? 'Drafts Workspace'
                    : workspaceView === 'tools'
                      ? 'Tools Workspace'
                    : workspaceView === 'actions'
                      ? 'Pending Actions'
                      : workspaceView === 'audit'
                        ? 'Audit Log'
                        : workspaceView === 'orchestration'
                          ? 'MAOE Trace'
                        : workspaceView === 'projects'
                        ? 'Projects Workspace'
                        : workspaceView === 'settings'
                          ? 'Settings'
                          : 'Conversation Thread'}
              </div>
              <div className="thread-actions">
                <button className="icon-btn" title="Export">↑</button>
                <button className="icon-btn" title="Clear" onClick={() => setMessages([])}>✕</button>
              </div>
            </div>
            <div className="message-list">
              {workspaceView === 'calendar' && renderCalendarWorkspace()}
              {workspaceView === 'drafts' && (
                <div className="drafts-workspace">
                  <div className="ops-card drafts-workbench-card">
                    <div className="section-head">Email Draft Center (Gmail MVP)</div>
                    <div className="muted small">Draft-first workflow. Sending requires explicit approval.</div>
                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="To (comma-separated)" />
                      <input value={emailSubjectHint} onChange={(e) => setEmailSubjectHint(e.target.value)} placeholder="Subject hint" />
                      <select value={emailTone} onChange={(e) => setEmailTone(e.target.value as 'professional' | 'friendly' | 'concise')}>
                        <option value="professional">professional</option>
                        <option value="friendly">friendly</option>
                        <option value="concise">concise</option>
                      </select>
                      <textarea value={emailPrompt} onChange={(e) => setEmailPrompt(e.target.value)} rows={3} placeholder="Draft prompt" />
                      <button onClick={() => void createEmailDraft()}>Generate Draft</button>
                    </div>
                    {emailStatus && <div className="muted small" style={{ marginTop: 6 }}>{emailStatus}</div>}
                    <div style={{ display: 'grid', gap: 6, marginTop: 8, borderTop: '1px solid #2a2f3a', paddingTop: 8 }}>
                      <div className="muted small">Gmail Thread Search / Read</div>
                      <input value={emailThreadQuery} onChange={(e) => setEmailThreadQuery(e.target.value)} placeholder="Gmail search query (e.g., from:alice newer_than:7d)" />
                      <button onClick={() => void runThreadSearch()}>Search Threads</button>
                      <div className="action-list" style={{ maxHeight: 150 }}>
                        {emailThreadResults.length === 0 && <div className="muted">No thread search results</div>}
                        {emailThreadResults.map((t) => (
                          <div className="action-row" key={t.id}>
                            <div style={{ minWidth: 0 }}>
                              <div className="action-id">{t.id}</div>
                              <div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 380 }}>{t.snippet}</div>
                            </div>
                            <div className="action-buttons">
                              <button onClick={() => void openThread(t.id)}>Open</button>
                              <button onClick={() => void createReplyDraft(t.id)}>Reply Draft</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="drafts-grid">
                    {uniqueDraftsForDisplay.length === 0 && <div className="agenda-empty">No drafts yet. Use Email Draft Center or thread reply actions.</div>}
                    {uniqueDraftsForDisplay.map((d) => (
                      <div className="email-card email-card-draft" key={`draftws_${d.id}`}>
                        <div className="email-card-head">
                          <div>
                            <div className="email-card-title">{d.subject}</div>
                            <div className="email-card-sub">To {d.to.join(', ') || '(none)'}{d.threadId ? ' · Reply draft' : ''}</div>
                          </div>
                          <span className={`email-status-pill ${d.status}`}>{d.status}</span>
                        </div>
                        <pre className="email-card-pre">{d.body}</pre>
                        <div className="email-card-actions">
                          <button onClick={() => insertDraftIntoComposer({ subject: d.subject, body: d.body, to: d.to })}>Insert</button>
                          {d.status === 'prepared' && <button onClick={() => void approveAndSendDraft(d.id)}>Approve & Send</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {workspaceView === 'tools' && (
                <div className="drafts-workspace">
                  <div className="ops-card drafts-workbench-card">
                    <div className="section-head">Tool Output Cards</div>
                    <InlineCard title="Scheduling Example">
                      <div>Type: <code>/schedule 30 mins tomorrow afternoon</code></div>
                      <div>Result renders as a structured card with approval action.</div>
                    </InlineCard>
                    <InlineCard title="Approval & Audit Backbone" tone="success">
                      <div>Shared state machine across in-app and future Telegram flows.</div>
                      <div><code>prepared → approved → executed | failed | cancelled</code></div>
                    </InlineCard>
                  </div>
                </div>
              )}
              {workspaceView === 'actions' && (
                <div className="drafts-workspace">
                  <div className="ops-card drafts-workbench-card">
                    <div className="section-head">Pending / Recent Actions</div>
                    <div className="action-list">
                      {actions.length === 0 && <div className="muted">No actions yet</div>}
                      {actions.map((a) => (
                        <div className="action-row" key={a.id}>
                          <div>
                            <div className="action-id">{a.id}</div>
                            <div className="muted small">{a.actionType} · {a.status}</div>
                          </div>
                          <div className="action-buttons">
                            {a.status === 'prepared' && (
                              <>
                                <button onClick={() => transitionAction(a.id, 'approved').then(refreshOps)}>Approve</button>
                                <button onClick={() => transitionAction(a.id, 'cancelled').then(refreshOps)}>Cancel</button>
                              </>
                            )}
                            {a.status === 'approved' && (
                              <button onClick={() => transitionAction(a.id, 'executed').then(refreshOps)}>Execute</button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {workspaceView === 'audit' && (
                <div className="drafts-workspace">
                  <div className="ops-card drafts-workbench-card">
                    <div className="section-head">Audit Log</div>
                    <div className="audit-list">
                      {audit.slice(0, 50).map((entry) => (
                        <div key={entry.id} className="audit-row">
                          <div className="small mono">{entry.timestamp}</div>
                          <div>{entry.actionType}</div>
                          <div className="muted small">{entry.status}</div>
                        </div>
                      ))}
                      {audit.length === 0 && <div className="muted">No audit entries</div>}
                    </div>
                  </div>
                </div>
              )}
              {workspaceView === 'orchestration' && renderOrchestrationWorkspace()}
              {workspaceView === 'projects' && <div className="empty-state">Project generator workspace is next (Phase 2). Use chat with `/projects` for now.</div>}
              {workspaceView === 'settings' && <div className="empty-state">Settings workspace will centralize model defaults, tools, and permissions.</div>}
              {workspaceView === 'assistant' && (
                <>
              {maoeCards.length > 0 && (
                <div className="email-preview-stack">
                  {maoeCards.map((card) => {
                    const approvalId = extractApprovalActionIdFromCard(card);
                    const approvalStatus = extractApprovalActionStatusFromCard(card);
                    return (
                      <div key={card.id} className="email-card email-card-thread">
                        <div className="email-card-head">
                          <div>
                            <div className="email-card-title">{card.title}</div>
                            <div className="email-card-sub">
                              {card.type}
                              {approvalStatus ? ` · ${approvalStatus}` : ''}
                            </div>
                          </div>
                          {approvalId && (
                            <div className="action-buttons">
                              {approvalStatus === 'prepared' && (
                                <>
                                  <button onClick={() => void approveFromMaoeCard(approvalId)}>Approve</button>
                                  <button onClick={() => void cancelFromMaoeCard(approvalId)}>Cancel</button>
                                </>
                              )}
                              {approvalStatus === 'approved' && (
                                <>
                                  <button onClick={() => void reaffirmFromMaoeCard(approvalId)}>Re-approve</button>
                                  <button onClick={() => void executeFromMaoeCard(approvalId)}>Execute</button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        {card.summary && <div className="muted small" style={{ marginBottom: 8 }}>{card.summary}</div>}
                        <pre className="email-card-pre">{JSON.stringify(card.data ?? {}, null, 2)}</pre>
                      </div>
                    );
                  })}
                </div>
              )}
              {maoeQuickActions.length > 0 && (
                <div className="ops-card" style={{ marginBottom: 12 }}>
                  <div className="section-head" style={{ marginBottom: 8 }}>Quick Actions</div>
                  <div className="action-buttons" style={{ flexWrap: 'wrap' }}>
                    {maoeQuickActions.map((qa) => (
                      <button key={qa.id} onClick={() => runMaoeQuickAction(qa)}>
                        {qa.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {calendarPreviewCards.length > 0 && (
                <div className="calendar-preview-stack">
                  {calendarPreviewCards.map((card) => (
                    <div key={card.id} className="calendar-card">
                      <div className="calendar-card-head">
                        <div>
                          <div className="calendar-card-title">{card.title}</div>
                          <div className="calendar-card-summary">{card.summary}</div>
                        </div>
                        <div className="calendar-card-badges">
                          <span className="calendar-badge neutral">Events {card.metrics.totalEvents}</span>
                          <span className={`calendar-badge ${card.metrics.hardConflicts > 0 ? 'danger' : 'neutral'}`}>Hard {card.metrics.hardConflicts}</span>
                          <span className={`calendar-badge ${card.metrics.softConflicts > 0 ? 'warn' : 'neutral'}`}>Soft {card.metrics.softConflicts}</span>
                          {'backToBackChains' in card.metrics && (
                            <span className={`calendar-badge ${card.metrics.backToBackChains > 0 ? 'accent' : 'neutral'}`}>Back-to-back {card.metrics.backToBackChains}</span>
                          )}
                        </div>
                      </div>

                      {card.kind === 'today' && (
                        <div className="calendar-card-grid">
                          <div className="calendar-panel">
                            <div className="calendar-panel-title">Agenda</div>
                            <div className="agenda-list">
                              {card.topEvents.length === 0 && <div className="agenda-empty">No events</div>}
                              {card.topEvents.map((e, idx) => (
                                <div className="agenda-row" key={`${card.id}_${idx}`}>
                                  <div className="agenda-time">{formatDateTimeLabel(e.startAt)}</div>
                                  <div className="agenda-dot" />
                                  <div className="agenda-body">
                                    <div className="agenda-title">{e.title}</div>
                                    <div className="agenda-sub">{e.calendarName || 'Unified Calendar'}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="calendar-panel">
                            <div className="calendar-panel-title">Focus Blocks</div>
                            <div className="focus-list">
                              {card.focusBlocks.length === 0 && <div className="agenda-empty">No 60m+ focus blocks</div>}
                              {card.focusBlocks.map((f, idx) => (
                                <div className="focus-row" key={`${card.id}_f_${idx}`}>
                                  <div className="focus-range">{formatTimeRange(f.startAt, f.endAt)}</div>
                                  <div className="focus-minutes">{f.minutes}m</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {card.kind === 'week' && (
                        <div className="calendar-card-grid">
                          <div className="calendar-panel">
                            <div className="calendar-panel-title">Conflicts</div>
                            <div className="agenda-list">
                              {card.conflicts.length === 0 && <div className="agenda-empty">No conflicts found</div>}
                              {card.conflicts.map((c, idx) => (
                                <div className="conflict-row" key={`${card.id}_c_${idx}`}>
                                  <span className={`calendar-badge ${c.type === 'hard' ? 'danger' : 'warn'}`}>{c.type}</span>
                                  <div className="conflict-text">{c.explanation}</div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="calendar-panel">
                            <div className="calendar-panel-title">Prep Suggestions</div>
                            <div className="prep-list">
                              {card.prepSuggestions.length === 0 && <div className="agenda-empty">No prep suggestions</div>}
                              {card.prepSuggestions.map((p, idx) => (
                                <div className="prep-row" key={`${card.id}_p_${idx}`}>
                                  <span className="prep-icon">•</span>
                                  <div className="prep-text">{p}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {emailPreviewCards.length > 0 && (
                <div className="email-preview-stack">
                  {emailPreviewCards.map((card) => (
                    <div key={card.id} className={`email-card ${card.kind === 'draft' ? 'email-card-draft' : 'email-card-thread'}`}>
                      <div className="email-card-head">
                        <div>
                          <div className="email-card-title">{card.title}</div>
                          <div className="email-card-sub">{card.kind === 'draft' ? 'Draft preview (approval required)' : `Gmail thread · ${card.messageCount} messages`}</div>
                        </div>
                        {card.kind === 'draft' ? (
                          <span className={`email-status-pill ${card.status}`}>{card.status}</span>
                        ) : (
                          <button onClick={() => void createReplyDraft(card.threadId)}>Draft Reply</button>
                        )}
                      </div>
                      {card.kind === 'draft' ? (
                        <div className="email-card-body">
                          <div className="email-meta-row"><strong>To</strong><span>{card.recipients.join(', ')}</span></div>
                          <div className="email-meta-row"><strong>Subject</strong><span>{card.subject}</span></div>
                          {card.threadId && <div className="email-meta-row"><strong>Thread</strong><span className="mono small">{card.threadId}</span></div>}
                          <pre className="email-card-pre">{card.bodyPreview}</pre>
                          <div className="email-card-actions">
                            <button onClick={() => insertDraftIntoComposer({ subject: card.subject, body: card.bodyPreview, to: card.recipients })}>Insert</button>
                          </div>
                        </div>
                      ) : (
                        <div className="email-card-body">
                          <div className="email-meta-row"><strong>Subject</strong><span>{card.subject}</span></div>
                          <div className="email-meta-row"><strong>Thread</strong><span className="mono small">{card.threadId}</span></div>
                          <div className="email-meta-row"><strong>Participants</strong><span>{card.participants.join(' | ') || 'n/a'}</span></div>
                          <pre className="email-card-pre">{card.snippet}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {messages.length === 0 && <div className="empty-state">Start with “What’s my day?” or “Draft follow-up email”.</div>}
              {messages.map((m) => (
                <div key={m.id} className={`message-bubble ${m.role}`}>
                  <div className="message-role">{m.role}</div>
                  <pre>{m.content}</pre>
                </div>
              ))}
              {isPending && <div className="assistant-thinking">Assistant is thinking...</div>}
                </>
              )}
            </div>
          </section>

          <section className="composer-panel">
            <div className="composer-box embedded">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={onFileInputChange}
              />
              {suggestions.length > 0 && (
                <div className="slash-suggest composer-inline-suggest">
                  {suggestions.map((s) => (
                    <button key={s} className="ghost-chip" onClick={() => setComposer(`${s} `)}>{s}</button>
                  ))}
                </div>
              )}
              {attachedFiles.length > 0 && (
                <div className="composer-attachments">
                  {attachedFiles.map((file) => (
                    <button key={file.id} className="attachment-chip" onClick={() => removeAttachedFile(file.id)} title="Remove attachment">
                      <span className="attachment-name">{file.name}</span>
                      <span className="attachment-x">✕</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                className="composer-input"
                placeholder="+ Write a message… (try /schedule, /summarize, /projects)"
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void onSend();
                  }
                }}
              />
              <div className="composer-toolbar composer-toolbar-embedded">
                <div className="composer-toolbar-left-cluster">
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="llama3:8b">llama3:8b (Fast)</option>
                    <option value="llama3:70b">llama3:70b (Deep)</option>
                    <option value="mixtral">mixtral (Reasoning)</option>
                  </select>
                  <button className="ghost-btn" onClick={onAttachClick}>📎 Attach</button>
                  <div className="tool-toggle-group">
                    {TOOL_OPTIONS.map((tool) => (
                      <label key={tool}>
                        <input
                          type="checkbox"
                          checked={tools.includes(tool)}
                          onChange={(e) => {
                            setTools((prev) => (e.target.checked ? [...prev, tool] : prev.filter((t) => t !== tool)));
                          }}
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="composer-toolbar-right-cluster">
                  <div className="segmented">
                    <button className={mode === 'quick' ? 'active' : ''} onClick={() => setMode('quick')}>Quick</button>
                    <button className={mode === 'deep' ? 'active' : ''} onClick={() => setMode('deep')}>Deep</button>
                  </div>
                  <span className="approval-indicator">Approval required for external actions</span>
                  <button className="send-btn" onClick={() => void onSend()}>Send</button>
                </div>
              </div>
              <div className="composer-meta-inline mono">
                <span>{tools.length > 0 ? `Tools: ${tools.join(', ')}` : 'No tools enabled'}</span>
                <span>Context: {tokenEstimate.toLocaleString()} / {contextWindow.toLocaleString()} · Cost: ${costEstimate.toFixed(4)}</span>
              </div>
            </div>
          </section>
        </main>

        <aside className={`ops-panel tools-drawer ${toolsDrawerOpen ? 'open' : ''}`}>
          <div className="drawer-header">
            <div className="drawer-title">Connectivity</div>
            <button className="drawer-close" onClick={() => setToolsDrawerOpen(false)}>✕</button>
          </div>
          <div className="drawer-scroll">
          <div className="ops-card">
            <div className="section-head">Connections</div>
            <div className="connection-icon-row" style={{ marginTop: 8 }}>
              <button
                className={`connection-icon-btn ${accounts.some((a) => a.provider === 'google') ? 'connected' : ''}`}
                onClick={() => openConnectModal('google')}
                title="Connect Gmail / Google Calendar"
              >
                <span className="provider-avatar google">G</span>
                {accounts.some((a) => a.provider === 'google') && <span className="connection-icon-badge">✓</span>}
              </button>
              <button
                className="connection-icon-btn"
                disabled
                title="Outlook (coming soon)"
              >
                <span className="provider-avatar outlook">O</span>
              </button>
            </div>
          </div>

          </div>
        </aside>
      </div>

      <div className={`drawer-overlay ${toolsDrawerOpen ? 'show' : ''}`} onClick={() => setToolsDrawerOpen(false)} />

      {showConnectModal && (
        <div className="modal-backdrop" onClick={() => setShowConnectModal(false)}>
          <div className="connect-modal" onClick={(e) => e.stopPropagation()}>
            <div className="connect-modal-head">
              <div>
                <div className="connect-modal-title">Connect Account</div>
                <div className="connect-modal-sub">Add email/calendar providers to the unified workspace.</div>
              </div>
              <button className="mini-icon-btn" onClick={() => setShowConnectModal(false)}>✕</button>
            </div>

            <div className="connect-provider-grid">
              <button
                className={`provider-connect-btn ${connectProvider === 'google' ? 'selected' : ''} ${accounts.some((a) => a.provider === 'google') ? 'connected' : ''}`}
                onClick={() => setConnectProvider('google')}
              >
                <span className="provider-avatar google">G</span>
                <span className="provider-connect-body">
                  <span className="provider-connect-title">Google (Gmail + Calendar)</span>
                  <span className="provider-connect-sub">{googleConfigured ? 'Connect once, use both apps' : 'Requires Google OAuth config'}</span>
                </span>
              </button>
              <button className={`provider-connect-btn muted ${connectProvider === 'outlook' ? 'selected' : ''}`} onClick={() => setConnectProvider('outlook')} disabled>
                <span className="provider-avatar outlook">O</span>
                <span className="provider-connect-body">
                  <span className="provider-connect-title">Microsoft Outlook</span>
                  <span className="provider-connect-sub">Coming soon</span>
                </span>
              </button>
            </div>

            {connectProvider === 'google' && (
              <div className="connect-modal-panel">
                <div className="connect-flow-row">
                  <div>
                    <div className="connect-flow-title">Google OAuth</div>
                    <div className="connect-flow-sub">Starts browser consent and returns a code to paste here.</div>
                  </div>
                  <button onClick={() => void startGoogleConnect()} disabled={!googleConfigured}>Start Google Connect</button>
                </div>
                <div className="small mono connect-redirect-line">Redirect: {googleRedirectUri || 'n/a'}</div>
                {!googleConfigured && <div className="connect-inline-warning">Set Google OAuth env vars in `desktop/.env` to enable connect.</div>}
                {oauthUrl && (
                  <div className="connect-consent-link">
                    <a href={oauthUrl} target="_blank" rel="noreferrer">Open Google Consent URL</a>
                  </div>
                )}
                <div className="connect-form-grid">
                  <input placeholder="OAuth state" value={oauthState} onChange={(e) => setOauthState(e.target.value)} />
                  <textarea placeholder="Paste authorization code" value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} rows={4} />
                  <div className="connect-modal-actions">
                    <button onClick={() => void completeGoogleConnect()} disabled={!oauthState || !oauthCode}>Complete Connect</button>
                    <button onClick={() => { setOauthUrl(''); setOauthState(''); setOauthCode(''); }}>Clear</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
