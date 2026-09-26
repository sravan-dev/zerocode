import { Request } from 'express';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { AppConfig, RouteCandidate } from './types';
import { providerHeaders } from './providers';
import { antigravityRequest } from './antigravity';
import { Router } from './router';
import { LogStore } from './logs';
import { retryAfterMs } from './utils';

function maxTokensCap(errorText: string): number | undefined {
  const m = /max_(?:completion_)?tokens`?\s*(?:must be|should be)?\s*(?:less than or equal to|<=|at most|no more than)\s*`?(\d+)/i.exec(errorText);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function base(p: { baseUrl: string }): string {
  return p.baseUrl.replace(/\/+$/, '');
}

function summarize(text: string): string {
  try {
    const j = JSON.parse(text);
    if (j && j.error && typeof j.error.message === 'string') return j.error.message;
    if (j && typeof j.message === 'string') return j.message;
  } catch { }
  return text;
}

export function checkAuth(req: Request, cfg: AppConfig): boolean {
  if (!cfg.proxyKey) return true;
  const auth = req.headers.authorization;
  const bearer = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xkey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : '';
  return bearer === cfg.proxyKey || xkey === cfg.proxyKey;
}

function sseRewriter(displayModel: string, hooks: { onUsage?: (u: any) => void; onFirstByte?: () => void }): Transform {
  let pending: Buffer = Buffer.alloc(0);
  let first = true;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (first) {
        first = false;
        hooks.onFirstByte?.();
      }
      const buf = Buffer.concat([pending, chunk]);
      const idx = buf.lastIndexOf(10);
      if (idx === -1) {
        pending = buf;
        cb();
        return;
      }
      const lines = buf.subarray(0, idx + 1).toString('utf8');
      pending = buf.subarray(idx + 1);
      const out = lines
        .split('\n')
        .map((line) => {
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (raw && raw !== '[DONE]') {
              try {
                const obj = JSON.parse(raw);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                  obj.model = displayModel;
                  if (obj.usage && hooks.onUsage) hooks.onUsage(obj.usage);
                  return 'data: ' + JSON.stringify(obj);
                }
              } catch { }
            }
          }
          return line;
        })
        .join('\n');
      cb(null, out);
    },
    flush(cb) {
      if (pending.length) cb(null, pending);
      else cb();
    }
  });
}

export interface ProxyDeps {
  getConfig(): AppConfig;
  router: Router;
  logs: LogStore;
}

export function createProxyHandlers(deps: ProxyDeps) {
  const { getConfig, router, logs } = deps;

  function listModels(req: Request, res: any) {
    const cfg = getConfig();
    if (!checkAuth(req, cfg)) {
      return res.status(401).json({ error: { message: 'Invalid API key for ZeroCode proxy', type: 'zerocode_auth' } });
    }
    const data: any[] = [{ id: 'auto', object: 'model', owned_by: 'zerocode' }];
    if (cfg.routeName && cfg.routeName !== 'auto') data.push({ id: cfg.routeName, object: 'model', owned_by: 'zerocode' });
    for (const c of cfg.route) {
      if (c.enabled === false) continue;
      const p = cfg.providers.find((x) => x.id === c.provider);
      if (!p || !p.enabled) continue;
      data.push({
        id: `${c.provider}/${c.model}`,
        object: 'model',
        owned_by: p.id,
        zerocode: { provider: c.provider, model: c.model }
      });
    }
    return res.json({ object: 'list', data });
  }

  async function chatCompletions(req: Request, res: any): Promise<void> {
    const cfg = getConfig();
    if (!checkAuth(req, cfg)) {
      res.status(401).json({ error: { message: 'Invalid API key for ZeroCode proxy', type: 'zerocode_auth' } });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      res.status(400).json({ error: { message: 'messages must be an array', type: 'invalid_request_error' } });
      return;
    }
    const requested = typeof body.model === 'string' && body.model ? body.model : 'auto';
    const stream = body.stream === true;
    const started = Date.now();
    // x-zerocode-strict: 1 pins the request to exactly the named model (used by Test buttons).
    const strict = req.headers['x-zerocode-strict'] === '1';
    const { candidates: chain, pinned } = router.resolve(requested, cfg, strict);
    // Healthy models only; cooling ones are tried only when nothing else is left.
    let usable = chain.filter((c) => (c === pinned && c.enabled === undefined ? router.providerReady(c, cfg) : router.isAvailable(c, cfg)));
    const hot = usable.filter((c) => !router.cooling(router.key(c)));
    if (hot.length) usable = hot;
    if (!usable.length) {
      logs.add({
        ts: started,
        requested,
        servedBy: undefined,
        candidate: undefined,
        provider: undefined,
        strategy: cfg.strategy,
        ok: false,
        httpStatus: 503,
        latencyMs: Date.now() - started,
        stream,
        attempts: 0,
        error: 'No route candidates available (missing API key or no models configured)'
      });
      res.status(503).json({
        error: {
          message: 'No route candidates available. Open the ZeroCode dashboard, add a provider API key and pick models.',
          type: 'zerocode_error'
        }
      });
      return;
    }

    let lastError = 'unknown';
    let attempts = 0;
    // Why the pinned model didn't answer, reported to the client when another model does.
    let pinnedFail = pinned && !usable.includes(pinned) ? 'cooling down after recent errors, or unavailable' : '';
    const flagFallback = (cand: RouteCandidate) => {
      if (!pinned || cand === pinned) return;
      const note = `${pinned.provider}/${pinned.model}: ${pinnedFail || 'unavailable'}`.slice(0, 300);
      res.set('x-zerocode-fallback', encodeURIComponent(note));
    };

    for (const [idx, cand] of usable.entries()) {
      if (idx > 0 && usable[idx - 1] === pinned) pinnedFail = lastError;
      attempts++;
      const p = cfg.providers.find((x) => x.id === cand.provider);
      if (!p) continue;
      const label = `${cand.provider}/${cand.model}`;
      const url = `${base(p)}/chat/completions`;
      const upstreamBody: Record<string, unknown> = { ...body, model: cand.model };
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.requestTimeoutMs);
      const headers: Record<string, string> = { ...providerHeaders(p), 'content-type': 'application/json' };
      if (p.type === 'opencode') {
        // OpenCode Go requires a stable per-conversation session id for routing/prompt caching.
        const fromClient = req.headers['x-opencode-session'];
        headers['x-opencode-session'] =
          typeof fromClient === 'string' && fromClient.trim()
            ? fromClient.trim().slice(0, 128)
            : createHash('sha256').update(JSON.stringify((body.messages as any[])[0] ?? '')).digest('hex').slice(0, 32);
      }
      const post = () => fetch(url, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: ac.signal });
      let r: any;
      try {
        r = p.type === 'antigravity' || p.id === 'antigravity'
          ? await antigravityRequest(cand.model, body, stream, ac.signal)
          : await post();
        if (r.status === 400) {
          // Some models cap max_tokens below what the client asked for; retry once with the stated limit.
          const text = await r.clone().text().catch(() => '');
          const cap = maxTokensCap(text);
          const asked = typeof upstreamBody.max_tokens === 'number' ? upstreamBody.max_tokens : typeof upstreamBody.max_completion_tokens === 'number' ? upstreamBody.max_completion_tokens : undefined;
          if (cap && asked && cap < asked) {
            if ('max_completion_tokens' in upstreamBody) upstreamBody.max_completion_tokens = cap;
            if ('max_tokens' in upstreamBody) upstreamBody.max_tokens = cap;
            r = await post();
          }
        }
      } catch (e: any) {
        clearTimeout(timer);
        lastError = `${p.name}: ${e?.name === 'AbortError' ? 'timed out' : 'network error'} (${String(e?.message || e).slice(0, 200)})`;
        router.markFailure(cand, 0, lastError, cfg);
        continue;
      }
      if (!r.ok) {
        const raMs = retryAfterMs(r);
        const text = await r.text().catch(() => '');
        clearTimeout(timer);
        lastError = `${p.name} HTTP ${r.status}: ${summarize(text).slice(0, 300)}`;
        router.markFailure(cand, raMs, lastError, cfg);
        // A 400/422 from one model is usually model-specific (wrong model type, unsupported param),
        // so keep walking the chain, pinned or not.
        continue;
      }
      if (!stream) {
        const json: any = await r.json().catch(() => null);
        clearTimeout(timer);
        if (!json || typeof json !== 'object' || !Array.isArray(json.choices)) {
          lastError = `${p.name}: invalid completion response from upstream`;
          router.markFailure(cand, 0, lastError, cfg);
          continue;
        }
        json.model = requested;
        router.markSuccess(cand);
        logs.add({
          ts: started,
          requested,
          servedBy: label,
          candidate: router.key(cand),
          provider: cand.provider,
          strategy: cfg.strategy,
          ok: true,
          httpStatus: 200,
          latencyMs: Date.now() - started,
          stream: false,
          tokensIn: json.usage?.prompt_tokens,
          tokensOut: json.usage?.completion_tokens,
          attempts,
          error: undefined
        });
        flagFallback(cand);
        res.set('x-zerocode-candidate', label);
        res.set('x-zerocode-provider', p.name);
        res.status(200).json(json);
        return;
      }
      const streamCt = (r.headers.get('content-type') || '').toLowerCase();
      if (!streamCt.includes('text/event-stream')) {
        // A 200 that isn't SSE is a broken/stub upstream (e.g. retired endpoints answering "OK").
        const text = await r.text().catch(() => '');
        clearTimeout(timer);
        lastError = `${p.name}: expected SSE stream, got ${streamCt || 'no content-type'}: ${summarize(text).slice(0, 200)}`;
        router.markFailure(cand, 0, lastError, cfg);
        continue;
      }
      clearTimeout(timer);
      const usageRef: { in?: number; out?: number; ttft?: number } = {};
      let logged = false;
      const logOnce = (ok: boolean, error?: string, httpStatus = 200) => {
        if (logged) return;
        logged = true;
        logs.add({
          ts: started,
          requested,
          servedBy: label,
          candidate: router.key(cand),
          provider: cand.provider,
          strategy: cfg.strategy,
          ok,
          httpStatus,
          latencyMs: Date.now() - started,
          ttftMs: usageRef.ttft,
          stream: true,
          tokensIn: usageRef.in,
          tokensOut: usageRef.out,
          attempts,
          error
        });
      };
      res.on('finish', () => logOnce(true));
      res.on('close', () => {
        ac.abort();
        logOnce(false, 'client closed connection');
      });
      res.status(200);
      res.set('content-type', r.headers.get('content-type') || 'text/event-stream; charset=utf-8');
      res.set('cache-control', 'no-cache');
      res.set('connection', 'keep-alive');
      res.set('x-accel-buffering', 'no');
      flagFallback(cand);
      res.set('x-zerocode-candidate', label);
      res.set('x-zerocode-provider', p.name);
      const nodeStream = r.body instanceof Readable ? r.body : Readable.fromWeb(r.body as any);
      const rewriter = sseRewriter(requested, {
        onFirstByte: () => {
          usageRef.ttft = Date.now() - started;
        },
        onUsage: (u) => {
          if (typeof u?.prompt_tokens === 'number') usageRef.in = u.prompt_tokens;
          if (typeof u?.completion_tokens === 'number') usageRef.out = u.completion_tokens;
        }
      });
      nodeStream.on('error', (e: any) => {
        try {
          res.write(`data: ${JSON.stringify({ error: { message: `upstream stream failed: ${String(e?.message || e).slice(0, 200)}`, type: 'zerocode_upstream_error' } })}\n\n`);
        } catch { }
        res.end();
        logOnce(false, `stream failed: ${String(e?.message || e).slice(0, 200)}`);
      });
      rewriter.on('error', () => { });
      nodeStream.pipe(rewriter).pipe(res);
      router.markSuccess(cand);
      return;
    }

    logs.add({
      ts: started,
      requested,
      servedBy: undefined,
      candidate: undefined,
      provider: undefined,
      strategy: cfg.strategy,
      ok: false,
      httpStatus: 502,
      latencyMs: Date.now() - started,
      stream,
      attempts,
      error: lastError
    });
    res.status(502).json({
      error: { message: `${attempts} of ${usable.length} candidate(s) tried, all failed. Last error: ${lastError}`, type: 'zerocode_upstream_error' }
    });
  }

  return { listModels, chatCompletions };
}
