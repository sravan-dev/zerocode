import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';

type Attachment =
  | { kind: 'file'; path: string }
  | { kind: 'selection'; path: string; startLine: number; endLine: number; text: string; lang: string }
  | { kind: 'image'; name: string; dataUrl: string };

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

interface DisplayMessage {
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  attachments?: { kind: string; label: string; thumb?: string }[];
  via?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string;
}

const API_KEY_SECRET = 'tkroll.apiKey';
const HISTORY_KEY = 'tkroll.history.v1';
const MODEL_KEY = 'tkroll.model';
const FILE_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage,.venv,__pycache__}/**';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'tkroll.chat';

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private lastWebview?: vscode.Webview;
  private readonly ready = new WeakSet<vscode.Webview>();
  private readonly pending = new WeakMap<vscode.Webview, unknown[]>();
  private apiMessages: ApiMessage[] = [];
  private display: DisplayMessage[] = [];
  private model: string;
  private abort?: AbortController;
  private fileCache?: vscode.Uri[];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.model = ctx.workspaceState.get<string>(MODEL_KEY) || this.cfg().get<string>('defaultModel') || 'auto';
    const saved = ctx.workspaceState.get<{ api: ApiMessage[]; display: DisplayMessage[] }>(HISTORY_KEY);
    if (saved) {
      this.apiMessages = saved.api || [];
      this.display = saved.display || [];
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const invalidate = () => (this.fileCache = undefined);
    watcher.onDidCreate(invalidate, null, this.disposables);
    watcher.onDidDelete(invalidate, null, this.disposables);
    this.disposables.push(watcher);
  }

  dispose(): void {
    this.abort?.abort();
    this.disposables.forEach((d) => d.dispose());
  }

  private cfg() {
    return vscode.workspace.getConfiguration('tkroll');
  }

  private baseUrl(): string {
    return (this.cfg().get<string>('baseUrl') || 'http://127.0.0.1:3777/v1').replace(/\/+$/, '');
  }

  /** Broadcast to every open chat surface (side bar view and editor panel share one conversation). */
  private post(msg: unknown): void {
    for (const w of this.webviews) w.postMessage(msg);
  }

  /** Send to the surface the user last interacted with (attachments, file search results). */
  private postActive(msg: unknown): void {
    const target = this.lastWebview && this.webviews.has(this.lastWebview) ? this.lastWebview : [...this.webviews].pop();
    if (!target) return;
    if (this.ready.has(target)) target.postMessage(msg);
    else this.pending.set(target, [...(this.pending.get(target) || []), msg]);
  }

  private setup(webview: vscode.Webview): vscode.Disposable {
    const mediaRoot = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = this.html(webview, mediaRoot);
    this.webviews.add(webview);
    return webview.onDidReceiveMessage((m) => {
      this.lastWebview = webview;
      this.onMessage(m, webview);
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const sub = this.setup(view.webview);
    view.onDidDispose(() => {
      sub.dispose();
      this.webviews.delete(view.webview);
      this.view = undefined;
    });
  }

  /** Open (or reveal) the chat as an editor tab beside the active editor. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'tkroll.chatPanel',
      'tkroll',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    this.panel = panel;
    this.lastWebview = panel.webview;
    const sub = this.setup(panel.webview);
    panel.onDidChangeViewState(() => {
      if (panel.active) this.lastWebview = panel.webview;
    });
    panel.onDidDispose(() => {
      sub.dispose();
      this.webviews.delete(panel.webview);
      this.panel = undefined;
    });
  }

  private async onMessage(m: any, from: vscode.Webview): Promise<void> {
    switch (m?.type) {
      case 'ready':
        from.postMessage({ type: 'init', model: this.model, history: this.display, baseUrl: this.baseUrl(), busy: !!this.abort });
        this.ready.add(from);
        for (const queued of this.pending.get(from) || []) from.postMessage(queued);
        this.pending.delete(from);
        this.loadModels();
        break;
      case 'refreshModels':
        this.loadModels();
        break;
      case 'setModel':
        if (typeof m.model === 'string' && m.model) {
          this.model = m.model;
          this.ctx.workspaceState.update(MODEL_KEY, this.model);
          this.post({ type: 'modelChanged', model: this.model });
        }
        break;
      case 'send':
        await this.send(String(m.text || ''), Array.isArray(m.attachments) ? m.attachments : []);
        break;
      case 'stop':
        this.abort?.abort();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'searchFiles':
        from.postMessage({ type: 'fileResults', query: m.query, items: await this.searchFiles(String(m.query || '')) });
        break;
      case 'pickFiles':
        await this.pickFiles();
        break;
      case 'pickImages':
        await this.pickImages();
        break;
      case 'addActiveFile':
        this.addActiveFile();
        break;
      case 'addSelection':
        this.addActiveSelection();
        break;
      case 'insertCode':
        await this.insertCode(String(m.code || ''));
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text || ''));
        break;
      case 'openFile':
        this.openFile(String(m.path || ''));
        break;
      case 'setApiKey':
        await this.promptApiKey();
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'tkroll');
        break;
    }
  }

  // ---------- models ----------

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    const key = await this.ctx.secrets.get(API_KEY_SECRET);
    if (key) h['authorization'] = `Bearer ${key}`;
    return h;
  }

  private async loadModels(): Promise<void> {
    try {
      const r = await fetch(`${this.baseUrl()}/models`, { headers: await this.headers(), signal: AbortSignal.timeout(15000) });
      if (r.status === 401) throw new Error('Gateway rejected the API key (401). Use "Set Gateway API Key".');
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${this.baseUrl()}/models`);
      const j: any = await r.json();
      const ids: string[] = (Array.isArray(j?.data) ? j.data : []).map((x: any) => x?.id).filter((x: any) => typeof x === 'string');
      this.post({ type: 'models', models: ids.length ? ids : ['auto'], model: this.model });
    } catch (e: any) {
      const msg = e?.name === 'TimeoutError' ? `Gateway at ${this.baseUrl()} did not respond` : String(e?.message || e);
      this.post({ type: 'models', models: [this.model], model: this.model, error: msg });
    }
  }

  // ---------- attachments ----------

  private rel(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  private async searchFiles(query: string): Promise<{ path: string; name: string; dir: string }[]> {
    if (!this.fileCache) {
      this.fileCache = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE, 8000);
    }
    const q = query.toLowerCase();
    const openTabs = new Set(
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => (t.input as any)?.uri?.toString()).filter(Boolean)
    );
    const scored: { uri: vscode.Uri; score: number }[] = [];
    for (const uri of this.fileCache) {
      const rel = this.rel(uri).toLowerCase();
      const base = path.basename(rel);
      let score: number;
      if (!q) score = openTabs.has(uri.toString()) ? 100 : 1;
      else if (base.startsWith(q)) score = 90;
      else if (base.includes(q)) score = 70;
      else if (rel.includes(q)) score = 40;
      else continue;
      if (openTabs.has(uri.toString())) score += 15;
      score -= rel.length / 200;
      scored.push({ uri, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30).map(({ uri }) => {
      const rel = this.rel(uri);
      return { path: rel, name: path.basename(rel), dir: path.dirname(rel) === '.' ? '' : path.dirname(rel) };
    });
  }

  private attach(att: Attachment): void {
    if (this.panel && this.lastWebview === this.panel.webview) this.panel.reveal(undefined, true);
    else if (!this.webviews.size) this.openInEditor();
    else vscode.commands.executeCommand('tkroll.chat.focus');
    this.postActive({ type: 'addAttachment', attachment: att });
  }

  addFileUri(uri?: vscode.Uri): void {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    this.attach({ kind: 'file', path: this.rel(target) });
  }

  private addActiveFile(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      vscode.window.showInformationMessage('tkroll: no active editor to attach.');
      return;
    }
    this.attach({ kind: 'file', path: this.rel(doc.uri) });
  }

  addActiveSelection(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) {
      vscode.window.showInformationMessage('tkroll: select some code first.');
      return;
    }
    const sel = ed.selection;
    this.attach({
      kind: 'selection',
      path: this.rel(ed.document.uri),
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
      text: ed.document.getText(sel),
      lang: ed.document.languageId
    });
  }

  private async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });
    uris?.forEach((u) => this.attach({ kind: 'file', path: this.rel(u) }));
  }

  private async pickImages(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach image',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
    });
    for (const u of uris || []) {
      const bytes = await vscode.workspace.fs.readFile(u);
      if (bytes.byteLength > 8 * 1024 * 1024) {
        vscode.window.showWarningMessage(`tkroll: ${path.basename(u.fsPath)} is larger than 8 MB, skipped.`);
        continue;
      }
      const ext = path.extname(u.fsPath).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      this.attach({ kind: 'image', name: path.basename(u.fsPath), dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` });
    }
  }

  private resolveWorkspacePath(rel: string): vscode.Uri | undefined {
    if (path.isAbsolute(rel)) return vscode.Uri.file(rel);
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length > 1) {
      // asRelativePath prefixes the folder name in multi-root workspaces.
      const owner = folders.find((f) => rel.startsWith(f.name + '/'));
      if (owner) return vscode.Uri.joinPath(owner.uri, rel.slice(owner.name.length + 1));
    }
    return folders[0] ? vscode.Uri.joinPath(folders[0].uri, rel) : undefined;
  }

  private async readFileForPrompt(rel: string): Promise<string> {
    const uri = this.resolveWorkspacePath(rel);
    if (!uri) return `<file path="${rel}">(could not resolve path)</file>`;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const max = this.cfg().get<number>('maxFileBytes') || 200000;
      const slice = Buffer.from(bytes.subarray(0, max));
      if (slice.includes(0)) return `<file path="${rel}">(binary file omitted)</file>`;
      let text = slice.toString('utf8');
      if (bytes.byteLength > max) text += `\n... (truncated, ${bytes.byteLength} bytes total)`;
      const lang = path.extname(rel).slice(1);
      return `<file path="${rel}">\n\`\`\`${lang}\n${text}\n\`\`\`\n</file>`;
    } catch (e: any) {
      return `<file path="${rel}">(could not read: ${String(e?.message || e)})</file>`;
    }
  }

  private openFile(rel: string): void {
    const uri = this.resolveWorkspacePath(rel);
    if (uri) vscode.window.showTextDocument(uri, { preview: true });
  }

  private async insertCode(code: string): Promise<void> {
    const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!ed) {
      const doc = await vscode.workspace.openTextDocument({ content: code });
      await vscode.window.showTextDocument(doc);
      return;
    }
    await ed.edit((b) => {
      if (ed.selection.isEmpty) b.insert(ed.selection.active, code);
      else b.replace(ed.selection, code);
    });
  }

  // ---------- chat ----------

  newChat(): void {
    this.abort?.abort();
    this.apiMessages = [];
    this.display = [];
    this.persist();
    this.post({ type: 'cleared' });
  }

  async promptApiKey(): Promise<void> {
    const current = await this.ctx.secrets.get(API_KEY_SECRET);
    const value = await vscode.window.showInputBox({
      title: 'tkroll: Gateway API key',
      prompt: 'The Token Route proxy key (TOKEN_ROUTE_PROXY_KEY). Leave empty to remove it.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: current ? 'a key is saved - enter a new one to replace it' : 'paste key'
    });
    if (value === undefined) return;
    if (value.trim()) await this.ctx.secrets.store(API_KEY_SECRET, value.trim());
    else await this.ctx.secrets.delete(API_KEY_SECRET);
    vscode.window.showInformationMessage(value.trim() ? 'tkroll: API key saved.' : 'tkroll: API key removed.');
    this.loadModels();
  }

  private persist(): void {
    // Images are dropped from saved history to keep workspace state small.
    const api = this.apiMessages.map((m) =>
      Array.isArray(m.content)
        ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: '[image omitted from saved history]' } : p)) }
        : m
    );
    const display = this.display.map((d) => ({
      ...d,
      attachments: d.attachments?.map((a) => ({ kind: a.kind, label: a.label }))
    }));
    this.ctx.workspaceState.update(HISTORY_KEY, { api: api.slice(-60), display: display.slice(-60) });
  }

  private async send(text: string, attachments: Attachment[]): Promise<void> {
    if (this.abort) return;
    if (!text.trim() && !attachments.length) return;

    const contextBlocks: string[] = [];
    const images: string[] = [];
    const displayAtts: DisplayMessage['attachments'] = [];
    for (const a of attachments) {
      if (a?.kind === 'file' && typeof a.path === 'string') {
        contextBlocks.push(await this.readFileForPrompt(a.path));
        displayAtts.push({ kind: 'file', label: a.path });
      } else if (a?.kind === 'selection' && typeof a.text === 'string') {
        contextBlocks.push(`<selection path="${a.path}" lines="${a.startLine}-${a.endLine}">\n\`\`\`${a.lang}\n${a.text}\n\`\`\`\n</selection>`);
        displayAtts.push({ kind: 'selection', label: `${a.path}:${a.startLine}-${a.endLine}` });
      } else if (a?.kind === 'image' && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/')) {
        images.push(a.dataUrl);
        displayAtts.push({ kind: 'image', label: a.name || 'image', thumb: a.dataUrl });
      }
    }

    const fullText = contextBlocks.length ? `${contextBlocks.join('\n\n')}\n\n${text}` : text;
    const content: ApiMessage['content'] = images.length
      ? [{ type: 'text', text: fullText }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
      : fullText;

    this.apiMessages.push({ role: 'user', content });
    const userMsg: DisplayMessage = { role: 'user', text, attachments: displayAtts };
    this.display.push(userMsg);
    const reply: DisplayMessage = { role: 'assistant', text: '' };
    this.display.push(reply);
    this.post({ type: 'start', model: this.model, user: userMsg });

    const system = this.cfg().get<string>('systemPrompt');
    const messages: ApiMessage[] = system ? [{ role: 'system', content: system }, ...this.apiMessages] : [...this.apiMessages];

    this.abort = new AbortController();
    try {
      const r = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: this.cfg().get<number>('maxTokens') || 2048
        }),
        signal: this.abort.signal
      });
      reply.via = r.headers.get('x-token-route-candidate') || undefined;
      if (!r.ok || !r.body) {
        let msg = `HTTP ${r.status}`;
        try {
          const j: any = await r.json();
          msg = j?.error?.message || j?.error || msg;
        } catch {}
        if (r.status === 401) msg += ' - set the gateway key with "tkroll: Set Gateway API Key".';
        throw new Error(msg);
      }
      this.post({ type: 'via', via: reply.via });
      await this.readStream(r.body, reply);
      this.apiMessages.push({ role: 'assistant', content: reply.text });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        reply.error = reply.text ? undefined : 'Stopped.';
        if (reply.text) this.apiMessages.push({ role: 'assistant', content: reply.text });
      } else {
        const cause = e?.cause?.code === 'ECONNREFUSED' ? ` - is Token Route running at ${this.baseUrl()}?` : '';
        reply.error = String(e?.message || e) + cause;
        // Drop the failed user turn so a retry doesn't send it twice.
        this.apiMessages.pop();
      }
    } finally {
      this.abort = undefined;
      this.post({ type: 'done', message: reply });
      this.persist();
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, reply: DisplayMessage): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const raw = t.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let j: any;
        try {
          j = JSON.parse(raw);
        } catch {
          continue;
        }
        if (j?.error) throw new Error(j.error.message || 'upstream stream error');
        const delta = j?.choices?.[0]?.delta || {};
        const content = typeof delta.content === 'string' ? delta.content : '';
        const reasoning =
          typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        if (j?.usage) reply.usage = j.usage;
        if (content) reply.text += content;
        if (reasoning) reply.reasoning = (reply.reasoning || '') + reasoning;
        if (content || reasoning) this.post({ type: 'delta', content, reasoning });
      }
    }
  }

  // ---------- html ----------

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>tkroll</title>
</head>
<body>
<header class="bar">
  <select id="model" title="Model"></select>
  <button id="refresh" class="icon" title="Reload models">&#8635;</button>
  <span id="vision" class="pill" hidden title="This model is likely to accept images">vision</span>
</header>
<div id="notice" class="notice" hidden></div>
<main id="messages"></main>
<footer class="composer">
  <div id="attachments" class="attachments"></div>
  <div id="warn" class="warn" hidden></div>
  <div class="inputwrap">
    <div id="mention" class="mention" hidden></div>
    <textarea id="input" rows="3" placeholder="Ask anything - @ to mention files, paste images, Enter to send"></textarea>
  </div>
  <div class="actions">
    <button id="attachFile" class="icon" title="Attach files">&#128206;</button>
    <button id="attachImage" class="icon" title="Attach images">&#128247;</button>
    <button id="attachSel" class="icon" title="Attach editor selection">&#10697;</button>
    <span class="grow"></span>
    <button id="send" class="primary" title="Send (Enter)">Send</button>
  </div>
</footer>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
