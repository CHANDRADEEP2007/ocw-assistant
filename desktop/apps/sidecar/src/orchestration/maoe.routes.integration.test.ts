// Integrated note: every enhancement needs testing scripts automatically built.
// Integrated note (integration coverage): every enhancement needs testing scripts automatically built.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { createApp } from '../app.js';
import { sqlite } from '../db/client.js';

const ENHANCEMENT_TESTING_NOTE = 'Integrated note: every enhancement needs testing scripts automatically built.';

async function withServer<T>(fn: (baseUrl: string) => Promise<T>) {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test(`MAOE chat returns runId and orchestration payload for calendar query (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quick',
        model: 'llama3:8b',
        channel: 'in_app',
        messages: [{ role: 'user', content: "What's my calendar today?" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      message: { content: string };
      orchestration?: { runId?: string; decision?: { status: string } };
      cards?: Array<{ type: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.orchestration?.runId, 'string');
    assert.equal(body.orchestration?.decision?.status, 'proceed');
    assert.ok((body.cards ?? []).some((c) => c.type === 'CalendarSummaryCard'));
  });
});

test(`MAOE orchestration detail endpoint returns traces/plans/decisions for a run (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quick',
        model: 'llama3:8b',
        channel: 'in_app',
        messages: [{ role: 'user', content: 'Show my schedule today' }],
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatBody = (await chatRes.json()) as { orchestration?: { runId?: string } };
    const runId = chatBody.orchestration?.runId;
    assert.equal(typeof runId, 'string');

    const detailRes = await fetch(`${baseUrl}/api/orchestration/runs/${runId}`);
    assert.equal(detailRes.status, 200);
    const detailBody = (await detailRes.json()) as {
      item: {
        run: { id: string; status: string };
        plans: Array<{ payload: { intent?: string } | null }>;
        decisions: Array<{ status: string }>;
        traces: Array<{ agent: string }>;
      };
    };

    assert.equal(detailBody.item.run.id, runId);
    assert.ok(detailBody.item.decisions.length >= 1);
    assert.ok(detailBody.item.traces.some((t) => t.agent === 'reader'));
    assert.ok(detailBody.item.traces.some((t) => t.agent === 'thinker'));
    assert.ok(detailBody.item.traces.some((t) => t.agent === 'judge'));
    assert.ok(detailBody.item.plans.length >= 1);
  });
});

test(`MAOE chat prepares approval action for email-send intents (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quick',
        model: 'llama3:8b',
        channel: 'in_app',
        messages: [
          {
            role: 'user',
            content: 'Send email to qa@example.com subject: Test rollout body: Please approve rollout checklist.',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      orchestration?: { decision?: { status: string }; toolResults?: Array<{ tool: string; ok: boolean }> };
      cards?: Array<{ type: string; data?: Record<string, unknown> }>;
      message?: { content: string };
    };
    assert.equal(body.orchestration?.decision?.status, 'requires_approval');
    assert.ok((body.orchestration?.toolResults ?? []).some((r) => r.tool === 'email.send' && r.ok));
    assert.ok((body.cards ?? []).some((c) => c.type === 'ApprovalActionCard'));
    assert.match(body.message?.content ?? '', /approval action/i);
  });
});

test(`MAOE-created approval actions can transition via actions routes (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quick',
        model: 'llama3:8b',
        channel: 'in_app',
        messages: [
          {
            role: 'user',
            content: 'Send email to ops@example.com subject: Deploy body: Please approve the deployment window.',
          },
        ],
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatBody = (await chatRes.json()) as {
      cards?: Array<{ type: string; data?: Record<string, unknown> }>;
    };

    const approvalCard = (chatBody.cards ?? []).find(
      (c) => c.type === 'ApprovalActionCard' && c.data && typeof c.data.id === 'string',
    );
    assert.ok(approvalCard, 'expected approval action card with id');
    const actionId = String(approvalCard?.data?.id);

    const approveRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'approved', approvedBy: 'integration-test' }),
    });
    assert.equal(approveRes.status, 200);
    const approveBody = (await approveRes.json()) as { item: { id: string; status: string } };
    assert.equal(approveBody.item.id, actionId);
    assert.equal(approveBody.item.status, 'approved');

    const executeRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'executed', approvedBy: 'integration-test' }),
    });
    assert.equal(executeRes.status, 200);
    const executeBody = (await executeRes.json()) as {
      item: { id: string; status: string };
      execution?: { mode?: string; draft?: { id: string } };
    };
    assert.equal(executeBody.item.id, actionId);
    assert.equal(executeBody.item.status, 'executed');
    assert.equal(executeBody.execution?.mode, 'safe_local_draft');
    assert.equal(typeof executeBody.execution?.draft?.id, 'string');
  });
});

test(`MAOE calendar create actions execute into local calendar events (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quick',
        model: 'llama3:8b',
        channel: 'in_app',
        messages: [
          {
            role: 'user',
            content: 'Create event title: Planning sync on 2026-03-05 at 10:00 10:30',
          },
        ],
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatBody = (await chatRes.json()) as { cards?: Array<{ type: string; data?: Record<string, unknown> }> };
    const approvalCard = (chatBody.cards ?? []).find(
      (c) => c.type === 'ApprovalActionCard' && c.data && typeof c.data.id === 'string',
    );
    assert.ok(approvalCard, 'expected approval action card for calendar create');
    const actionId = String(approvalCard?.data?.id);

    const approveRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'approved', approvedBy: 'integration-test' }),
    });
    assert.equal(approveRes.status, 200);

    const executeRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'executed', approvedBy: 'integration-test' }),
    });
    assert.equal(executeRes.status, 200);
    const executeBody = (await executeRes.json()) as {
      item: { status: string };
      execution?: { event?: { id: string; title: string; startAt: string; endAt: string } };
    };
    assert.equal(executeBody.item.status, 'executed');
    assert.equal(typeof executeBody.execution?.event?.id, 'string');
    assert.equal(executeBody.execution?.event?.title, 'Planning sync');
    assert.match(executeBody.execution?.event?.startAt ?? '', /2026-03-05T10:00:00/);
  });
});

test(`Execution safety gate blocks invalid approved actions before execution (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const preparedRes = await fetch(`${baseUrl}/api/actions/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'email.send',
        targetType: 'email_send_request',
        payload: { to: ['invalid@example.com'] }, // missing subject/body on purpose
        requestedBy: 'integration-test',
      }),
    });
    assert.equal(preparedRes.status, 201);
    const prepared = (await preparedRes.json()) as { item: { id: string } };
    const actionId = prepared.item.id;

    const approveRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'approved', approvedBy: 'integration-test' }),
    });
    assert.equal(approveRes.status, 200);

    const executeRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'executed', approvedBy: 'integration-test' }),
    });
    assert.equal(executeRes.status, 400);
    const executeBody = (await executeRes.json()) as { error: string };
    assert.match(executeBody.error, /execution_policy_blocked:/);
  });
});

test(`Stale approved actions can be reaffirmed and then executed (${ENHANCEMENT_TESTING_NOTE})`, async () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  await withServer(async (baseUrl) => {
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quick',
        model: 'llama3:8b',
        channel: 'in_app',
        messages: [
          {
            role: 'user',
            content: 'Send email to stale@example.com subject: Stale approval test body: Reconfirm then execute.',
          },
        ],
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatBody = (await chatRes.json()) as { cards?: Array<{ type: string; data?: Record<string, unknown> }> };
    const approvalCard = (chatBody.cards ?? []).find(
      (c) => c.type === 'ApprovalActionCard' && c.data && typeof c.data.id === 'string',
    );
    assert.ok(approvalCard);
    const actionId = String(approvalCard?.data?.id);

    const approveRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'approved', approvedBy: 'integration-test' }),
    });
    assert.equal(approveRes.status, 200);

    // Integrated note: every enhancement needs testing scripts automatically built.
    const staleIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    sqlite.prepare('UPDATE approval_actions SET updated_at = ? WHERE id = ?').run(staleIso, actionId);

    const blockedExecuteRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'executed', approvedBy: 'integration-test' }),
    });
    assert.equal(blockedExecuteRes.status, 400);
    const blockedBody = (await blockedExecuteRes.json()) as { error: string };
    assert.match(blockedBody.error, /approval_stale_reapproval_required/);

    const reaffirmRes = await fetch(`${baseUrl}/api/actions/${actionId}/reaffirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'integration-test' }),
    });
    assert.equal(reaffirmRes.status, 200);
    const reaffirmBody = (await reaffirmRes.json()) as { item: { status: string } };
    assert.equal(reaffirmBody.item.status, 'approved');

    const executeRes = await fetch(`${baseUrl}/api/actions/${actionId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextStatus: 'executed', approvedBy: 'integration-test' }),
    });
    assert.equal(executeRes.status, 200);
    const executeBody = (await executeRes.json()) as { item: { status: string } };
    assert.equal(executeBody.item.status, 'executed');
  });
});
