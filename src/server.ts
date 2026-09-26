import express from 'express';
import path from 'path';
import { AppConfig } from './types';
import { Router } from './router';
import { LogStore } from './logs';
import { createProxyHandlers } from './proxy';
import { mountAdmin } from './admin-api';
import { handleCallback, OAUTH_CALLBACK_PATH } from './google-auth';
import { dbEnabled } from './db';
import { loadUser, mountAuth } from './auth';

export interface ServerDeps {
  getConfig(): AppConfig;
  updateConfig(partial: any): { restartRequired: boolean };
  router: Router;
  logs: LogStore;
  startedAt: number;
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind nginx: trust its X-Forwarded-* so req.ip and req.secure are the client's.
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-api-key,x-requested-with,x-opencode-session');
    res.setHeader('Access-Control-Expose-Headers', 'x-zerocode-candidate,x-zerocode-provider,x-zerocode-fallback');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '8mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, app: 'zerocode' });
  });

  const accounts = dbEnabled();
  const publicDir = path.join(__dirname, '..', 'public');

  if (accounts) {
    // Static assets don't need the user; everything else gets req.user from the session cookie.
    app.use((req, res, next) => {
      if (/\.(css|js|svg|png|ico|woff2?|map)$/.test(req.path)) return next();
      loadUser(req, res, next).catch(next);
    });
    mountAuth(app);
  }

  const proxy = createProxyHandlers({ getConfig: deps.getConfig, router: deps.router, logs: deps.logs });
  app.get('/v1/models', proxy.listModels);
  app.post('/v1/chat/completions', (req, res, next) => {
    proxy.chatCompletions(req, res).catch(next);
  });

  app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
    const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const page = (title: string, message: string) =>
      '<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h2>' + esc(title) + '</h2><p>' + esc(message) + '</p><p>You can close this tab and return to ZeroCode.</p></div></body>';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    if (error) { res.status(400).send(page('Google sign-in cancelled', error)); return; }
    if (!code || !state) { res.status(400).send(page('Google sign-in failed', 'The callback is missing its code or state.')); return; }
    try {
      const result = await handleCallback(code, state);
      res.send(page('Google account connected', result.email || 'Antigravity is ready to use.'));
    } catch (e: any) {
      res.status(400).send(page('Google sign-in failed', String(e?.message || e)));
    }
  });

  mountAdmin(app, deps);

  const toLogin = (req: express.Request, res: express.Response) =>
    res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));

  if (accounts) {
    app.get('/', (req, res) => res.redirect(302, req.user ? '/zerocode/' : '/login'));
    app.get('/login', (req, res) => {
      if (req.user) return res.redirect(302, typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/zerocode/');
      res.sendFile(path.join(publicDir, 'login.html'));
    });
    // The chat app needs a session; /manage is the super admin portal inside it.
    app.get(['/zerocode', '/zerocode/', '/zerocode/index.html'], (req, res, next) => (req.user ? next() : toLogin(req, res)));
    app.get('/manage', (req, res) => {
      if (!req.user) return toLogin(req, res);
      res.redirect(302, req.user.role === 'admin' ? '/zerocode/#/users' : '/zerocode/');
    });
    app.get('/dashboard', (req, res, next) => {
      if (!req.user) return toLogin(req, res);
      if (req.user.role !== 'admin') return res.redirect(302, '/zerocode/');
      next();
    });
  } else {
    // Single-user mode: Zero Code is the home page.
    app.get('/', (_req, res) => res.redirect(302, '/zerocode/'));
  }
  // The gateway admin dashboard lives at /dashboard.
  app.get('/dashboard', (req, res) => {
    // The dashboard uses relative asset paths, so keep it at /dashboard (no trailing slash).
    if (req.path.endsWith('/')) return res.redirect(301, '/dashboard');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  // Public legal pages linked from the Google OAuth consent screen.
  app.get('/privacy', (_req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
  app.get('/terms', (_req, res) => res.sendFile(path.join(publicDir, 'terms.html')));

  app.use(express.static(publicDir, { index: false }));
  app.use('/zerocode', express.static(path.join(publicDir, 'zerocode')));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500) console.error(err);
    if (status === 400 && err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
      return;
    }
    res.status(status).json({ error: { message: String(err?.message || err), type: 'zerocode_error' } });
  });

  return app;
}
