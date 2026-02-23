import { desc, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { connectedAccounts } from '../db/schema.js';
import { id } from '../lib/id.js';
import { config } from '../config.js';
import { deleteSecret, getSecret, setSecret } from './tokenStore.js';
import { writeAuditLog } from './auditLog.js';

function now() {
  return new Date().toISOString();
}

export type ConnectedAccountDTO = {
  id: string;
  provider: string;
  accountEmail: string | null;
  status: string;
  scopes: string[];
  tokenRef: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: typeof connectedAccounts.$inferSelect): ConnectedAccountDTO {
  return {
    id: row.id,
    provider: row.provider,
    accountEmail: row.accountEmail,
    status: row.status,
    scopes: row.scopesJson ? JSON.parse(row.scopesJson) : [],
    tokenRef: row.tokenRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listConnectedAccounts(): Promise<ConnectedAccountDTO[]> {
  const rows = await db.select().from(connectedAccounts).orderBy(desc(connectedAccounts.updatedAt));
  return rows.map(mapRow);
}

export async function getConnectedAccount(accountId: string): Promise<ConnectedAccountDTO | null> {
  const rows = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getConnectedAccountsByProvider(provider: string): Promise<ConnectedAccountDTO[]> {
  const rows = await db.select().from(connectedAccounts).where(eq(connectedAccounts.provider, provider));
  return rows.map(mapRow);
}

export async function getAccountTokenBundle(accountId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).limit(1);
  const row = rows[0];
  if (!row?.tokenRef) return null;
  const secret = await getSecret(config.tokenServiceName, row.tokenRef);
  if (!secret) return null;
  try {
    return JSON.parse(secret) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function updateAccountTokenBundle(accountId: string, tokenBundle: Record<string, unknown>): Promise<boolean> {
  const rows = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).limit(1);
  const row = rows[0];
  if (!row?.tokenRef) return false;
  const ok = await setSecret(config.tokenServiceName, row.tokenRef, JSON.stringify(tokenBundle));
  await db
    .update(connectedAccounts)
    .set({ updatedAt: now(), status: ok ? row.status : 'token_store_error' })
    .where(eq(connectedAccounts.id, accountId));
  return ok;
}

export async function saveGoogleConnectedAccount(input: {
  accountEmail: string | null;
  scopes: string[];
  tokenBundle: Record<string, unknown>;
}) {
  const ts = now();
  const tokenRef = `google:${input.accountEmail || id('acct')}`;
  const row = {
    id: id('acct'),
    provider: 'google',
    accountEmail: input.accountEmail,
    status: 'connected',
    scopesJson: JSON.stringify(input.scopes),
    tokenRef,
    createdAt: ts,
    updatedAt: ts,
  };

  await db.insert(connectedAccounts).values(row);
  const bundle = { ...input.tokenBundle, _ocw_obtained_at: ts };
  const keytarOk = await setSecret(config.tokenServiceName, tokenRef, JSON.stringify(bundle));

  await writeAuditLog({
    actionType: 'account_connected',
    targetType: 'connected_account',
    targetRef: row.id,
    status: keytarOk ? 'executed' : 'failed',
    details: { provider: 'google', keytarOk, tokenRef, accountEmail: input.accountEmail },
    errorDetails: keytarOk ? undefined : 'keytar_store_failed',
  });

  return { ...mapRow(row), keytarOk };
}

export async function disconnectAccount(accountId: string) {
  const rows = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).limit(1);
  if (!rows[0]) {
    throw new Error('account_not_found');
  }
  const row = rows[0];
  if (row.tokenRef) {
    await deleteSecret(config.tokenServiceName, row.tokenRef);
  }
  await db.delete(connectedAccounts).where(eq(connectedAccounts.id, accountId));
  await writeAuditLog({ actionType: 'account_disconnected', targetType: 'connected_account', targetRef: accountId, status: 'executed' });
  return { ok: true };
}
