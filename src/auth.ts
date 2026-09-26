import { Express, NextFunction, Request, Response, Router as ExRouter } from 'express';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { ObjectId } from 'mongodb';
import { chats, dbEnabled, Role, sessions, UserDoc, users } from './db';
import { googleOAuthClient } from './google-auth';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const SESSION_COOKIE = 'zc_session';
const GOOGLE_STATE_COOKIE = 'zc_gstate';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserDoc['status'];
  signIn: string[];
  createdAt: string;
  lastLoginAt?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

function publicUser(u: UserDoc): PublicUser {
  const signIn: string[] = [];
  if (u.passwordHash) signIn.push('password');
  if (u.googleSub) signIn.push('google');
  return {
    id: u._id.toHexString(),
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    signIn,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString()
  };
}

// ---------- passwords ----------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
const cleanName = (v: unknown, email: string) => String(v ?? '').trim().slice(0, 60) || email.split('@')[0];

function superAdmins(): Set<string> {
  return new Set((process.env.SUPER_ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean));
}
const isSuperAdmin = (email: string) => superAdmins().has(email);

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https' || (process.env.PUBLIC_URL || '').startsWith('https://');
}

function setCookie(req: Request, res: Response, name: string, value: string, maxAgeSec: number): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function publicBase(req: Request): string {
  const env = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (env) return env;
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
}

/** Only same-site relative paths, so a login link can't bounce users to another site. */
function safeNext(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/zerocode/';
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function startSession(req: Request, res: Response, user: UserDoc): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await sessions().insertOne({
    _id: new ObjectId(),
    tokenHash: sha256(token),
    userId: user._id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400_000)
  });
  await users().updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
  setCookie(req, res, SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

/** Super-admin emails always hold the admin role, so they can't be locked out by a demotion. */
async function ensureRole(user: UserDoc): Promise<UserDoc> {
  if (isSuperAdmin(user.email) && (user.role !== 'admin' || user.status !== 'active')) {
    await users().updateOne({ _id: user._id }, { $set: { role: 'admin', status: 'active' } });
    return { ...user, role: 'admin', status: 'active' };
  }
  return user;
}

// Simple brute-force guard: 10 failed logins per email+IP per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
function throttled(key: string): boolean {
  const f = failures.get(key);
  return !!f && f.until > Date.now() && f.count >= 10;
}
function noteFailure(key: string): void {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else f.count++;
  if (failures.size > 10_000) for (const [k, v] of failures) if (v.until < Date.now()) failures.delete(k);
}

// ---------- middleware ----------
/** Attach req.user when the request carries a valid session cookie. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!dbEnabled()) return next();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return next();
  try {
    const s = await sessions().findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
    if (s) {
      const u = await users().findOne({ _id: s.userId });
      if (u && u.status === 'active') req.user = publicUser(u);
    }
  } catch (e) {
    console.error('session lookup failed:', e);
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in required' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'admin') return next();
  res.status(req.user ? 403 : 401).json({ error: req.user ? 'Admin only' : 'Sign in required' });
}

// ---------- routes ----------
/** Express 4 ignores rejected promises from handlers; this router forwards them to the error handler. */
function asyncRouter(): ExRouter {
  const r = ExRouter();
  for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const orig = (r as any)[m].bind(r);
    (r as any)[m] = (path: string, ...handlers: any[]) =>
      orig(path, ...handlers.map((fn) => (req: Request, res: Response, next: NextFunction) => {
        try {
          const out = fn(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (e) {
          next(e);
        }
      }));
  }
  return r;
}

export function mountAuth(app: Express): void {
  const auth = asyncRouter();

  auth.get('/config', (_req, res) => {
    res.json({ google: !!googleOAuthClient() });
  });

  auth.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    res.json({ user: req.user });
  });

  auth.post('/register', async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    const existing = await users().findOne({ email });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    const user: UserDoc = {
      _id: new ObjectId(),
      email,
      name: cleanName(req.body?.name, email),
      passwordHash: await hashPassword(password),
      role: isSuperAdmin(email) ? 'admin' : 'user',
      status: 'active',
      createdAt: new Date()
    };
    try {
      await users().insertOne(user);
    } catch (e: any) {
      if (e?.code === 11000) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
      throw e;
    }
    await startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });

  auth.post('/login', async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const key = `${req.ip}|${email}`;
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    let user = await users().findOne({ email });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      noteFailure(key);
      const hint = user && !user.passwordHash && user.googleSub ? ' This account uses Google sign-in.' : '';
      return res.status(401).json({ error: 'Wrong email or password.' + hint });
    }
    user = await ensureRole(user);
    if (user.status !== 'active') return res.status(403).json({ error: 'This account has been disabled. Contact the administrator.' });
    failures.delete(key);
    await startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });

  auth.post('/logout', async (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await sessions().deleteOne({ tokenHash: sha256(token) }).catch(() => { });
    setCookie(req, res, SESSION_COOKIE, '', 0);
    res.json({ ok: true });
  });

  // Google sign-in (openid/email/profile only: no sensitive scopes, so no "unverified app" screen).
  auth.get('/google', (req, res) => {
    const client = googleOAuthClient();
    if (!client) return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not configured yet.'));
    const state = randomBytes(24).toString('hex');
    setCookie(req, res, GOOGLE_STATE_COOKIE, `${state}|${safeNext(req.query.next)}`, 600);
    const params = new URLSearchParams({
      client_id: client.id,
      redirect_uri: `${publicBase(req)}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account'
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  auth.get('/google/callback', async (req, res) => {
    const fail = (msg: string) => res.redirect('/login?error=' + encodeURIComponent(msg));
    const [savedState, next] = (parseCookies(req)[GOOGLE_STATE_COOKIE] || '').split('|');
    setCookie(req, res, GOOGLE_STATE_COOKIE, '', 0);
    if (req.query.error) return fail('Google sign-in was cancelled.');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || !savedState || req.query.state !== savedState) return fail('Google sign-in expired. Please try again.');
    const client = googleOAuthClient();
    if (!client) return fail('Google sign-in is not configured yet.');
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: client.id,
          client_secret: client.secret,
          redirect_uri: `${publicBase(req)}/auth/google/callback`,
          grant_type: 'authorization_code'
        })
      });
      const tok: any = await r.json().catch(() => ({}));
      if (!r.ok || typeof tok.id_token !== 'string') return fail('Google sign-in failed. Please try again.');
      // The ID token came straight from Google's token endpoint over TLS, so its claims can be read directly.
      const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1] || '', 'base64url').toString('utf8'));
      const iss = String(claims.iss || '');
      if (claims.aud !== client.id || (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com')) return fail('Google sign-in failed. Please try again.');
      const email = normEmail(claims.email);
      if (!email || claims.email_verified !== true) return fail('Your Google account email is not verified.');
      const sub = String(claims.sub);

      let user = await users().findOne({ $or: [{ googleSub: sub }, { email }] });
      if (!user) {
        user = {
          _id: new ObjectId(),
          email,
          name: cleanName(claims.name, email),
          googleSub: sub,
          role: isSuperAdmin(email) ? 'admin' : 'user',
          status: 'active',
          createdAt: new Date()
        };
        await users().insertOne(user);
      } else if (!user.googleSub) {
        // Google verified this email, so link it to the existing password account.
        await users().updateOne({ _id: user._id }, { $set: { googleSub: sub } });
        user.googleSub = sub;
      }
      user = await ensureRole(user);
      if (user.status !== 'active') return fail('This account has been disabled. Contact the administrator.');
      await startSession(req, res, user);
      res.redirect(safeNext(next));
    } catch (e) {
      console.error('google sign-in failed:', e);
      fail('Google sign-in failed. Please try again.');
    }
  });

  app.use('/auth', auth);

  // ---------- the signed-in user's chats ----------
  const me = asyncRouter();
  me.use(requireUser);

  me.get('/chats', async (req, res) => {
    const list = await chats().find({ userId: new ObjectId(req.user!.id) }).sort({ updated: -1 }).limit(1000).toArray();
    res.json({ chats: list.map((c) => c.data) });
  });

  me.put('/chats/:id', async (req, res) => {
    const chatId = String(req.params.id).slice(0, 64);
    const data = req.body;
    if (!data || typeof data !== 'object' || data.id !== chatId || !Array.isArray(data.messages)) {
      return res.status(400).json({ error: 'Invalid chat' });
    }
    await chats().updateOne(
      { userId: new ObjectId(req.user!.id), chatId },
      { $set: { title: String(data.title || '').slice(0, 200), updated: Number(data.updated) || Date.now(), data } },
      { upsert: true }
    );
    res.json({ ok: true });
  });

  me.delete('/chats/:id', async (req, res) => {
    await chats().deleteOne({ userId: new ObjectId(req.user!.id), chatId: String(req.params.id) });
    res.json({ ok: true });
  });

  me.delete('/chats', async (req, res) => {
    await chats().deleteMany({ userId: new ObjectId(req.user!.id) });
    res.json({ ok: true });
  });

  app.use('/api/me', me);

  // ---------- super admin: user management ----------
  const adm = asyncRouter();
  adm.use(requireAdmin);

  const idOf = (v: string) => (ObjectId.isValid(v) ? new ObjectId(v) : null);

  adm.get('/users', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const filter = q ? { $or: [{ email: { $regex: escapeRe(q), $options: 'i' } }, { name: { $regex: escapeRe(q), $options: 'i' } }] } : {};
    const list = await users().find(filter).sort({ createdAt: -1 }).limit(1000).toArray();
    const counts = await chats().aggregate<{ _id: ObjectId; n: number }>([{ $group: { _id: '$userId', n: { $sum: 1 } } }]).toArray();
    const byUser = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    res.json({
      users: list.map((u) => ({ ...publicUser(u), chats: byUser.get(u._id.toHexString()) || 0, superAdmin: isSuperAdmin(u.email) })),
      total: await users().countDocuments()
    });
  });

  adm.post('/users', async (req, res) => {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const role: Role = req.body?.role === 'admin' ? 'admin' : 'user';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    const user: UserDoc = {
      _id: new ObjectId(),
      email,
      name: cleanName(req.body?.name, email),
      passwordHash: await hashPassword(password),
      role: isSuperAdmin(email) ? 'admin' : role,
      status: 'active',
      createdAt: new Date()
    };
    try {
      await users().insertOne(user);
    } catch (e: any) {
      if (e?.code === 11000) return res.status(409).json({ error: 'A user with this email already exists.' });
      throw e;
    }
    res.json({ user: publicUser(user) });
  });

  adm.patch('/users/:id', async (req, res) => {
    const _id = idOf(req.params.id);
    const target = _id && (await users().findOne({ _id }));
    if (!target) return res.status(404).json({ error: 'User not found' });
    const body = req.body || {};
    const self = target._id.toHexString() === req.user!.id;
    const set: Partial<UserDoc> = {};
    if (typeof body.name === 'string') set.name = cleanName(body.name, target.email);
    if (body.role === 'admin' || body.role === 'user') {
      if (body.role !== 'admin' && (self || isSuperAdmin(target.email))) return res.status(400).json({ error: "You can't remove admin rights from this account." });
      set.role = body.role;
    }
    if (body.status === 'active' || body.status === 'blocked') {
      if (body.status === 'blocked' && (self || isSuperAdmin(target.email))) return res.status(400).json({ error: "You can't disable this account." });
      set.status = body.status;
    }
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
      set.passwordHash = await hashPassword(body.password);
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change' });
    await users().updateOne({ _id: target._id }, { $set: set });
    // Blocking or a password reset signs the user out everywhere.
    if (set.status === 'blocked' || set.passwordHash) await sessions().deleteMany({ userId: target._id });
    const updated = await users().findOne({ _id: target._id });
    res.json({ user: publicUser(updated!) });
  });

  adm.delete('/users/:id', async (req, res) => {
    const _id = idOf(req.params.id);
    const target = _id && (await users().findOne({ _id }));
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target._id.toHexString() === req.user!.id || isSuperAdmin(target.email)) return res.status(400).json({ error: "You can't delete this account." });
    await Promise.all([
      users().deleteOne({ _id: target._id }),
      sessions().deleteMany({ userId: target._id }),
      chats().deleteMany({ userId: target._id })
    ]);
    res.json({ ok: true });
  });

  app.use('/api/admin', adm);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
