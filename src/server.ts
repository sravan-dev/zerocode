import express from 'express';
import path from 'path';
import { AppConfig } from './types';
import { Router } from './router';
import { LogStore } from './logs';
import { createProxyHandlers } from './proxy';
import { mountAdmin } from './admin-api';

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
