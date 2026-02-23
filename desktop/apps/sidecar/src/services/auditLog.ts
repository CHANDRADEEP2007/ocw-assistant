import { desc } from 'drizzle-orm';

import { db } from '../db/client.js';
import { auditLogs } from '../db/schema.js';
import { id } from '../lib/id.js';

export async function writeAuditLog(input: {
  actionType: string;
  targetType?: string;
  targetRef?: string;
  status: string;
  details?: Record<string, unknown>;
  errorDetails?: string;
}) {
  const now = new Date().toISOString();
  await db.insert(auditLogs).values({
    id: id('audit'),
    timestamp: now,
    actionType: input.actionType,
    targetType: input.targetType ?? null,
    targetRef: input.targetRef ?? null,
    status: input.status,
    detailsJson: input.details ? JSON.stringify(input.details) : null,
    errorDetails: input.errorDetails ?? null,
  });
}

export async function listAuditLogs(limit = 100) {
  const rows = await db.select().from(auditLogs).orderBy(desc(auditLogs.timestamp)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    actionType: row.actionType,
    targetType: row.targetType,
    targetRef: row.targetRef,
    status: row.status,
    details: row.detailsJson ? JSON.parse(row.detailsJson) : null,
    errorDetails: row.errorDetails,
  }));
}
