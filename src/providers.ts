import { ProviderConfig } from './types';
import { ANTIGRAVITY_MODELS } from './antigravity';
import { getAccessToken } from './google-auth';

export interface UpstreamModel {
  id: string;
  name?: string;
  free?: boolean;
  context?: number;
}

export function providerHeaders(p: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (p.apiKey) h['authorization'] = `Bearer ${p.apiKey}`;
  if (p.type === 'openrouter') {
    h['http-referer'] = 'http://127.0.0.1';
    h['x-title'] = 'Token Route';
  }
  if (p.type === 'opencode') {
    // OpenCode Go asks clients to identify themselves rather than use a generic SDK UA.
    h['user-agent'] = 'token-route/0.1.0';
  }
  return h;
}

function isFreeModel(m: any): boolean {
  if (typeof m?.id === 'string' && (m.id.endsWith(':free') || m.id.endsWith('-free'))) return true;
  const pr = m?.pricing;
  if (pr && Number(pr.prompt) === 0 && Number(pr.completion) === 0) return true;
  return false;
}

export async function listUpstreamModels(p: ProviderConfig, timeoutMs = 15000): Promise<UpstreamModel[]> {
  if (p.type === 'antigravity') return ANTIGRAVITY_MODELS.slice();
  const url = p.baseUrl.replace(/\/+$/, '') + '/models';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: providerHeaders(p), signal: ac.signal });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${(text || r.statusText || '').slice(0, 200)}`);
    }
    const j: any = await r.json();
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const out: UpstreamModel[] = [];
    const seen = new Set<string>();
    for (const m of arr) {
      const id = typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: typeof m?.display_name === 'string' ? m.display_name : undefined,
        free: isFreeModel(m),
        context:
          typeof m?.context_length === 'number'
            ? m.context_length
            : typeof m?.top_provider?.context_length === 'number'
              ? m.top_provider.context_length
              : undefined
      });
    }
    out.sort((a, b) => (b.free === true ? 1 : 0) - (a.free === true ? 1 : 0) || a.id.localeCompare(b.id));
    return out;
  } finally {
    clearTimeout(t);
  }
}

export async function testProvider(p: ProviderConfig): Promise<{ ok: boolean; ms: number; count: number; error?: string }> {
  const t0 = Date.now();
  try {
    if (p.type === 'antigravity') {
      await getAccessToken();
      return { ok: true, ms: Date.now() - t0, count: ANTIGRAVITY_MODELS.length };
    }
    const models = await listUpstreamModels(p, 12000);
    return { ok: true, ms: Date.now() - t0, count: models.length };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, count: 0, error: String(e?.message || e) };
  }
}
