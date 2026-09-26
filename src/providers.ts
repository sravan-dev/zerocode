import { ProviderConfig } from './types';
import { listAntigravityModels } from './antigravity';

export interface UpstreamModel {
  id: string;
  name?: string;
  /** true = free, false = paid, undefined = unknown. */
  free?: boolean;
  /** USD per 1M input / output tokens, when the provider publishes it. */
  price?: { in: number; out: number };
  /** false for models that can't serve /chat/completions (speech, TTS, embeddings, classifiers, image gen). */
  chat?: boolean;
  context?: number;
}

export function providerHeaders(p: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (p.apiKey) h['authorization'] = `Bearer ${p.apiKey}`;
  if (p.type === 'openrouter') {
    h['http-referer'] = 'http://127.0.0.1';
    h['x-title'] = 'ZeroCode';
  }
  if (p.type === 'opencode') {
    // OpenCode Go asks clients to identify themselves rather than use a generic SDK UA.
    h['user-agent'] = 'zerocode/0.1.0';
  }
  return h;
}

const NON_CHAT_ID = /whisper|orpheus|playai-tts|\btts\b|-tts|text-to-speech|speech|transcri|distil-whisper|embed|embedding|rerank|prompt-guard|llama-guard|safeguard|moderation|dall-e|imagen|stable-diffusion|flux|sdxl|midjourney|image-gen|veo|sora|lyria|musicgen/i;

export function isChatModel(m: any): boolean {
  const id = String(m?.id ?? m?.name ?? '');
  const modality = String(m?.architecture?.output_modalities ?? m?.architecture?.modality ?? '').toLowerCase();
  if (modality && !modality.includes('text')) return false;
  const type = String(m?.type ?? m?.object_type ?? '').toLowerCase();
  if (type && /audio|embedding|image|rerank|moderation/.test(type)) return false;
  return !NON_CHAT_ID.test(id);
}

/** true = free, false = paid, undefined = the provider doesn't publish pricing. */
function isFreeModel(m: any): boolean | undefined {
  if (typeof m?.id === 'string' && (m.id.endsWith(':free') || m.id.endsWith('-free'))) return true;
  const price = modelPrice(m);
  if (!price) return undefined;
  return price.in === 0 && price.out === 0;
}

/** USD per 1M tokens, from OpenRouter-style per-token pricing. */
function modelPrice(m: any): { in: number; out: number } | undefined {
  const pr = m?.pricing;
  if (!pr) return undefined;
  const pin = Number(pr.prompt);
  const pout = Number(pr.completion);
  // Negative prices mark router/variable-priced entries (e.g. openrouter/auto).
  if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) return undefined;
  return { in: pin * 1e6, out: pout * 1e6 };
}

export async function listUpstreamModels(p: ProviderConfig, timeoutMs = 15000): Promise<UpstreamModel[]> {
  if (p.type === 'antigravity' || p.id === 'antigravity') return listAntigravityModels();
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
        price: modelPrice(m),
        chat: isChatModel(m),
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
    const models = await listUpstreamModels(p, 12000);
    return { ok: true, ms: Date.now() - t0, count: models.length };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, count: 0, error: String(e?.message || e) };
  }
}
