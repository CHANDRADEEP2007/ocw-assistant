// Integrated note: every enhancement needs testing scripts automatically built.
// Integrated note (policy reminder): every enhancement needs testing scripts automatically built.

import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from './engine.js';

const ENHANCEMENT_TESTING_NOTE = 'Integrated note: every enhancement needs testing scripts automatically built.';

test(`Reader/Thinker heuristics parse email send fields (${ENHANCEMENT_TESTING_NOTE})`, () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const args = __test__.parseEmailSendArgs(
    'Send email to alice@example.com and bob@example.com subject: Launch update body: Please review milestone risks.',
  );

  assert.deepEqual(args.to, ['alice@example.com', 'bob@example.com']);
  assert.equal(args.subject, 'Launch update');
  assert.equal(args.body, 'Please review milestone risks.');
  assert.equal(args.requestedBy, 'local-user');
});

test(`Reader/Thinker heuristics parse multiline email body blocks (${ENHANCEMENT_TESTING_NOTE})`, () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const args = __test__.parseEmailSendArgs(
    [
      'Send email to team@example.com',
      'subject: Sprint update',
      'body:',
      'We completed milestones A and B.',
      'Need approval for milestone C by Friday.',
    ].join('\n'),
  );

  assert.deepEqual(args.to, ['team@example.com']);
  assert.equal(args.subject, 'Sprint update');
  assert.equal(
    args.body,
    ['We completed milestones A and B.', 'Need approval for milestone C by Friday.'].join('\n'),
  );
});

test(`Reader/Thinker heuristics parse calendar create fields (${ENHANCEMENT_TESTING_NOTE})`, () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const args = __test__.parseCalendarCreateArgs('Create event Design review on 2026-03-03 at 14:00 to 14:30');

  assert.equal(args.eventTitle, 'Design review');
  assert.equal(args.startDate, '2026-03-03');
  assert.equal(args.startTime, '14:00');
  assert.equal(args.endTime, '14:30');
});

test(`Thinker produces email-send plan and Judge requests approval when fields are present (${ENHANCEMENT_TESTING_NOTE})`, () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const context = __test__.buildContextPack({
    mode: 'quick',
    model: 'llama3:8b',
    messages: [
      {
        role: 'user',
        content: 'Send email to pm@example.com subject: Timeline update body: We are on track for Friday.',
      },
    ],
    channel: 'in_app',
  });
  const plan = __test__.planFromContext(context);
  const decision = __test__.judgePlan(context, plan);

  assert.equal(plan.toolCalls[0]?.tool, 'email.send');
  assert.equal(decision.status, 'requires_approval');
  assert.equal(decision.requiresApproval, true);
  assert.deepEqual(decision.requiredFields, []);
});

test(`Judge requests clarification when email-send fields are missing (${ENHANCEMENT_TESTING_NOTE})`, () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const context = __test__.buildContextPack({
    mode: 'quick',
    model: 'llama3:8b',
    messages: [{ role: 'user', content: 'Send email to finance@example.com' }],
    channel: 'in_app',
  });
  const plan = __test__.planFromContext(context);
  const decision = __test__.judgePlan(context, plan);

  assert.equal(plan.toolCalls[0]?.tool, 'email.send');
  assert.equal(decision.status, 'needs_clarification');
  assert.equal(decision.requiresApproval, true);
  assert.deepEqual(new Set(decision.requiredFields), new Set(['subject', 'body']));
});

test(`Judge requests clarification for incomplete calendar create fields (${ENHANCEMENT_TESTING_NOTE})`, () => {
  // Integrated note: every enhancement needs testing scripts automatically built.
  const context = __test__.buildContextPack({
    mode: 'quick',
    model: 'llama3:8b',
    messages: [{ role: 'user', content: 'Create event title: Team sync on 2026-03-05 at 10:00' }],
    channel: 'in_app',
  });
  const plan = __test__.planFromContext(context);
  const decision = __test__.judgePlan(context, plan);

  assert.equal(plan.toolCalls[0]?.tool, 'calendar.event.create');
  assert.equal(decision.status, 'needs_clarification');
  assert.ok(decision.requiredFields.includes('endTime'));
});
