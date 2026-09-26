import { Express, Request, Response, NextFunction, Router as ExRouter } from 'express';
import { AppConfig } from './types';
import { Router } from './router';
import { LogStore } from './logs';
import { listUpstreamModels, testProvider } from './providers';
import { hasProxyKey } from './proxy';
import { dbEnabled } from './db';
import { maskKey } from './utils';
import { VERSION } from './config';
import { authStatus, beginLogin, clearCreds, handleCallbackUrl, isAuthenticated, saveOAuthClientConfig } from './google-auth';

export interface AdminDeps {
  getConfig(): AppConfig;
  updateConfig(partial: any): { restartRequired: boolean };
  router: Router;
  logs: LogStore;
  startedAt: number;
}

function sanitizedConfig(cfg: AppConfig) {
  return {
    port: cfg.port,
    host: cfg.host,
    hasProxyKey: !!cfg.proxyKey,
    proxyKeyMasked: cfg.proxyKey ? maskKey(cfg.proxyKey) : null,
    strategy: cfg.strategy,
    cooldownMs: cfg.cooldownMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
    routeName: cfg.routeName,
    route: cfg.route,
    providers: cfg.providers.map((p) => {
      const google = p.type === 'antigravity' || p.id === 'antigravity' ? authStatus() : undefined;
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        hasKey: google ? google.authenticated : !!p.apiKey,
        keyHint: google ? google.email || '' : p.apiKey ? maskKey(p.apiKey) : '',
        google
      };
    })
  };
}

export function mountAdmin(app: Express, deps: AdminDeps): void {
  const { getConfig, updateConfig, router, logs, startedAt } = deps;

  // Gateway admin: the proxy key, a signed-in admin, or (single-user mode with no key) anyone.
  const authGate = (req: Request, res: Response, next: NextFunction) => {
    const cfg = getConfig();
    if (hasProxyKey(req, cfg) || req.user?.role === 'admin' || (!dbEnabled() && !cfg.proxyKey)) return next();
    return res.status(req.user ? 403 : 401).json({ error: req.user ? 'Admin only' : 'Sign in as an admin, or send the ZeroCode API key' });
  };

  const api = ExRouter();
  api.use(authGate);

  api.get('/status', (_req, res) => {
    const cfg = getConfig();
    res.json({
      app: 'zerocode',
      version: VERSION,
      uptimeMs: Date.now() - startedAt,
      host: cfg.host,
      port: cfg.port,
      strategy: cfg.strategy,
      routeName: cfg.routeName,
      routeCount: cfg.route.length,
      providers: cfg.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled, hasKey: !!p.apiKey }))
    });
  });

  api.use(authGate);

  api.get('/config', (_req, res) => {
    res.json(sanitizedConfig(getConfig()));
  });

  api.put('/config', (req, res) => {
    const result = updateConfig(req.body || {});
    res.json({ ...sanitizedConfig(getConfig()), restartRequired: result.restartRequired });
  });

  api.post('/providers/test', async (req, res) => {
    const cfg = getConfig();
    const p = cfg.providers.find((x) => x.id === (req.body || {}).id);
    if (!p) return res.status(404).json({ error: 'provider not found' });
    const antigravity = p.type === 'antigravity' || p.id === 'antigravity';
    if (antigravity && !isAuthenticated()) return res.json({ ok: false, ms: 0, count: 0, error: 'Sign in with Google first' });
    if (!p.apiKey && p.type !== 'custom' && !antigravity) return res.json({ ok: false, ms: 0, count: 0, error: 'No API key set' });
    const result = await testProvider(p);
    res.json(result);
  });

  api.get('/providers/:id/models', async (req, res) => {
    const cfg = getConfig();
    const p = cfg.providers.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'provider not found' });
    const antigravity = p.type === 'antigravity' || p.id === 'antigravity';
    if (antigravity && !isAuthenticated()) return res.status(400).json({ error: 'Sign in with Google first' });
    if (!p.apiKey && p.type !== 'custom' && !antigravity) return res.status(400).json({ error: 'No API key set for this provider' });
    try {
      const models = await listUpstreamModels(p);
      res.json({ provider: p.id, models });
    } catch (e: any) {
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  api.get('/google/status', (_req, res) => {
    res.json(authStatus());
  });

  api.put('/google/client', (req, res) => {
    const body = req.body || {};
    try {
      saveOAuthClientConfig(String(body.clientId || ''), String(body.clientSecret || ''));
      res.json(authStatus());
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  api.post('/google/login', (_req, res) => {
    try { res.json(beginLogin(getConfig().port)); }
    catch (e: any) { res.status(400).json({ error: String(e?.message || e) }); }
  });

  api.post('/google/callback', async (req, res) => {
    const url = (req.body || {}).url;
    if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'Paste the full URL from the Google redirect page.' });
    try {
      const result = await handleCallbackUrl(url);
      res.json({ ok: true, email: result.email });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  api.post('/google/logout', (_req, res) => {
    clearCreds();
    res.json({ ok: true });
  });

  api.get('/health', (_req, res) => {
    res.json({ candidates: router.healthView(getConfig()) });
  });

  api.get('/logs', (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const errorsOnly = req.query.errors === '1' || req.query.errors === 'true';
    let list = logs.recent(limit);
    if (errorsOnly) list = list.filter((l) => !l.ok);
    res.json({ logs: list });
  });

  api.post('/logs/clear', (_req, res) => {
    logs.clear();
    res.json({ ok: true });
  });

  api.get('/stats', (_req, res) => {
    res.json(logs.stats());
  });

  app.use('/api', api);
}
