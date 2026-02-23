import { useEffect, useState, useTransition } from 'react';

import { InlineCard } from './components/InlineCard';
import {
  calendarSummary,
  calendarToday,
  calendarWeek,
  chat,
  disconnectAccount,
  generateEmailDraft,
  generateReplyDraftFromThread,
  getGmailThread,
  googleOAuthComplete,
  googleOAuthStart,
  googleOAuthStatus,
  health,
  listEmailDrafts,
  listActions,
  listAccounts,
  listAuditLogs,
  prepareAction,
  searchGmailThreads,
  syncGoogleCalendar,
  toChatMessage,
  transitionAction,
  approveSendEmailDraft,
} from './lib/api';
import type { ApprovalAction, AuditEntry, ChatMessage } from './types';
import type { CalendarConflict, CalendarEvent, CalendarSummary } from './lib/api';

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
  const [workspaceView, setWorkspaceView] = useState<'assistant' | 'calendar' | 'drafts' | 'projects' | 'settings'>('assistant');
  const [composer, setComposer] = useState('');
  const [model, setModel] = useState('llama3:8b');
  const [mode, setMode] = useState<'quick' | 'deep'>('quick');
  const [tools, setTools] = useState<string[]>([]);
  const [status, setStatus] = useState('Checking sidecar...');
  const [actions, setActions] = useState<ApprovalAction[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [accounts, setAccounts] = useState<Array<{ id: string; provider: string; accountEmail: string | null; status: string }>>([]);
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null);
  const [googleRedirectUri, setGoogleRedirectUri] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthState, setOauthState] = useState('');
  const [oauthCode, setOauthCode] = useState('');
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
  const [todayData, setTodayData] = useState<{ events: CalendarEvent[]; conflicts: CalendarConflict[] } | null>(null);
  const [weekData, setWeekData] = useState<{ events: CalendarEvent[]; conflicts: CalendarConflict[] } | null>(null);
  const [todaySummary, setTodaySummary] = useState<CalendarSummary | null>(null);
  const [weekSummary, setWeekSummary] = useState<CalendarSummary | null>(null);
  const [isPending, startTransition] = useTransition();

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
      })
        .then((res) => {
          setMessages((prev) => [...prev, toChatMessage('assistant', res.message.content)]);
          void refreshOps();
        })
        .catch((err) => {
          setMessages((prev) => [...prev, toChatMessage('assistant', `Error: ${String(err)}`)]);
        });
    });
  }

  const weekEventsByDay = (weekData?.events || []).reduce<Record<string, CalendarEvent[]>>((acc, ev) => {
    const key = new Date(ev.startAt).toISOString().slice(0, 10);
    (acc[key] ||= []).push(ev);
    return acc;
  }, {});
  const weekDayKeys = Object.keys(weekEventsByDay).sort();

  const renderCalendarWorkspace = () => (
    <div className="calendar-workspace">
      <div className="calendar-workspace-head">
        <div>
          <div className="calendar-workspace-title">Unified Calendar</div>
          <div className="calendar-workspace-sub">
            Google Calendar MVP unified view (multi-calendar). Outlook support slots into the same timeline later.
          </div>
        </div>
        <div className="calendar-workspace-actions">
          <button onClick={() => void refreshCalendarPanel('today')}>Refresh Today</button>
          <button onClick={() => void refreshCalendarPanel('week')}>Refresh Week</button>
        </div>
      </div>

      <div className="calendar-workspace-summary-grid">
        <div className="calendar-summary-panel">
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
        </div>

        <div className="calendar-summary-panel">
          <div className="calendar-panel-title">Week Overview</div>
          {weekSummary ? (
            <>
              <div className="calendar-workspace-summary-text">{weekSummary.conciseSummary}</div>
              <div className="calendar-inline-metrics">
                <span className="calendar-badge neutral">Events {weekSummary.totalEvents}</span>
                <span className={`calendar-badge ${weekSummary.hardConflicts ? 'danger' : 'neutral'}`}>Hard {weekSummary.hardConflicts}</span>
                <span className={`calendar-badge ${weekSummary.softConflicts ? 'warn' : 'neutral'}`}>Soft {weekSummary.softConflicts}</span>
              </div>
            </>
          ) : (
            <div className="agenda-empty">Run `/week` or click Refresh Week</div>
          )}
        </div>
      </div>

      <div className="calendar-hybrid-grid">
        <div className="calendar-week-board">
          <div className="calendar-panel-title">Week Grid (Agenda Hybrid)</div>
          {weekDayKeys.length === 0 && <div className="agenda-empty">No week data loaded</div>}
          {weekDayKeys.map((dayKey) => (
            <div key={dayKey} className="week-day-column">
              <div className="week-day-header">
                {new Date(`${dayKey}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
              <div className="week-day-events">
                {(weekEventsByDay[dayKey] || [])
                  .slice()
                  .sort((a, b) => (a.startAt < b.startAt ? -1 : 1))
                  .map((e) => (
                    <div key={e.id} className={`week-event-chip ${e.status === 'tentative' ? 'tentative' : ''}`}>
                      <div className="week-event-time">{formatTimeRange(e.startAt, e.endAt)}</div>
                      <div className="week-event-title">{e.title}</div>
                      <div className="week-event-sub">{e.calendarName || e.provider}</div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>

        <div className="calendar-agenda-side">
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
        </div>
      </div>
    </div>
  );

  return (
    <div className="workspace-root">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand">OCW</div>
          <div className="workspace-pill">Workspace ▾</div>
        </div>
        <div className="topbar-right">
          <div className="status-pill">{status}</div>
          <div className="profile-pill">Profile</div>
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
          <div className="sidebar-block compact-links">
            <button className={workspaceView === 'assistant' ? 'nav-link active' : 'nav-link'} onClick={() => setWorkspaceView('assistant')}>Assistant</button>
            <button className={workspaceView === 'calendar' ? 'nav-link active' : 'nav-link'} onClick={() => setWorkspaceView('calendar')}>Calendar</button>
            <button className={workspaceView === 'drafts' ? 'nav-link active' : 'nav-link'} onClick={() => setWorkspaceView('drafts')}>Drafts</button>
            <button className={workspaceView === 'projects' ? 'nav-link active' : 'nav-link'} onClick={() => setWorkspaceView('projects')}>Projects</button>
            <button className={workspaceView === 'settings' ? 'nav-link active' : 'nav-link'} onClick={() => setWorkspaceView('settings')}>Settings</button>
          </div>
        </aside>

        <main className="main-canvas">
          <section className="chat-canvas">
            <div className="canvas-head-row">
              <div className="section-head" style={{ marginBottom: 0 }}>
                {workspaceView === 'calendar' ? 'Unified Calendar' : workspaceView === 'drafts' ? 'Drafts Workspace' : workspaceView === 'projects' ? 'Projects Workspace' : workspaceView === 'settings' ? 'Settings' : 'Conversation Thread'}
              </div>
              <div className="canvas-tabs">
                <button className={workspaceView === 'assistant' ? 'active' : ''} onClick={() => setWorkspaceView('assistant')}>Assistant</button>
                <button className={workspaceView === 'calendar' ? 'active' : ''} onClick={() => setWorkspaceView('calendar')}>Calendar</button>
                <button className={workspaceView === 'drafts' ? 'active' : ''} onClick={() => setWorkspaceView('drafts')}>Drafts</button>
              </div>
            </div>
            <div className="message-list">
              {workspaceView === 'calendar' && renderCalendarWorkspace()}
              {workspaceView === 'drafts' && (
                <div className="drafts-workspace">
                  <div className="drafts-grid">
                    {emailDrafts.length === 0 && <div className="agenda-empty">No drafts yet. Use Email Draft Center or thread reply actions.</div>}
                    {emailDrafts.map((d) => (
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
                          {d.status === 'prepared' && <button onClick={() => void approveAndSendDraft(d.id)}>Approve & Send</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {workspaceView === 'projects' && <div className="empty-state">Project generator workspace is next (Phase 2). Use chat with `/projects` for now.</div>}
              {workspaceView === 'settings' && <div className="empty-state">Settings workspace will centralize model defaults, tools, and permissions.</div>}
              {workspaceView === 'assistant' && (
                <>
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
            <div className="enabled-tools-row">
              {tools.length > 0 ? tools.map((tool) => <span key={tool} className="tool-chip">{tool} ✓</span>) : <span className="muted">No tools enabled</span>}
            </div>
            {suggestions.length > 0 && (
              <div className="slash-suggest">
                {suggestions.map((s) => (
                  <button key={s} className="ghost-chip" onClick={() => setComposer(`${s} `)}>{s}</button>
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
            <div className="composer-toolbar">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="llama3:8b">llama3:8b (Fast)</option>
                <option value="llama3:70b">llama3:70b (Deep)</option>
                <option value="mixtral">mixtral (Reasoning)</option>
              </select>
              <button className="ghost-btn">📎 Attach</button>
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
              <div className="segmented">
                <button className={mode === 'quick' ? 'active' : ''} onClick={() => setMode('quick')}>Quick</button>
                <button className={mode === 'deep' ? 'active' : ''} onClick={() => setMode('deep')}>Deep</button>
              </div>
              <span className="approval-indicator">Approval required for external actions</span>
              <button className="send-btn" onClick={() => void onSend()}>Send</button>
            </div>
            <div className="advanced-bar mono">
              <div>Context Used: {tokenEstimate.toLocaleString()} / {contextWindow.toLocaleString()} tokens</div>
              <div>Estimated Cost: ${costEstimate.toFixed(4)}</div>
            </div>
          </section>
        </main>

        <aside className="ops-panel">
          <div className="ops-card">
            <div className="section-head">Google Connect (MVP)</div>
            <div className="muted small">
              {googleConfigured === null
                ? 'Checking Google OAuth config...'
                : googleConfigured
                  ? 'Google OAuth configured'
                  : 'Set GOOGLE_CLIENT_ID in sidecar env to enable connect'}
            </div>
            <div className="small mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>Redirect: {googleRedirectUri || 'n/a'}</div>
            <div className="action-buttons" style={{ marginTop: 8 }}>
              <button onClick={() => void startGoogleConnect()} disabled={!googleConfigured}>Start Google Connect</button>
              <button onClick={() => void runGoogleCalendarSync()} disabled={!accounts.some((a) => a.provider === 'google')}>Sync Google Calendar</button>
            </div>
            {calendarSyncStatus && <div className="muted small" style={{ marginTop: 6 }}>{calendarSyncStatus}</div>}
            {oauthUrl && (
              <div className="small" style={{ marginTop: 8 }}>
                <a href={oauthUrl} target="_blank" rel="noreferrer">Open Google Consent URL</a>
              </div>
            )}
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <input placeholder="OAuth state" value={oauthState} onChange={(e) => setOauthState(e.target.value)} />
              <textarea placeholder="Paste authorization code" value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} rows={3} />
              <button onClick={() => void completeGoogleConnect()} disabled={!oauthState || !oauthCode}>Complete Connect</button>
            </div>
            <div className="action-list" style={{ marginTop: 8, maxHeight: 130 }}>
              {accounts.length === 0 && <div className="muted">No connected accounts</div>}
              {accounts.map((acct) => (
                <div className="action-row" key={acct.id}>
                  <div>
                    <div className="action-id">{acct.provider}</div>
                    <div className="muted small">{acct.accountEmail || acct.id}</div>
                  </div>
                  <div className="action-buttons">
                    {acct.provider === 'google' && <button onClick={() => void runGoogleCalendarSync(acct.id)}>Sync</button>}
                    <button onClick={() => disconnectAccount(acct.id).then(refreshOps)}>Disconnect</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="ops-card">
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
            <div style={{ display: 'grid', gap: 6, marginTop: 8, borderTop: '1px solid #eef2f7', paddingTop: 8 }}>
              <div className="muted small">Gmail Thread Search / Read</div>
              <input value={emailThreadQuery} onChange={(e) => setEmailThreadQuery(e.target.value)} placeholder="Gmail search query (e.g., from:alice newer_than:7d)" />
              <button onClick={() => void runThreadSearch()}>Search Threads</button>
              <div className="action-list" style={{ maxHeight: 150 }}>
                {emailThreadResults.length === 0 && <div className="muted">No thread search results</div>}
                {emailThreadResults.map((t) => (
                  <div className="action-row" key={t.id}>
                    <div style={{ minWidth: 0 }}>
                      <div className="action-id">{t.id}</div>
                      <div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{t.snippet}</div>
                    </div>
                    <div className="action-buttons">
                      <button onClick={() => void openThread(t.id)}>Open</button>
                      <button onClick={() => void createReplyDraft(t.id)}>Reply Draft</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="action-list" style={{ marginTop: 8, maxHeight: 220 }}>
              {emailDrafts.length === 0 && <div className="muted">No email drafts</div>}
              {emailDrafts.map((d) => (
                <div className="action-row" key={d.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="action-id">{d.id}</div>
                    <div className="muted small">{d.status} · {d.to.join(', ') || '(no recipient)'}</div>
                    <div className="small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{d.subject}</div>
                  </div>
                  <div className="action-buttons">
                    {d.status === 'prepared' && <button onClick={() => void approveAndSendDraft(d.id)}>Approve & Send</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="ops-card">
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

          <div className="ops-card">
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

          <div className="ops-card">
            <div className="section-head">Audit Log</div>
            <div className="audit-list">
              {audit.slice(0, 12).map((entry) => (
                <div key={entry.id} className="audit-row">
                  <div className="small mono">{entry.timestamp}</div>
                  <div>{entry.actionType}</div>
                  <div className="muted small">{entry.status}</div>
                </div>
              ))}
              {audit.length === 0 && <div className="muted">No audit entries</div>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
