import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { configDir } from './config';

interface OAuthClientSettings {
  clientId: string;
  clientSecret?: string;
}

let cachedOAuthClient: OAuthClientSettings | null | undefined;

function oauthClientPath(): string {
  return path.join(configDir(), 'google-oauth-client.json');
}

function loadOAuthClientSettings(): OAuthClientSettings | null {
  if (cachedOAuthClient !== undefined) return cachedOAuthClient;
  try {
    const raw = JSON.parse(fs.readFileSync(oauthClientPath(), 'utf8'));
    if (raw && typeof raw.clientId === 'string' && raw.clientId.trim()) {
      cachedOAuthClient = {
        clientId: raw.clientId.trim(),
        clientSecret: typeof raw.clientSecret === 'string' && raw.clientSecret ? raw.clientSecret : undefined
      };
      return cachedOAuthClient;
    }
  } catch { }
  cachedOAuthClient = null;
  return cachedOAuthClient;
}

function resolvedOAuthClient(): { id: string; secret: string; source: 'local' | 'environment' | 'missing' } {
  const saved = loadOAuthClientSettings();
  const envId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || '';
  const envSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '';
  const id = saved?.clientId || envId;
  const secret = saved?.clientSecret || envSecret;
  return {
    id,
    secret,
    source: saved ? 'local' : envId || envSecret ? 'environment' : 'missing'
  };
}

function oauthClient(): { id: string; secret: string } {
  const client = resolvedOAuthClient();
  if (!client.id || !client.secret) {
    throw new Error('Enter a Google OAuth client ID and secret in the Antigravity connector, or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
  }
  return { id: client.id, secret: client.secret };
}

export function googleOAuthConfigured(): boolean {
  const client = resolvedOAuthClient();
  return !!(client.id && client.secret);
}

export function saveOAuthClientConfig(clientId: string, clientSecret: string): void {
  const id = clientId.trim();
  const enteredSecret = clientSecret.trim();
  const saved = loadOAuthClientSettings();
  const secret = enteredSecret || saved?.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '';
  if (!id) throw new Error('Google OAuth client ID is required.');
  if (!secret) throw new Error('Google OAuth client secret is required.');

  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = oauthClientPath();
  const next: OAuthClientSettings = { clientId: id, clientSecret: secret };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { }
  cachedOAuthClient = next;
}

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'].join(' ');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
export const OAUTH_CALLBACK_PATH = '/oauth2callback';

const ANTIGRAVITY_PLATFORM = process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 2 : 1)
  : process.platform === 'linux'
    ? (process.arch === 'arm64' ? 4 : 3)
    : process.platform === 'win32' ? 5 : 0;
const CLIENT_METADATA = { ideType: 9, platform: ANTIGRAVITY_PLATFORM, pluginType: 2 };
export const ANTIGRAVITY_USER_AGENT = 'antigravity/ide/2.1.1 darwin/arm64';

function configuredProjectId(): string | undefined {
  const value = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
  return value || undefined;
}

export interface GoogleCreds {
  refreshToken: string;
  accessToken: string;
  expiry: number;
  email?: string;
  projectId?: string;
}

interface PendingLogin {
  redirectUri: string;
  verifier: string;
  createdAt: number;
}

let cached: GoogleCreds | null | undefined;
const pendingStates = new Map<string, PendingLogin>();

function credsPath(): string {
  return path.join(configDir(), 'google-oauth.json');
}

export function loadCreds(): GoogleCreds | null {
  if (cached !== undefined) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
    if (raw && typeof raw.refreshToken === 'string' && raw.refreshToken) {
      cached = {
        refreshToken: raw.refreshToken,
        accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : '',
        expiry: typeof raw.expiry === 'number' ? raw.expiry : 0,
        email: typeof raw.email === 'string' ? raw.email : undefined,
        projectId: typeof raw.projectId === 'string' ? raw.projectId : undefined
      };
      return cached;
    }
  } catch { }
  cached = null;
  return cached;
}

function saveCreds(creds: GoogleCreds): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credsPath();
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { }
  cached = creds;
}

export function clearCreds(): void {
  cached = null;
  try { fs.unlinkSync(credsPath()); } catch { }
}

export function isAuthenticated(): boolean {
  return !!loadCreds();
}

export function authStatus(): { authenticated: boolean; oauthConfigured: boolean; oauthClientId?: string; oauthConfigSource: 'local' | 'environment' | 'missing'; email?: string; projectId?: string } {
  const creds = loadCreds();
  const client = resolvedOAuthClient();
  return {
    authenticated: !!creds,
    oauthConfigured: !!(client.id && client.secret),
    oauthClientId: client.id || undefined,
    oauthConfigSource: client.source,
    email: creds?.email,
    projectId: creds?.projectId
  };
}

export function beginLogin(port: number): { url: string } {
  const client = oauthClient();
  const now = Date.now();
  for (const [state, login] of pendingStates) {
    if (now - login.createdAt > 600_000) pendingStates.delete(state);
  }

  const state = randomBytes(24).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
  pendingStates.set(state, { redirectUri, verifier, createdAt: now });
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  return { url: `${AUTH_URL}?${params.toString()}` };
}

function decodeIdTokenEmail(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

async function tokenRequest(form: Record<string, string>): Promise<any> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000)
  });
  const json: any = await response.json().catch(() => null);
  if (!response.ok || !json) {
    throw new Error(`Google token endpoint HTTP ${response.status}: ${String(json?.error_description || json?.error || '').slice(0, 200)}`);
  }
  return json;
}

async function codeAssistCall(accessToken: string, method: string, body: unknown): Promise<any> {
  const response = await fetch(`${CODE_ASSIST_URL}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': ANTIGRAVITY_USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const json: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}: ${String(json?.error?.message || '').slice(0, 200)}`);
  }
  return json;
}

async function getOperation(accessToken: string, name: string): Promise<any> {
  const operation = name.replace(/^\/+/, '');
  const response = await fetch(`${CODE_ASSIST_URL}/${operation}`, {
    headers: { authorization: `Bearer ${accessToken}`, 'user-agent': ANTIGRAVITY_USER_AGENT },
    signal: AbortSignal.timeout(15_000)
  });
  const json: any = await response.json().catch(() => null);
  if (!response.ok || !json) {
    throw new Error(`Code Assist onboarding status HTTP ${response.status}: ${String(json?.error?.message || '').slice(0, 200)}`);
  }
  return json;
}

function projectIdFrom(value: any): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value.id === 'string' && value.id.trim()) return value.id.trim();
  return undefined;
}

async function ensureProject(accessToken: string): Promise<string | undefined> {
  const configuredProject = configuredProjectId();
  const metadata = configuredProject ? { ...CLIENT_METADATA, duetProject: configuredProject } : CLIENT_METADATA;
  const loaded = await codeAssistCall(accessToken, 'loadCodeAssist', {
    ...(configuredProject ? { cloudaicompanionProject: configuredProject } : {}),
    metadata
  });
  const existing = projectIdFrom(loaded?.cloudaicompanionProject);
  if (existing) return existing;
  if (configuredProject && loaded?.currentTier) return configuredProject;
  if (loaded?.currentTier) {
    throw new Error('This Google account requires a Google Cloud project. Set GOOGLE_CLOUD_PROJECT and restart ZeroCode.');
  }

  const tiers: any[] = Array.isArray(loaded?.allowedTiers) ? loaded.allowedTiers : [];
  const tierId = tiers.find((tier) => tier?.isDefault)?.id || tiers[0]?.id || 'free-tier';
  if (!/free/i.test(String(tierId)) && !configuredProject) {
    throw new Error('This Google account requires a Google Cloud project. Set GOOGLE_CLOUD_PROJECT and restart ZeroCode.');
  }
  const onboarding = await codeAssistCall(accessToken, 'onboardUser', {
    tierId,
    ...(configuredProject ? { cloudaicompanionProject: configuredProject } : {}),
    metadata
  });
  if (onboarding?.done) return projectIdFrom(onboarding?.response?.cloudaicompanionProject) || configuredProject;
  if (typeof onboarding?.name !== 'string' || !onboarding.name) return configuredProject;

  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const operation = await getOperation(accessToken, onboarding.name);
    if (operation?.done) return projectIdFrom(operation?.response?.cloudaicompanionProject) || configuredProject;
  }
  throw new Error('Google Code Assist project setup is still pending. Wait a moment and try again.');
}

export async function handleCallback(code: string, state: string): Promise<{ email?: string }> {
  const pending = pendingStates.get(state);
  if (!pending || Date.now() - pending.createdAt > 600_000) {
    pendingStates.delete(state);
    throw new Error('Unknown or expired Google sign-in state. Start sign-in again.');
  }
  pendingStates.delete(state);
  const client = oauthClient();
  const tokens = await tokenRequest({
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
    grant_type: 'authorization_code'
  });
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and try again.');
  }
  const creds: GoogleCreds = {
    refreshToken: tokens.refresh_token,
    accessToken: typeof tokens.access_token === 'string' ? tokens.access_token : '',
    expiry: Date.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000,
    email: decodeIdTokenEmail(tokens.id_token)
  };
  try { creds.projectId = await ensureProject(creds.accessToken); } catch { }
  saveCreds(creds);
  return { email: creds.email };
}

export async function handleCallbackUrl(pasted: string): Promise<{ email?: string }> {
  let url: URL;
  try { url = new URL(pasted.trim()); }
  catch { throw new Error('Paste the full URL from the Google redirect page.'); }
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Google returned: ${error}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('The URL is missing the Google authorization code or state.');
  return handleCallback(code, state);
}

export async function getAccessToken(): Promise<string> {
  const creds = loadCreds();
  if (!creds) throw new Error('Sign in with Google on the Antigravity connector first.');
  if (creds.accessToken && creds.expiry - 60_000 > Date.now()) return creds.accessToken;
  const client = oauthClient();
  const tokens = await tokenRequest({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token'
  });
  const next: GoogleCreds = {
    ...creds,
    accessToken: typeof tokens.access_token === 'string' ? tokens.access_token : '',
    expiry: Date.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000
  };
  if (!next.accessToken) throw new Error('Google token refresh returned no access token.');
  saveCreds(next);
  return next.accessToken;
}

export async function getProjectId(): Promise<string | undefined> {
  const creds = loadCreds();
  if (!creds) return undefined;
  if (creds.projectId) return creds.projectId;
  try {
    const projectId = await ensureProject(await getAccessToken());
    if (projectId) saveCreds({ ...loadCreds()!, projectId });
    return projectId;
  } catch {
    return undefined;
  }
}
