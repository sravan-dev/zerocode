import { randomUUID } from 'crypto';
import { Readable, Transform } from 'stream';
import type { UpstreamModel } from './providers';
import { CODE_ASSIST_URL, getAccessToken, getProjectId } from './google-auth';

export const ANTIGRAVITY_MODELS: UpstreamModel[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Antigravity preview)', free: true, context: 1048576 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', free: true, context: 1048576 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', free: true, context: 1048576 },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', free: true, context: 1048576 }
];

function contentToParts(content: any): any[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push({ text: item.text });
    } else if (item.type === 'image_url' && typeof item.image_url?.url === 'string') {
      const m = /^data:([^;]+);base64,(.+)$/.exec(item.image_url.url);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
  }
  return parts;
}

// Translate an OpenAI chat.completions body into a Gemini generateContent request.
function openaiToGemini(body: any): any {
  const contents: any[] = [];
  const systemParts: any[] = [];
  for (const msg of body.messages as any[]) {
    if (!msg || typeof msg !== 'object') continue;
    const parts = contentToParts(msg.content);
    if (msg.role === 'system' || msg.role === 'developer') {
      systemParts.push(...parts);
    } else if (msg.role === 'assistant') {
      if (parts.length) contents.push({ role: 'model', parts });
    } else {
      // user / tool / anything else becomes a user turn
      if (parts.length) contents.push({ role: 'user', parts });
    }
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });
  const generationConfig: any = {};
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;
  const maxTokens = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : body.max_tokens;
  if (typeof maxTokens === 'number' && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
  if (typeof body.stop === 'string' && body.stop) generationConfig.stopSequences = [body.stop];
  else if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop.filter((s: any) => typeof s === 'string').slice(0, 5);
  const req: any = { contents };
  if (systemParts.length) req.systemInstruction = { role: 'user', parts: systemParts };
  if (Object.keys(generationConfig).length) req.generationConfig = generationConfig;
  return req;
}

function mapFinishReason(fr: unknown): string {
  switch (fr) {
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST': return 'content_filter';
    default: return 'stop';
  }
}

function candidateText(cand: any): string {
  const parts = cand?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const p of parts) {
    if (p && typeof p.text === 'string' && !p.thought) out += p.text;
  }
  return out;
}

function mapUsage(u: any): any | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return {
    prompt_tokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : 0,
    completion_tokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : 0,
    total_tokens: typeof u.totalTokenCount === 'number' ? u.totalTokenCount : 0
  };
}

function geminiToOpenAI(resp: any, model: string): any {
  const inner = resp?.response && typeof resp.response === 'object' ? resp.response : resp;
  const cand = Array.isArray(inner?.candidates) ? inner.candidates[0] : null;
  return {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: candidateText(cand) },
        finish_reason: mapFinishReason(cand?.finishReason)
      }
    ],
    usage: mapUsage(inner?.usageMetadata) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// Transform Gemini SSE (data: {response:{...}}) into OpenAI chat.completion.chunk SSE.
function geminiSseToOpenAI(model: string): Transform {
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  let pending = Buffer.alloc(0);
  let sentRole = false;
  let finished = false;
  let usage: any;
  const chunk = (delta: any, finish: string | null, withUsage?: any) => {
    const obj: any = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (withUsage) obj.usage = withUsage;
    return 'data: ' + JSON.stringify(obj) + '\n\n';
  };
  const handleLine = (line: string, push: (s: string) => void) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    const inner = obj?.response && typeof obj.response === 'object' ? obj.response : obj;
    const cand = Array.isArray(inner?.candidates) ? inner.candidates[0] : null;
    const u = mapUsage(inner?.usageMetadata);
    if (u) usage = u;
    const text = candidateText(cand);
    if (text) {
      const delta: any = sentRole ? { content: text } : { role: 'assistant', content: text };
      sentRole = true;
      push(chunk(delta, null));
    }
    if (cand?.finishReason && !finished) {
      finished = true;
      push(chunk({}, mapFinishReason(cand.finishReason), usage));
    }
  };
  return new Transform({
    transform(data: Buffer, _enc, cb) {
      const buf = Buffer.concat([pending, data]);
      const idx = buf.lastIndexOf(10);
      if (idx === -1) {
        pending = buf;
        cb();
        return;
      }
      const lines = buf.subarray(0, idx + 1).toString('utf8').split('\n');
      pending = buf.subarray(idx + 1);
      let out = '';
      for (const line of lines) handleLine(line.trim(), (s) => (out += s));
      cb(null, out);
    },
    flush(cb) {
      let out = '';
      if (pending.length) handleLine(pending.toString('utf8').trim(), (s) => (out += s));
      if (!finished) out += chunk({}, 'stop', usage);
      out += 'data: [DONE]\n\n';
      cb(null, out);
    }
  });
}

export interface AntigravityResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
  body: any;
}

// Fetch-like wrapper so proxy.ts can treat Antigravity like any OpenAI upstream.
export async function antigravityRequest(model: string, body: any, stream: boolean, signal: AbortSignal): Promise<AntigravityResponse> {
  const accessToken = await getAccessToken();
  const projectId = await getProjectId();
  const payload: any = {
    model,
    user_prompt_id: randomUUID(),
    request: openaiToGemini(body)
  };
  if (projectId) payload.project = projectId;
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const r = await fetch(`${CODE_ASSIST_URL}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });
  if (!r.ok) return r as unknown as AntigravityResponse;
  if (!stream) {
    const upstream: any = await r.json().catch(() => null);
    const translated = upstream ? geminiToOpenAI(upstream, model) : null;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => translated,
      body: null
    };
  }
  const nodeUpstream = Readable.fromWeb(r.body as any);
  const translated = nodeUpstream.pipe(geminiSseToOpenAI(model));
  nodeUpstream.on('error', (e) => translated.destroy(e));
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
    text: async () => '',
    json: async () => null,
    body: translated
  };
}
