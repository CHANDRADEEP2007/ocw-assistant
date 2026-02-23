import crypto from 'node:crypto';

import { config } from '../config.js';
import { getAccountTokenBundle, updateAccountTokenBundle } from './accountService.js';
import { writeAuditLog } from './auditLog.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const GOOGLE_MVP_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

type PendingSession = {
  state: string;
  codeVerifier: string;
  createdAt: number;
  scopes: string[];
};

const pendingPkce = new Map<string, PendingSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

type GoogleTokenBundle = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  _ocw_obtained_at?: string;
  [key: string]: unknown;
};

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function cleanup() {
  const now = Date.now();
  for (const [state, session] of pendingPkce.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) pendingPkce.delete(state);
  }
}

export function startGoogleOAuth(input?: { scopes?: string[] }) {
  cleanup();
  if (!config.googleClientId) {
    throw new Error('google_client_id_missing');
  }
  const scopes = input?.scopes?.length ? input.scopes : GOOGLE_MVP_SCOPES;
  const state = randomBase64Url(18);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = sha256Base64Url(codeVerifier);
  pendingPkce.set(state, { state, codeVerifier, createdAt: Date.now(), scopes });

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  void writeAuditLog({ actionType: 'google_oauth_start', targetType: 'oauth_session', targetRef: state, status: 'prepared' });

  return {
    provider: 'google' as const,
    state,
    scopes,
    redirectUri: config.googleRedirectUri,
    authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
  };
}

export async function completeGoogleOAuth(input: { state: string; code: string }) {
  cleanup();
  const session = pendingPkce.get(input.state);
  if (!session) {
    throw new Error('oauth_state_not_found_or_expired');
  }
  pendingPkce.delete(input.state);

  if (!config.googleClientId) {
    throw new Error('google_client_id_missing');
  }

  const tokenParams = new URLSearchParams({
    code: input.code,
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    grant_type: 'authorization_code',
    code_verifier: session.codeVerifier,
  });
  if (config.googleClientSecret) {
    tokenParams.set('client_secret', config.googleClientSecret);
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });
  const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
  if (!tokenRes.ok) {
    await writeAuditLog({
      actionType: 'google_oauth_complete',
      targetType: 'oauth_session',
      targetRef: input.state,
      status: 'failed',
      details: { error: tokenBody },
      errorDetails: 'token_exchange_failed',
    });
    throw new Error('google_token_exchange_failed');
  }

  let accountEmail: string | null = null;
  try {
    const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
    if (accessToken) {
      const userInfoRes = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (userInfoRes.ok) {
        const user = (await userInfoRes.json()) as { email?: string };
        accountEmail = user.email ?? null;
      }
    }
  } catch {
    // best effort only
  }

  await writeAuditLog({
    actionType: 'google_oauth_complete',
    targetType: 'oauth_session',
    targetRef: input.state,
    status: 'approved',
    details: { accountEmail },
  });

  return {
    provider: 'google' as const,
    accountEmail,
    scopes: session.scopes,
    tokenBundle: tokenBody,
  };
}

export function googleOAuthStatus() {
  return {
    configured: Boolean(config.googleClientId),
    redirectUri: config.googleRedirectUri,
    scopes: GOOGLE_MVP_SCOPES,
  };
}

function isExpiring(bundle: GoogleTokenBundle): boolean {
  const expiresIn = typeof bundle.expires_in === 'number' ? bundle.expires_in : null;
  const obtainedAt = typeof bundle._ocw_obtained_at === 'string' ? Date.parse(bundle._ocw_obtained_at) : NaN;
  if (!expiresIn || Number.isNaN(obtainedAt)) return false;
  const expiresAt = obtainedAt + expiresIn * 1000;
  return Date.now() > (expiresAt - 60_000);
}

async function refreshGoogleToken(refreshToken: string): Promise<GoogleTokenBundle> {
  if (!config.googleClientId) {
    throw new Error('google_client_id_missing');
  }
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (config.googleClientSecret) {
    params.set('client_secret', config.googleClientSecret);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = (await res.json()) as GoogleTokenBundle;
  if (!res.ok) {
    throw new Error('google_refresh_token_exchange_failed');
  }
  return body;
}

export async function getValidGoogleAccessToken(accountId: string): Promise<string> {
  const bundle = (await getAccountTokenBundle(accountId)) as GoogleTokenBundle | null;
  if (!bundle) {
    throw new Error('google_token_bundle_missing');
  }

  const currentAccessToken = typeof bundle.access_token === 'string' ? bundle.access_token : '';
  const refreshToken = typeof bundle.refresh_token === 'string' ? bundle.refresh_token : '';

  if (currentAccessToken && !isExpiring(bundle)) {
    return currentAccessToken;
  }

  if (!refreshToken) {
    if (currentAccessToken) return currentAccessToken;
    throw new Error('google_refresh_token_missing');
  }

  try {
    const refreshed = await refreshGoogleToken(refreshToken);
    const merged: GoogleTokenBundle = {
      ...bundle,
      ...refreshed,
      refresh_token: refreshed.refresh_token || refreshToken,
      _ocw_obtained_at: new Date().toISOString(),
    };
    const saved = await updateAccountTokenBundle(accountId, merged);
    await writeAuditLog({
      actionType: 'google_token_refresh',
      targetType: 'connected_account',
      targetRef: accountId,
      status: saved ? 'executed' : 'failed',
      errorDetails: saved ? undefined : 'keytar_store_failed',
    });
    const token = typeof merged.access_token === 'string' ? merged.access_token : '';
    if (!token) throw new Error('google_access_token_missing_after_refresh');
    return token;
  } catch (error) {
    await writeAuditLog({
      actionType: 'google_token_refresh',
      targetType: 'connected_account',
      targetRef: accountId,
      status: 'failed',
      errorDetails: error instanceof Error ? error.message : String(error),
    });
    if (currentAccessToken) return currentAccessToken;
    throw error;
  }
}

export async function forceRefreshGoogleAccessToken(accountId: string): Promise<string> {
  const bundle = (await getAccountTokenBundle(accountId)) as GoogleTokenBundle | null;
  const refreshToken = typeof bundle?.refresh_token === 'string' ? bundle.refresh_token : '';
  if (!refreshToken) {
    throw new Error('google_refresh_token_missing');
  }
  const refreshed = await refreshGoogleToken(refreshToken);
  const merged: GoogleTokenBundle = {
    ...(bundle || {}),
    ...refreshed,
    refresh_token: refreshed.refresh_token || refreshToken,
    _ocw_obtained_at: new Date().toISOString(),
  };
  const saved = await updateAccountTokenBundle(accountId, merged);
  await writeAuditLog({
    actionType: 'google_token_refresh',
    targetType: 'connected_account',
    targetRef: accountId,
    status: saved ? 'executed' : 'failed',
    errorDetails: saved ? undefined : 'keytar_store_failed',
    details: { forced: true },
  });
  const token = typeof merged.access_token === 'string' ? merged.access_token : '';
  if (!token) {
    throw new Error('google_access_token_missing_after_refresh');
  }
  return token;
}
