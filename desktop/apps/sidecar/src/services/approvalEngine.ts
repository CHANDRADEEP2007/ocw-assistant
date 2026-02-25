import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { approvalActions } from '../db/schema.js';
import { id } from '../lib/id.js';
import type { ApprovalAction, ApprovalStatus } from '../types.js';
import { writeAuditLog } from './auditLog.js';

const TERMINAL: ApprovalStatus[] = ['executed', 'failed', 'cancelled'];

function now() {
  return new Date().toISOString();
}

function parseRow(row: typeof approvalActions.$inferSelect): ApprovalAction {
  return {
    id: row.id,
    actionType: row.actionType,
    targetType: row.targetType,
    targetRef: row.targetRef,
    payload: JSON.parse(row.payloadJson),
    status: row.status as ApprovalStatus,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    errorDetails: row.errorDetails,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function prepareAction(input: {
  actionType: string;
  targetType: string;
  targetRef?: string;
  payload: Record<string, unknown>;
  requestedBy: string;
}): Promise<ApprovalAction> {
  const record = {
    id: id('act'),
    actionType: input.actionType,
    targetType: input.targetType,
    targetRef: input.targetRef ?? null,
    payloadJson: JSON.stringify(input.payload),
    status: 'prepared',
    requestedBy: input.requestedBy,
    approvedBy: null,
    errorDetails: null,
    createdAt: now(),
    updatedAt: now(),
  } as const;

  await db.insert(approvalActions).values(record);
  await writeAuditLog({
    actionType: 'approval_prepared',
    targetType: input.targetType,
    targetRef: record.id,
    status: 'prepared',
    details: { actionType: input.actionType },
  });
  return parseRow(record as unknown as typeof approvalActions.$inferSelect);
}

export async function listActions(limit = 100): Promise<ApprovalAction[]> {
  const rows = await db.select().from(approvalActions).limit(limit);
  return rows.map(parseRow).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getAction(actionId: string): Promise<ApprovalAction | null> {
  const rows = await db.select().from(approvalActions).where(eq(approvalActions.id, actionId)).limit(1);
  return rows[0] ? parseRow(rows[0]) : null;
}

export async function transitionAction(input: {
  actionId: string;
  nextStatus: ApprovalStatus;
  approvedBy?: string;
  errorDetails?: string;
}): Promise<ApprovalAction> {
  const current = await getAction(input.actionId);
  if (!current) {
    throw new Error('action_not_found');
  }
  if (TERMINAL.includes(current.status)) {
    throw new Error('action_terminal');
  }

  const allowed =
    (current.status === 'prepared' && ['approved', 'cancelled', 'failed'].includes(input.nextStatus)) ||
    (current.status === 'approved' && ['executed', 'failed', 'cancelled'].includes(input.nextStatus));

  if (!allowed) {
    throw new Error(`invalid_transition:${current.status}->${input.nextStatus}`);
  }

  const updatedAt = now();
  await db
    .update(approvalActions)
    .set({
      status: input.nextStatus,
      approvedBy: input.approvedBy ?? current.approvedBy ?? null,
      errorDetails: input.errorDetails ?? null,
      updatedAt,
    })
    .where(eq(approvalActions.id, input.actionId));

  const next = await getAction(input.actionId);
  if (!next) {
    throw new Error('action_not_found');
  }

  await writeAuditLog({
    actionType: 'approval_transition',
    targetType: next.targetType,
    targetRef: next.id,
    status: input.nextStatus,
    details: { from: current.status, to: input.nextStatus },
    errorDetails: input.errorDetails,
  });

  return next;
}

export async function reaffirmAction(input: {
  actionId: string;
  approvedBy?: string;
}): Promise<ApprovalAction> {
  const current = await getAction(input.actionId);
  if (!current) {
    throw new Error('action_not_found');
  }
  if (current.status !== 'approved') {
    throw new Error('action_not_approved');
  }

  const updatedAt = now();
  await db
    .update(approvalActions)
    .set({
      approvedBy: input.approvedBy ?? current.approvedBy ?? null,
      updatedAt,
    })
    .where(eq(approvalActions.id, input.actionId));

  const next = await getAction(input.actionId);
  if (!next) {
    throw new Error('action_not_found');
  }

  await writeAuditLog({
    actionType: 'approval_reaffirmed',
    targetType: next.targetType,
    targetRef: next.id,
    status: next.status,
    details: { actionType: next.actionType },
  });

  return next;
}
