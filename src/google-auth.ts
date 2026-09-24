import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { configDir } from './config';

// Installed-app OAuth client credentials, supplied via environment so they are never committed.
function oauthClient(): { id: string; secret: string } {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || '';
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '';
  if (!id || !secret) {
    throw new Error('Google sign-in is not configured: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET');
  }
  return { id, secret };
}

export function googleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() && process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim());
}
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
export const OAUTH_CALLBACK_PATH = '/oauth2callback';

const CLIENT_METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };

export interface GoogleCreds {
  refreshToken: string;
  accessToken: string;
  expiry: number;
  email?: string;
  projectId?: string;
}

let cached: GoogleCreds | null | undefined;
const pendingStates = new Map<string, { redirectUri: string; createdAt: number }>();

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

function saveCreds(c: GoogleCreds): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(credsPath(), JSON.stringify(c, null, 2));
  cached = c;
}

export function clearCreds(): void {
  cached = null;
  try {
    fs.unlinkSync(credsPath());
  } catch { }
}

export function isAuthenticated(): boolean {
  return !!loadCreds();
}

export function authStatus(): { authenticated: boolean; email?: string; projectId?: string } {
  const c = loadCreds();
  if (!c) return { authenticated: false };
  return { authenticated: true, email: c.email, projectId: c.projectId };
}

export function beginLogin(port: number): { url: string } {
  // Prune stale states (>10 min)
  const now = Date.now();
  for (const [k, v] of pendingStates) if (now - v.createdAt > 600000) pendingStates.delete(k);
  const state = randomBytes(16).toString('hex');
  const redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
  pendingStates.set(state, { redirectUri, createdAt: now });
  const params = new URLSearchParams({
    client_id: oauthClient().id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
    state
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
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j) {
    throw new Error(`Google token endpoint HTTP ${r.status}: ${String(j?.error_description || j?.error || '').slice(0, 200)}`);
  }
  return j;
}

async function codeAssistCall(accessToken: string, method: string, body: unknown): Promise<any> {
  const r = await fetch(`${CODE_ASSIST_URL}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`${method} HTTP ${r.status}: ${String(j?.error?.message || '').slice(0, 200)}`);
  }
  return j;
}

// Discover (or onboard onto) the managed Code Assist project for this Google account.
async function ensureProject(accessToken: string): Promise<string | undefined> {
  const load = await codeAssistCall(accessToken, 'loadCodeAssist', { metadata: CLIENT_METADATA });
  if (typeof load?.cloudaicompanionProject === 'string' && load.cloudaicompanionProject) {
    return load.cloudaicompanionProject;
  }
  const tiers: any[] = Array.isArray(load?.allowedTiers) ? load.allowedTiers : [];
  const tierId = tiers.find((t) => t?.isDefault)?.id || 'free-tier';
  for (let i = 0; i < 15; i++) {
    const lro = await codeAssistCall(accessToken, 'onboardUser', { tierId, metadata: CLIENT_METADATA });
    if (lro?.done) {
      const id = lro?.response?.cloudaicompanionProject?.id;
      return typeof id === 'string' && id ? id : undefined;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

export async function handleCallback(code: string, state: string): Promise<{ email?: string }> {
  const pending = pendingStates.get(state);
  if (!pending) throw new Error('unknown or expired OAuth state - restart the sign-in from the dashboard');
  pendingStates.delete(state);
  const client = oauthClient();
  const tok = await tokenRequest({
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: pending.redirectUri,
    grant_type: 'authorization_code'
  });
  if (typeof tok.refresh_token !== 'string' || !tok.refresh_token) {
    throw new Error('Google did not return a refresh token - remove app access at myaccount.google.com/permissions and retry');
  }
  const creds: GoogleCreds = {
    refreshToken: tok.refresh_token,
    accessToken: typeof tok.access_token === 'string' ? tok.access_token : '',
    expiry: Date.now() + (typeof tok.expires_in === 'number' ? tok.expires_in : 3600) * 1000,
    email: decodeIdTokenEmail(tok.id_token)
  };
  try {
    creds.projectId = await ensureProject(creds.accessToken);
  } catch {
    // Non-fatal: retried lazily on first request.
  }
  saveCreds(creds);
  return { email: creds.email };
}

// For remote deployments: Google always redirects to http://localhost:<port>/oauth2callback,
// which won't load when the gateway runs on a server. The user copies that URL from the
// browser address bar and pastes it into the dashboard instead.
export async function handleCallbackUrl(pasted: string): Promise<{ email?: string }> {
  let u: URL;
  try {
    u = new URL(pasted.trim());
  } catch {
    throw new Error('not a valid URL - paste the full address from the browser bar');
  }
  const err = u.searchParams.get('error');
  if (err) throw new Error('Google returned: ' + err);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (!code || !state) throw new Error('URL is missing code or state');
  return handleCallback(code, state);
}

export async function getAccessToken(): Promise<string> {
  const c = loadCreds();
  if (!c) throw new Error('not signed in with Google - open the dashboard and sign in on the Antigravity provider');
  if (c.accessToken && c.expiry - 60000 > Date.now()) return c.accessToken;
  const client = oauthClient();
  const tok = await tokenRequest({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token'
  });
  const next: GoogleCreds = {
    ...c,
    accessToken: typeof tok.access_token === 'string' ? tok.access_token : '',
    expiry: Date.now() + (typeof tok.expires_in === 'number' ? tok.expires_in : 3600) * 1000
  };
  if (!next.accessToken) throw new Error('Google token refresh returned no access token');
  saveCreds(next);
  return next.accessToken;
}

export async function getProjectId(): Promise<string | undefined> {
  const c = loadCreds();
  if (!c) return undefined;
  if (c.projectId) return c.projectId;
  try {
    const token = await getAccessToken();
    const pid = await ensureProject(token);
    if (pid) saveCreds({ ...(loadCreds() as GoogleCreds), projectId: pid });
    return pid;
  } catch {
    return undefined;
  }
}
