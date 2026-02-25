import { getAction, transitionAction } from './approvalEngine.js';
import { writeAuditLog } from './auditLog.js';
import { createLocalCalendarEventFromApprovedAction } from './calendarService.js';
import { materializeApprovedSendActionAsLocalDraft } from './emailDraftService.js';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

function validateApprovedActionExecution(action: Awaited<ReturnType<typeof getAction>>) {
  if (!action) return ['action_not_found'];
  const issues: string[] = [];

  // Post-approval safety gate: reject stale approvals to force a fresh review.
  const ageMs = Date.now() - new Date(action.updatedAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > 7 * 24 * 60 * 60 * 1000) {
    issues.push('approval_stale_reapproval_required');
  }

  if (action.actionType === 'email.send') {
    const to = action.payload.to;
    const subject = action.payload.subject;
    const body = action.payload.body;
    if (!isStringArray(to) || to.length === 0) issues.push('email_to_missing');
    if (typeof subject !== 'string' || !subject.trim()) issues.push('email_subject_missing');
    if (typeof body !== 'string' || !body.trim()) issues.push('email_body_missing');
  }

  if (action.actionType === 'calendar.event.create') {
    const title = action.payload.eventTitle;
    const startDate = action.payload.startDate;
    const startTime = action.payload.startTime;
    const endTime = action.payload.endTime;
    if (typeof title !== 'string' || !title.trim()) issues.push('event_title_missing');
    if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) issues.push('event_start_date_invalid');
    if (typeof startTime !== 'string' || !/^\d{1,2}:\d{2}$/.test(startTime)) issues.push('event_start_time_invalid');
    if (typeof endTime !== 'string' || !/^\d{1,2}:\d{2}$/.test(endTime)) issues.push('event_end_time_invalid');
  }

  return issues;
}

export async function executeApprovedAction(input: { actionId: string; approvedBy?: string }) {
  const action = await getAction(input.actionId);
  if (!action) throw new Error('action_not_found');
  if (action.status !== 'approved') throw new Error('action_not_approved');

  const policyIssues = validateApprovedActionExecution(action);
  if (policyIssues.length > 0) {
    await writeAuditLog({
      actionType: 'action_execute_blocked',
      targetType: action.targetType,
      targetRef: action.id,
      status: 'blocked',
      details: { actionType: action.actionType, policyIssues },
    });
    throw new Error(`execution_policy_blocked:${policyIssues.join(',')}`);
  }

  await writeAuditLog({
    actionType: 'action_execute_begin',
    targetType: action.targetType,
    targetRef: action.id,
    status: 'prepared',
    details: { actionType: action.actionType },
  });

  let execution: Record<string, unknown>;
  if (action.actionType === 'calendar.event.create') {
    execution = await createLocalCalendarEventFromApprovedAction({ actionId: action.id, payload: action.payload });
  } else if (action.actionType === 'email.send') {
    execution = await materializeApprovedSendActionAsLocalDraft({ actionId: action.id, payload: action.payload });
  } else {
    throw new Error(`unsupported_action_execution:${action.actionType}`);
  }

  const updated = await transitionAction({
    actionId: action.id,
    nextStatus: 'executed',
    approvedBy: input.approvedBy || action.approvedBy || 'local-user',
  });

  await writeAuditLog({
    actionType: 'action_execute_complete',
    targetType: updated.targetType,
    targetRef: updated.id,
    status: 'executed',
    details: { actionType: updated.actionType },
  });

  return { item: updated, execution };
}
