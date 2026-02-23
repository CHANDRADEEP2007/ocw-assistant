import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

export const approvalActions = sqliteTable('approval_actions', {
  id: text('id').primaryKey(),
  actionType: text('action_type').notNull(),
  targetType: text('target_type').notNull(),
  targetRef: text('target_ref'),
  payloadJson: text('payload_json').notNull(),
  status: text('status').notNull(),
  requestedBy: text('requested_by').notNull(),
  approvedBy: text('approved_by'),
  errorDetails: text('error_details'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  actionType: text('action_type').notNull(),
  targetType: text('target_type'),
  targetRef: text('target_ref'),
  status: text('status').notNull(),
  detailsJson: text('details_json'),
  errorDetails: text('error_details'),
});

export const connectedAccounts = sqliteTable('connected_accounts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  accountEmail: text('account_email'),
  status: text('status').notNull(),
  scopesJson: text('scopes_json').notNull(),
  tokenRef: text('token_ref'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const calendars = sqliteTable('calendars', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  accountId: text('account_id'),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  color: text('color'),
  included: text('included').notNull(), // "1" | "0"
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const calendarEvents = sqliteTable('calendar_events', {
  id: text('id').primaryKey(),
  calendarId: text('calendar_id').notNull(),
  provider: text('provider').notNull(),
  sourceEventId: text('source_event_id'),
  title: text('title').notNull(),
  description: text('description'),
  location: text('location'),
  status: text('status').notNull(), // confirmed | tentative
  startAt: text('start_at').notNull(),
  endAt: text('end_at').notNull(),
  timezone: text('timezone').notNull(),
  attendeesJson: text('attendees_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const draftEmails = sqliteTable('draft_emails', {
  id: text('id').primaryKey(),
  accountId: text('account_id'),
  toJson: text('to_json').notNull(),
  ccJson: text('cc_json'),
  bccJson: text('bcc_json'),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  sourcePrompt: text('source_prompt'),
  tone: text('tone'),
  status: text('status').notNull(), // prepared | approved | sent | failed | cancelled
  approvalActionId: text('approval_action_id'),
  gmailMessageId: text('gmail_message_id'),
  errorDetails: text('error_details'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
