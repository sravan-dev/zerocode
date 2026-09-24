import express from 'express';
import path from 'path';
import { AppConfig } from './types';
import { Router } from './router';
import { LogStore } from './logs';
import { createProxyHandlers } from './proxy';
import { mountAdmin } from './admin-api';
import { handleCallback, OAUTH_CALLBACK_PATH } from './google-auth';

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

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-api-key,x-requested-with,x-opencode-session');
    res.setHeader('Access-Control-Expose-Headers', 'x-token-route-candidate,x-token-route-provider');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '8mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, app: 'token-route' });
  });

  const proxy = createProxyHandlers({ getConfig: deps.getConfig, router: deps.router, logs: deps.logs });
  app.get('/v1/models', proxy.listModels);
  app.post('/v1/chat/completions', (req, res, next) => {
    proxy.chatCompletions(req, res).catch(next);
  });

  app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
    const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const page = (title: string, body: string) =>
      '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
      '<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h2>' + title + '</h2><p>' + body + '</p></div></body>';
    const q = req.query as Record<string, string>;
    if (q.error) {
      res.status(400).send(page('Sign-in cancelled', 'Google returned: ' + escHtml(String(q.error))));
      return;
    }
    if (typeof q.code !== 'string' || typeof q.state !== 'string') {
      res.status(400).send(page('Sign-in failed', 'Missing code or state in the callback.'));
      return;
    }
    try {
      const r = await handleCallback(q.code, q.state);
      res.send(page('Signed in', 'Google account ' + escHtml(r.email || '') + ' connected to Token Route. You can close this tab.'));
    } catch (e: any) {
      res.status(500).send(page('Sign-in failed', escHtml(String(e?.message || e))));
    }
  });

  mountAdmin(app, deps);

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status === 400 && err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
      return;
    }
    res.status(status).json({ error: { message: String(err?.message || err), type: 'token_route_error' } });
  });

  return app;
}
