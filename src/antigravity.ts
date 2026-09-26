import { createHash, randomBytes, randomUUID } from 'crypto';
import { Readable, Transform } from 'stream';
import type { UpstreamModel } from './providers';
import { ANTIGRAVITY_USER_AGENT, CODE_ASSIST_URL, getAccessToken, getProjectId, loadCreds } from './google-auth';

export interface AntigravityResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
  body: any;
}

function contentToParts(content: any): any[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push({ text: item.text });
    else if (item.type === 'image_url' && typeof item.image_url?.url === 'string') {
      const match = /^data:([^;]+);base64,(.+)$/.exec(item.image_url.url);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }
  return parts;
}

function openaiToGemini(body: any): any {
  const contents: any[] = [];
  const systemParts: any[] = [];
  for (const message of body.messages as any[]) {
    if (!message || typeof message !== 'object') continue;
    const parts = contentToParts(message.content);
    if (message.role === 'system' || message.role === 'developer') systemParts.push(...parts);
    else if (message.role === 'assistant') {
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (parts.length) contents.push({ role: 'user', parts });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });

  const generationConfig: any = {};
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;
  const maxTokens = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : body.max_tokens;
  if (typeof maxTokens === 'number' && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
  if (typeof body.stop === 'string' && body.stop) generationConfig.stopSequences = [body.stop];
  else if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop.filter((stop: any) => typeof stop === 'string').slice(0, 5);

  const request: any = { contents };
  if (systemParts.length) request.systemInstruction = { role: 'user', parts: systemParts };
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return request;
}

function mapFinishReason(reason: unknown): string {
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST') return 'content_filter';
  return 'stop';
}

function candidateText(candidate: any): string {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((part: any) => part && typeof part.text === 'string' && !part.thought).map((part: any) => part.text).join('');
}

function mapUsage(usage: any): any | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  return {
    prompt_tokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0,
    completion_tokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0,
    total_tokens: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : 0
  };
}

function geminiToOpenAI(response: any, model: string): any {
  const inner = response?.response && typeof response.response === 'object' ? response.response : response;
  const candidate = Array.isArray(inner?.candidates) ? inner.candidates[0] : null;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: candidateText(candidate) }, finish_reason: mapFinishReason(candidate?.finishReason) }],
    usage: mapUsage(inner?.usageMetadata) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

function geminiSseToOpenAI(model: string): Transform {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let pending = Buffer.alloc(0);
  let sentRole = false;
  let finished = false;
  let usage: any;
  const chunk = (delta: any, finish: string | null, withUsage?: any) => {
    const obj: any = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (withUsage) obj.usage = withUsage;
    return `data: ${JSON.stringify(obj)}\n\n`;
  };
  const handleLine = (line: string, push: (value: string) => void) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let data: any;
    try { data = JSON.parse(raw); } catch { return; }
    const inner = data?.response && typeof data.response === 'object' ? data.response : data;
    const candidate = Array.isArray(inner?.candidates) ? inner.candidates[0] : null;
    const nextUsage = mapUsage(inner?.usageMetadata);
    if (nextUsage) usage = nextUsage;
    const text = candidateText(candidate);
    if (text) {
      const delta = sentRole ? { content: text } : { role: 'assistant', content: text };
      sentRole = true;
      push(chunk(delta, null));
    }
    if (candidate?.finishReason && !finished) {
      finished = true;
      push(chunk({}, mapFinishReason(candidate.finishReason), usage));
    }
  };
  return new Transform({
    transform(data: Buffer, _encoding, callback) {
      const buffer = Buffer.concat([pending, data]);
      const end = buffer.lastIndexOf(10);
      if (end === -1) { pending = buffer; callback(); return; }
      const lines = buffer.subarray(0, end + 1).toString('utf8').split('\n');
      pending = buffer.subarray(end + 1);
      let output = '';
      for (const line of lines) handleLine(line.trim(), (value) => { output += value; });
      callback(null, output);
    },
    flush(callback) {
      let output = '';
      if (pending.length) handleLine(pending.toString('utf8').trim(), (value) => { output += value; });
      if (!finished) output += chunk({}, 'stop', usage);
      output += 'data: [DONE]\n\n';
      callback(null, output);
    }
  });
}

async function antigravityCall(method: string, body: unknown, accessToken: string, signal?: AbortSignal, accept = 'application/json'): Promise<Response> {
  return fetch(`${CODE_ASSIST_URL}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': ANTIGRAVITY_USER_AGENT, accept },
    body: JSON.stringify(body),
    signal
  });
}

export async function listAntigravityModels(): Promise<UpstreamModel[]> {
  const accessToken = await getAccessToken();
  // Model discovery is account-scoped and reflects the models currently offered upstream.
  await getProjectId();
  const baseUrls = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
  let response: Response | undefined;
  let json: any;
  for (const baseUrl of baseUrls) {
    try {
      response = await fetch(`${baseUrl}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': ANTIGRAVITY_USER_AGENT, accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000)
      });
      json = await response.json().catch(() => null);
      if (response.ok && json) break;
      if (response.status === 401 || response.status === 403) break;
    } catch (error) {
      if (baseUrl === baseUrls[baseUrls.length - 1]) throw error;
    }
  }
  if (!response?.ok || !json) {
    throw new Error(`Antigravity model discovery HTTP ${response?.status || 'unavailable'}: ${String(json?.error?.message || '').slice(0, 200)}`);
  }
  const models = json.models && typeof json.models === 'object' ? json.models : {};
  return Object.entries(models)
    .filter(([id, info]: [string, any]) => id && info && typeof info === 'object' && info.isInternal !== true)
    .map(([id, info]: [string, any]) => ({
      id,
      name: typeof info.displayName === 'string' ? info.displayName : undefined,
      chat: !/imagen|image|video|veo|sora|embed|embedding|rerank|audio|speech|tts|lyria|music/i.test(`${id} ${info.displayName || ''}`),
      context: typeof info.maxInputTokens === 'number' ? info.maxInputTokens : undefined
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function antigravitySessionId(): string {
  const email = loadCreds()?.email?.trim().toLowerCase();
  if (email) {
    let hash = BigInt.asIntN(64, -3750763034362895579n);
    for (const byte of Buffer.from(email, 'utf8')) {
      hash = BigInt.asIntN(64, hash ^ BigInt(byte));
      hash = BigInt.asIntN(64, hash * 1099511628211n);
    }
    return hash.toString();
  }
  return BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)).toString();
}

function geminiSseToResponse(raw: string, model: string): any {
  let text = '';
  let finishReason: unknown = 'STOP';
  let usage: any;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') continue;
    let data: any;
    try { data = JSON.parse(value); } catch { continue; }
    const inner = data?.response && typeof data.response === 'object' ? data.response : data;
    const candidate = Array.isArray(inner?.candidates) ? inner.candidates[0] : null;
    text += candidateText(candidate);
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (inner?.usageMetadata) usage = inner.usageMetadata;
  }
  return geminiToOpenAI({
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: usage
  }, model);
}

export async function antigravityRequest(model: string, body: any, stream: boolean, signal: AbortSignal): Promise<AntigravityResponse> {
  const accessToken = await getAccessToken();
  const project = await getProjectId();
  if (!project) throw new Error('Google Code Assist did not return a project ID. Finish Google onboarding or set GOOGLE_CLOUD_PROJECT, then try again.');
  const payload = {
    project,
    model,
    requestId: `agent/${Date.now()}/${randomBytes(4).toString('hex')}`,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: { ...openaiToGemini(body), sessionId: antigravitySessionId() }
  };
  const response = await antigravityCall('streamGenerateContent?alt=sse', payload, accessToken, signal, 'text/event-stream');
  if (!response.ok) return response as unknown as AntigravityResponse;
  if (!stream) {
    const upstream = await response.text().catch(() => '');
    const translated = upstream ? geminiSseToResponse(upstream, model) : null;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => translated,
      body: null
    };
  }
  const upstream = Readable.fromWeb(response.body as any);
  const translated = upstream.pipe(geminiSseToOpenAI(model));
  upstream.on('error', (error) => translated.destroy(error));
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
    text: async () => '',
    json: async () => null,
    body: translated
  };
}
