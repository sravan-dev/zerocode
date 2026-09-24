import fs from 'fs';
import path from 'path';
import { AppConfig, ProviderConfig, PROVIDER_TYPES, RouteCandidate } from './types';

export const VERSION = '0.1.0';

const DEFAULT_ROUTE: RouteCandidate[] = [
  { provider: 'antigravity', model: 'gemini-3-pro-preview' },
  { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  { provider: 'gemini', model: 'gemini-2.0-flash' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' }
];

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'openrouter', name: 'OpenRouter', type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', enabled: true },
  { id: 'groq', name: 'Groq', type: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', enabled: true },
  { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', enabled: true },
  // GitHub Models ('github' type) retired by GitHub on 2026-07-30; kept in PROVIDER_TYPES only so old configs still load.
  { id: 'antigravity', name: 'Google Antigravity', type: 'antigravity', baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal', apiKey: '', enabled: true },
  { id: 'opencode', name: 'OpenCode Zen', type: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', apiKey: '', enabled: true },
  { id: 'opencode-go', name: 'OpenCode Go', type: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '', enabled: true }
];

export function defaultConfig(): AppConfig {
  return {
    port: 3777,
    host: '127.0.0.1',
    proxyKey: null,
    strategy: 'failover',
    cooldownMs: 60000,
    requestTimeoutMs: 180000,
    routeName: 'token-route',
    route: DEFAULT_ROUTE,
    providers: DEFAULT_PROVIDERS
  };
}

export function configDir(): string {
  return process.env.TOKEN_ROUTE_HOME || path.resolve(process.cwd(), 'data');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

// Env vars win over config.json so container platforms (Coolify, Docker) can set
// bind address, port and an initial proxy key without editing the file.
function applyEnv(cfg: AppConfig): AppConfig {
  const host = process.env.HOST?.trim();
  if (host) cfg.host = host;
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0 && port < 65536) cfg.port = port;
  const key = process.env.TOKEN_ROUTE_PROXY_KEY?.trim();
  if (key && !cfg.proxyKey) cfg.proxyKey = key;
  return cfg;
}

export function loadConfig(): AppConfig {
  return applyEnv(readConfigFile());
}

function readConfigFile(): AppConfig {
  const file = configPath();
  if (!fs.existsSync(file)) return defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cfg = defaultConfig();
    if (typeof raw.port === 'number') cfg.port = raw.port;
    if (typeof raw.host === 'string' && raw.host.trim()) cfg.host = raw.host.trim();
    if (raw.proxyKey === null) cfg.proxyKey = null;
    else if (typeof raw.proxyKey === 'string' && raw.proxyKey.trim()) cfg.proxyKey = raw.proxyKey.trim();
    if (raw.strategy === 'failover' || raw.strategy === 'round-robin') cfg.strategy = raw.strategy;
    if (typeof raw.cooldownMs === 'number' && raw.cooldownMs > 0) cfg.cooldownMs = raw.cooldownMs;
    if (typeof raw.requestTimeoutMs === 'number' && raw.requestTimeoutMs > 0) cfg.requestTimeoutMs = raw.requestTimeoutMs;
    if (typeof raw.routeName === 'string' && raw.routeName.trim()) cfg.routeName = raw.routeName.trim();
    if (Array.isArray(raw.route)) {
      cfg.route = raw.route
        .filter((c: any) => c && typeof c.provider === 'string' && typeof c.model === 'string' && c.provider && c.model)
        .map((c: any) => ({ provider: c.provider, model: c.model }));
    }
    if (Array.isArray(raw.providers)) {
      cfg.providers = raw.providers
        .filter((p: any) => p && typeof p.id === 'string' && p.id && /^[a-z0-9-_]{1,40}$/i.test(p.id))
        .map((p: any) => ({
          id: p.id,
          name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id,
          type: PROVIDER_TYPES.includes(p.type) ? p.type : 'custom',
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
          apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
          enabled: p.enabled !== false
        }));
      for (const builtin of ['antigravity', 'opencode', 'opencode-go'] as const) {
        if (!cfg.providers.some((p) => p.id === builtin)) {
          cfg.providers.push(DEFAULT_PROVIDERS.find((p) => p.id === builtin)!);
        }
      }
    }
    return cfg;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg: AppConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

export interface ConfigUpdate {
  port?: unknown;
  host?: unknown;
  proxyKey?: unknown;
  strategy?: unknown;
  cooldownMs?: unknown;
  requestTimeoutMs?: unknown;
  routeName?: unknown;
  route?: unknown;
  providers?: unknown;
}

export function applyPartial(cfg: AppConfig, u: ConfigUpdate): { restartRequired: boolean } {
  let restartRequired = false;
  if (typeof u.port === 'number' && Number.isInteger(u.port) && u.port > 0 && u.port < 65536 && u.port !== cfg.port) {
    cfg.port = u.port;
    restartRequired = true;
  }
  if (typeof u.host === 'string' && u.host.trim() && u.host.trim() !== cfg.host) {
    cfg.host = u.host.trim();
    restartRequired = true;
  }
  if (u.proxyKey === null) cfg.proxyKey = null;
  else if (typeof u.proxyKey === 'string') {
    const k = u.proxyKey.trim();
    if (k) cfg.proxyKey = k;
  }
  if (u.strategy === 'failover' || u.strategy === 'round-robin') cfg.strategy = u.strategy;
  if (typeof u.cooldownMs === 'number' && u.cooldownMs >= 1000 && u.cooldownMs <= 3600000) cfg.cooldownMs = Math.round(u.cooldownMs);
  if (typeof u.requestTimeoutMs === 'number' && u.requestTimeoutMs >= 5000 && u.requestTimeoutMs <= 600000) cfg.requestTimeoutMs = Math.round(u.requestTimeoutMs);
  if (typeof u.routeName === 'string') cfg.routeName = u.routeName.trim().slice(0, 64) || 'token-route';
  if (Array.isArray(u.route)) {
    const seen = new Set<string>();
    const next: RouteCandidate[] = [];
    for (const item of u.route as any[]) {
      if (item && typeof item.provider === 'string' && typeof item.model === 'string' && item.provider && item.model) {
        const k = item.provider + '::' + item.model;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ provider: item.provider, model: item.model.slice(0, 200) });
      }
    }
    cfg.route = next;
  }
  if (Array.isArray(u.providers)) {
    const byId = new Map(cfg.providers.map((p) => [p.id, p]));
    const next: ProviderConfig[] = [];
    const ids = new Set<string>();
    for (const raw of u.providers as any[]) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || !/^[a-z0-9-_]{1,40}$/i.test(raw.id)) continue;
      if (ids.has(raw.id)) continue;
      ids.add(raw.id);
      const prev = byId.get(raw.id);
      const type: string = PROVIDER_TYPES.includes(raw.type) ? raw.type : prev ? prev.type : 'custom';
      const apiKey = raw.apiKey === undefined ? (prev ? prev.apiKey : '') : String(raw.apiKey ?? '');
      const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : prev ? prev.baseUrl : '';
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : prev ? prev.name : raw.id;
      const enabled = raw.enabled === undefined ? (prev ? prev.enabled : true) : !!raw.enabled;
      next.push({ id: raw.id, name, type: type as ProviderConfig['type'], baseUrl, apiKey, enabled });
    }
    cfg.providers = next;
    cfg.route = cfg.route.filter((c) => ids.has(c.provider));
  }
  return { restartRequired };
}
