#!/usr/bin/env node
'use strict';

/*
 * zerocode — a zero-code terminal coding agent for the ZeroCode gateway.
 * Talks to any OpenAI-compatible /v1 endpoint, drives an agentic tool loop
 * (read/list/write/edit files, run shell), and streams the final answer.
 * Node 18+ only; no dependencies, no build step.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');

// ---------- ansi ----------
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m'
};
const useColor = process.stdout.isTTY;
function paint(s, c) { return useColor ? c + s + C.reset : s; }

// ---------- config ----------
const HOME = os.homedir();
const CONFIG_FILE = path.join(HOME, '.zerocode.json');

function loadFileConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveFileConfig(obj) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 }); } catch { }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yolo') out.yolo = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const fileCfg = loadFileConfig();

const cfg = {
  baseUrl: (args.url || process.env.ZEROCODE_URL || process.env.TOKEN_ROUTE_URL || process.env.TKROLL_BASE_URL || fileCfg.baseUrl || 'http://127.0.0.1:3777/v1').replace(/\/+$/, ''),
  apiKey: args.key || process.env.ZEROCODE_PROXY_KEY || process.env.TOKEN_ROUTE_PROXY_KEY || fileCfg.apiKey || '',
  model: args.model || process.env.ZEROCODE_MODEL || process.env.TOKEN_ROUTE_MODEL || fileCfg.model || 'auto',
  maxTokens: Number(args['max-tokens'] || fileCfg.maxTokens || 4096),
  yolo: !!args.yolo || !!fileCfg.yolo,
  maxFileBytes: Number(fileCfg.maxFileBytes || 200000),
  maxSteps: Number(fileCfg.maxSteps || 25)
};

const VERSION = '0.4.0';

// live status-bar state
const stats = { inTok: 0, outTok: 0, lastIn: 0, lastOut: 0, status: 'ready', served: '' };
let barTimer = null;
let barOn = false;

if (args.version) { console.log('zerocode ' + VERSION); process.exit(0); }
if (args.help) { printHelp(); process.exit(0); }

function printHelp() {
  console.log(`zerocode ${VERSION} — terminal coding agent for ZeroCode

Usage:
  zerocode [options] [initial prompt...]

Options:
  --url <url>          Gateway base URL (default ${cfg.baseUrl})
  --key <key>          Proxy API key (or env ZEROCODE_PROXY_KEY)
  --model <id>         Model: auto | provider/model (default ${cfg.model})
  --max-tokens <n>     Max output tokens per reply (default ${cfg.maxTokens})
  --yolo               Auto-approve file writes and shell commands
  --version, -v
  --help, -h

Attach files: type @path anywhere in your message (e.g. "explain @src/proxy.ts").
             @dir attaches a directory listing. File contents are sent with the message.

In-session commands:
  /model [id]   picker (no id) or switch    /models   list gateway models
  /copy         copy last reply's code      /paste    send clipboard text as a message
  /img [prompt] send clipboard image (screenshot) as vision input
  /clear        reset conversation          /yolo     toggle auto-approve
  /cwd [dir]    show or change directory     /save     save config to ~/.zerocode.json
  /help         this help                    /exit     quit (Ctrl+C twice)

Config file: ${CONFIG_FILE}`);
}

// ---------- tool defs ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file relative to the working directory. Returns file contents.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories of a directory (default: current directory).',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file with the given content. Requires user approval.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact substring in a file. old_string must occur exactly once. Requires approval.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the working directory and return combined stdout/stderr. Requires approval.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }
  }
];

// ---------- fs helpers ----------
let cwd = process.cwd();

function resolveIn(p) {
  const abs = path.resolve(cwd, p || '.');
  return abs;
}

function shortCwd() {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/');
}

function toolReadFile(a) {
  const abs = resolveIn(a.path);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('path is a directory; use list_dir');
  let data = fs.readFileSync(abs, 'utf8');
  if (data.length > cfg.maxFileBytes) data = data.slice(0, cfg.maxFileBytes) + `\n... [truncated at ${cfg.maxFileBytes} bytes]`;
  return data;
}

function toolListDir(a) {
  const abs = resolveIn(a.path || '.');
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.git'))
    .slice(0, 500)
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
  return entries.join('\n') || '(empty)';
}

function toolWriteFile(a) {
  const abs = resolveIn(a.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, a.content);
  return `wrote ${a.content.length} bytes to ${a.path}`;
}

function toolEditFile(a) {
  const abs = resolveIn(a.path);
  const data = fs.readFileSync(abs, 'utf8');
  const idx = data.indexOf(a.old_string);
  if (idx === -1) throw new Error('old_string not found');
  if (data.indexOf(a.old_string, idx + 1) !== -1) throw new Error('old_string not unique; add more context');
  const next = data.slice(0, idx) + a.new_string + data.slice(idx + a.old_string.length);
  fs.writeFileSync(abs, next);
  return `edited ${a.path}`;
}

function toolRunCommand(a) {
  const r = spawnSync(a.command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const code = r.status == null ? 'signal ' + r.signal : r.status;
  return `exit ${code}\n${out.slice(0, cfg.maxFileBytes) || '(no output)'}`;
}

// Async runner so the spinner keeps animating (spawnSync would block the event loop).
function runCommandAsync(command) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, { cwd, shell: true }); }
    catch (e) { return resolve('error: ' + e.message); }
    let out = '';
    let timedOut = false;
    const cap = (d) => { if (out.length < cfg.maxFileBytes) out += d.toString(); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.on('error', (e) => { clearTimeout(timer); resolve('error: ' + e.message); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const status = timedOut ? 'timeout' : (code == null ? 'signal' : code);
      resolve('exit ' + status + '\n' + (out.slice(0, cfg.maxFileBytes) || '(no output)'));
    });
  });
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

function previewArgs(name, a) {
  if (name === 'read_file' || name === 'list_dir') return a.path || '.';
  if (name === 'write_file') return `${a.path} (${(a.content || '').length} bytes)`;
  if (name === 'edit_file') return a.path;
  if (name === 'run_command') return a.command;
  return JSON.stringify(a);
}

// ---------- http ----------
async function chat(messages, { stream }) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const body = {
    model: cfg.model,
    messages,
    max_tokens: cfg.maxTokens,
    tools: TOOLS,
    stream: !!stream
  };
  if (stream) body.stream_options = { include_usage: true };
  const res = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${summarize(t)}`);
  }
  return res;
}

function summarize(text) {
  try {
    const j = JSON.parse(text);
    if (j?.error?.message) return j.error.message;
  } catch { }
  return String(text).slice(0, 400);
}

async function listModels() {
  const headers = {};
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const res = await fetch(cfg.baseUrl + '/models', { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  return (j.data || []).map((m) => m.id);
}

// ---------- clipboard ----------
function clipboardCopy(text) {
  const plat = os.platform();
  let r;
  if (plat === 'win32') r = spawnSync('clip', [], { input: text });
  else if (plat === 'darwin') r = spawnSync('pbcopy', [], { input: text });
  else { r = spawnSync('xclip', ['-selection', 'clipboard'], { input: text }); if (r.error) r = spawnSync('wl-copy', [], { input: text }); }
  return !!r && !r.error && (r.status === 0 || r.status == null);
}
function clipboardPaste() {
  const plat = os.platform();
  let r;
  if (plat === 'win32') r = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' });
  else if (plat === 'darwin') r = spawnSync('pbpaste', [], { encoding: 'utf8' });
  else { r = spawnSync('xclip', ['-o', '-selection', 'clipboard'], { encoding: 'utf8' }); if (r.error) r = spawnSync('wl-paste', [], { encoding: 'utf8' }); }
  if (r && !r.error && typeof r.stdout === 'string') return r.stdout.replace(/\r/g, '').replace(/\n$/, '');
  return '';
}
function clipboardImage() {
  const plat = os.platform();
  if (plat === 'win32') {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $img=[System.Windows.Forms.Clipboard]::GetImage(); if($img){ $ms=New-Object System.IO.MemoryStream; $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }';
    const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return (r.stdout || '').trim();
  }
  if (plat === 'darwin') {
    const r = spawnSync('pngpaste', ['-'], { maxBuffer: 64 * 1024 * 1024 });
    if (!r.error && r.stdout && r.stdout.length) return Buffer.from(r.stdout).toString('base64');
    return '';
  }
  const r = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { maxBuffer: 64 * 1024 * 1024 });
  if (!r.error && r.stdout && r.stdout.length) return Buffer.from(r.stdout).toString('base64');
  return '';
}
function extractCode(md) {
  const out = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md))) out.push(m[1].replace(/\n$/, ''));
  return out;
}

// ---------- @file mentions ----------
function processMentions(text) {
  const found = [];
  const re = /@([^\s@]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].replace(/[.,;:]$/, '');
    try {
      const abs = resolveIn(p);
      const st = fs.statSync(abs);
      if (st.isDirectory()) found.push({ p, kind: 'DIR', body: toolListDir({ path: p }) });
      else {
        let data = fs.readFileSync(abs, 'utf8');
        if (data.length > cfg.maxFileBytes) data = data.slice(0, cfg.maxFileBytes) + '\n... [truncated]';
        found.push({ p, kind: 'FILE', body: data });
      }
    } catch { /* not a path — leave the @token as literal text */ }
  }
  if (!found.length) return { text, note: '' };
  const blocks = found.map((f) => `--- ${f.kind}: ${f.p} ---\n${f.body}`).join('\n\n');
  return { text: text + '\n\n' + blocks, note: found.map((f) => f.p).join(', ') };
}

// ---------- arrow-key picker ----------
function pickFromList(title, items) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || !items.length) return resolve(null);
    readline.emitKeypressEvents(stdin);
    const prevKeypress = stdin.listeners('keypress');
    const prevRaw = stdin.isRaw;
    barSuspend();
    rl.pause();
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    let filter = '';
    let idx = 0;
    const filtered = () => { const f = filter.toLowerCase(); return items.filter((i) => i.toLowerCase().includes(f)); };
    function render() {
      const list = filtered();
      if (idx >= list.length) idx = Math.max(0, list.length - 1);
      if (idx < 0) idx = 0;
      let out = '\x1b[2J\x1b[H';
      out += paint(title, C.bold) + paint('   ↑↓ move · type to filter · Enter select · Esc cancel', C.gray) + '\n';
      out += paint('filter: ', C.gray) + filter + '\n\n';
      const max = 15;
      let start = 0;
      if (list.length > max) start = Math.max(0, Math.min(idx - 7, list.length - max));
      const view = list.slice(start, start + max);
      if (!view.length) out += paint('  (no match)\n', C.dim);
      view.forEach((it, i) => {
        const real = start + i;
        out += (real === idx ? (useColor ? '\x1b[7m ' + it + ' ' + C.reset : '> ' + it) : '  ' + it) + '\n';
      });
      if (list.length > max) out += paint(`\n  [${idx + 1}/${list.length}]`, C.dim);
      process.stdout.write(out);
    }
    function done(val) {
      stdin.setRawMode(prevRaw);
      stdin.removeAllListeners('keypress');
      prevKeypress.forEach((l) => stdin.on('keypress', l));
      process.stdout.write('\x1b[2J\x1b[H');
      if (barOn) { const rows = process.stdout.rows || 24; process.stdout.write('\x1b[1;' + (rows - 1) + 'r\x1b[1;1H'); }
      rl.resume();
      barResume();
      resolve(val);
    }
    function onKey(str, key) {
      key = key || {};
      if (key.name === 'return') { const l = filtered(); done(l[idx] || null); }
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) done(null);
      else if (key.name === 'up') { idx--; render(); }
      else if (key.name === 'down') { idx++; render(); }
      else if (key.name === 'backspace') { filter = filter.slice(0, -1); idx = 0; render(); }
      else if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') { filter += str; idx = 0; render(); }
    }
    stdin.on('keypress', onKey);
    render();
  });
}

// ---------- spinner ----------
function spinner(label) {
  if (!process.stdout.isTTY) return { stop() { } };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write('\r' + paint(frames[i++ % frames.length] + ' ' + label, C.gray));
  }, 80);
  return { stop() { clearInterval(t); process.stdout.write('\r\x1b[K'); } };
}

// ---------- status bar ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function drawBar() {
  if (!barOn || !process.stdout.isTTY) return;
  const cols = process.stdout.columns || 80;
  const now = new Date();
  const clock = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
  const left = ` zerocode · ${stats.status}`;
  const center = stats.served && stats.served !== cfg.model
    ? `${cfg.model} → ${stats.served}`
    : (cfg.model + (stats.served ? '' : ''));
  const right = `${stats.lastIn}↑/${stats.lastOut}↓  Σ ${stats.inTok}/${stats.outTok} tok · ${clock} `;
  // place left at start, right at end, center in the middle of the full width
  const buf = new Array(cols).fill(' ');
  const place = (s, start) => { for (let i = 0; i < s.length && start + i >= 0 && start + i < cols; i++) buf[start + i] = s[i]; };
  place(left, 0);
  place(right, cols - right.length);
  place(center, Math.max(0, Math.floor((cols - center.length) / 2)));
  const line = buf.join('').slice(0, cols);
  const bg = useColor ? '\x1b[7m' : '';  // reverse video = clean white/black, adapts to theme
  const rows = process.stdout.rows || 24;
  // save cursor, jump to bottom row, clear, paint bar, restore cursor
  process.stdout.write('\x1b7\x1b[' + rows + ';1H\x1b[2K' + bg + line + C.reset + '\x1b8');
}
function setupBar() {
  if (!process.stdout.isTTY) return;
  barOn = true;
  const rows = process.stdout.rows || 24;
  process.stdout.write('\x1b[2J\x1b[H');                 // clear screen
  process.stdout.write('\x1b[1;' + (rows - 1) + 'r');    // scroll region = rows 1..bottom-1
  process.stdout.write('\x1b[1;1H');                     // cursor to top of region
  drawBar();
  barTimer = setInterval(drawBar, 1000);
  process.stdout.on('resize', () => {
    if (!barOn) return;
    const r = process.stdout.rows || 24;
    // \x1b7/\x1b8 saves & restores the cursor around DECSTBM, which otherwise
    // homes the cursor and hides the prompt.
    process.stdout.write('\x1b7\x1b[1;' + (r - 1) + 'r\x1b8');
    drawBar();
    try { rl.prompt(true); } catch { }  // re-render the current input line
  });
}
function teardownBar() {
  if (!barOn) return;
  barOn = false;
  if (barTimer) clearInterval(barTimer);
  if (process.stdout.isTTY) process.stdout.write('\x1b[r');  // reset scroll region
}
function barSuspend() { if (barTimer) { clearInterval(barTimer); barTimer = null; } }
function barResume() { if (barOn && !barTimer) { drawBar(); barTimer = setInterval(drawBar, 1000); } }
process.on('exit', teardownBar);

// ---------- readline ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise((r) => rl.question(q, r)); }

async function confirm(name, a) {
  if (cfg.yolo) return true;
  const label = paint(name, C.yellow) + ' ' + paint(previewArgs(name, a), C.dim);
  if (name === 'write_file') {
    const c = a.content || '';
    console.log(paint('\n─ proposed write: ' + a.path + ' ─', C.gray));
    console.log(c.length > 1200 ? c.slice(0, 1200) + paint('\n… (' + c.length + ' bytes total)', C.dim) : c);
  }
  if (name === 'edit_file') {
    console.log(paint('\n─ edit ' + a.path + ' ─', C.gray));
    console.log(paint('- ' + a.old_string.replace(/\n/g, '\n- '), C.red));
    console.log(paint('+ ' + a.new_string.replace(/\n/g, '\n+ '), C.green));
  }
  if (name === 'run_command') console.log(paint('\n$ ' + a.command, C.yellow));
  const ans = (await ask(`approve ${label}? [y/N/a=always] `)).trim().toLowerCase();
  if (ans === 'a') { cfg.yolo = true; return true; }
  return ans === 'y' || ans === 'yes';
}

function runTool(name, a) {
  switch (name) {
    case 'read_file': return toolReadFile(a);
    case 'list_dir': return toolListDir(a);
    case 'write_file': return toolWriteFile(a);
    case 'edit_file': return toolEditFile(a);
    case 'run_command': return toolRunCommand(a);
    default: throw new Error('unknown tool ' + name);
  }
}

// ---------- streaming reader ----------
async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = null;
  const toolCalls = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      if (obj.usage) usage = obj.usage;
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      const rtext = delta.reasoning ?? delta.reasoning_content;
      if (rtext) onDelta(rtext, 'reasoning');
      if (delta.content) { full += delta.content; onDelta(delta.content, 'content'); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }
  return { content: full, toolCalls: toolCalls.filter(Boolean), usage };
}

// ---------- agent loop ----------
function systemPrompt() {
  return [
    'You are zerocode, a terminal coding assistant working inside the user\'s project.',
    `Working directory: ${cwd}`,
    `OS: ${os.platform()} ${os.release()}`,
    'Use the provided tools to inspect and modify files and run commands. Read files before editing them.',
    'Prefer edit_file for small changes and write_file for new files. Keep edits minimal and match existing style.',
    'When you run commands or change files, briefly explain what you did. Stop when the task is done.'
  ].join('\n');
}

const messages = [{ role: 'system', content: systemPrompt() }];
let lastReply = '';

async function turn(userText, imageB64) {
  const { text: augmented, note } = processMentions(userText);
  if (note) console.log(paint('attached: ' + note, C.dim));
  const content = imageB64
    ? [{ type: 'text', text: augmented }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } }]
    : augmented;
  messages.push({ role: 'user', content });
  const callCounts = new Map(); // anti-loop: weak models re-run the same read repeatedly
  stats.status = 'working'; drawBar();
  for (let step = 0; step < cfg.maxSteps; step++) {
    let result;
    // Stream so the user sees text as it lands; tool_calls are accumulated too.
    let printedAny = false;
    const sp = spinner('generating (' + cfg.model + ')');
    let res;
    try {
      res = await chat(messages, { stream: true });
    } catch (e) {
      sp.stop();
      console.log(paint('error: ' + e.message, C.red));
      stats.status = 'ready'; drawBar();
      return;
    }
    const cand = res.headers.get('x-zerocode-candidate');
    if (cand) { stats.served = cand; drawBar(); }
    // keep the spinner running through generation; stop it the moment the first token prints
    let sawReasoning = false;
    let printedContent = false;
    try {
      result = await readStream(res, (d, kind) => {
        if (!printedAny) { sp.stop(); printedAny = true; }
        if (kind === 'reasoning') {
          if (!sawReasoning) { process.stdout.write(paint('thinking: ', C.gray)); sawReasoning = true; }
          process.stdout.write(paint(d, C.gray));
          return;
        }
        if (sawReasoning && !printedContent) process.stdout.write('\n\n');
        printedContent = true;
        process.stdout.write(d);
      });
    } catch (e) {
      sp.stop();
      console.log(paint('\nstream error: ' + e.message, C.red));
      stats.status = 'ready'; drawBar();
      return;
    }
    sp.stop();
    if (printedAny) process.stdout.write('\n');
    if (result.usage) {
      stats.lastIn = result.usage.prompt_tokens || 0;
      stats.lastOut = result.usage.completion_tokens || 0;
      stats.inTok += stats.lastIn;
      stats.outTok += stats.lastOut;
      drawBar();
    }

    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
    messages.push(assistantMsg);

    if (!result.toolCalls.length) { lastReply = result.content || ''; stats.status = 'ready'; drawBar(); return; } // final answer

    for (const tc of result.toolCalls) {
      const name = tc.function.name;
      let a = {};
      try { a = JSON.parse(tc.function.arguments || '{}'); } catch { }
      let output;
      if (WRITE_TOOLS.has(name)) {
        const ok = await confirm(name, a);
        if (!ok) { output = 'user declined this action'; }
      }
      if (output === undefined) {
        const sig = name + ':' + JSON.stringify(a);
        const n = (callCounts.get(sig) || 0) + 1;
        callCounts.set(sig, n);
        if (n >= 3 && !WRITE_TOOLS.has(name)) {
          output = 'You already ran this exact call ' + (n - 1) + ' times with the same result. Stop repeating it; use the information you have and either take the next different action or give your final answer.';
        } else if (name === 'run_command') {
          const sp = spinner('running: ' + previewArgs(name, a));
          output = await runCommandAsync(a.command);
          sp.stop();
          console.log(paint('· ran: ' + a.command, C.cyan));
        } else {
          if (!WRITE_TOOLS.has(name)) console.log(paint('· ' + name + ' ' + previewArgs(name, a), C.cyan));
          try { output = String(runTool(name, a)); }
          catch (e) { output = 'error: ' + e.message; }
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: output.slice(0, 60000) });
    }
  }
  console.log(paint('(stopped: hit max steps)', C.dim));
  stats.status = 'ready'; drawBar();
}

// ---------- slash commands ----------
async function handleSlash(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'exit': case 'quit': rl.close(); process.exit(0); break;
    case 'help': printHelp(); break;
    case 'clear': messages.length = 1; messages[0] = { role: 'system', content: systemPrompt() }; console.log(paint('conversation cleared', C.dim)); break;
    case 'model':
      if (arg) { cfg.model = arg; console.log(paint('model → ' + arg, C.dim)); break; }
      {
        let models = [];
        try { models = await listModels(); }
        catch (e) { console.log(paint('error: ' + e.message + ' (current: ' + cfg.model + ')', C.red)); break; }
        const picked = await pickFromList('Select model  (current: ' + cfg.model + ')', ['auto', ...models.filter((m) => m !== 'auto')]);
        if (picked) { cfg.model = picked; console.log(paint('model → ' + picked, C.dim)); }
        else console.log(paint('model: ' + cfg.model, C.dim));
      }
      break;
    case 'models':
      try { (await listModels()).forEach((m) => console.log('  ' + m)); }
      catch (e) { console.log(paint('error: ' + e.message, C.red)); }
      break;
    case 'copy': {
      if (!lastReply) { console.log(paint('nothing to copy yet', C.dim)); break; }
      const blocks = extractCode(lastReply);
      const payload = blocks.length ? blocks.join('\n\n') : lastReply;
      if (clipboardCopy(payload)) console.log(paint('copied ' + (blocks.length ? blocks.length + ' code block(s)' : 'last reply') + ' to clipboard', C.dim));
      else console.log(paint('clipboard copy failed (no clip/pbcopy/xclip?)', C.red));
      break;
    }
    case 'paste': {
      const txt = clipboardPaste();
      if (!txt) { console.log(paint('clipboard empty or unavailable', C.red)); break; }
      console.log(paint('› ', C.green) + paint('(pasted ' + txt.length + ' chars from clipboard)', C.dim));
      await turn(txt);
      break;
    }
    case 'img': case 'image': {
      const img = clipboardImage();
      if (!img) { console.log(paint('no image on clipboard (copy a screenshot first)', C.red)); break; }
      const kb = Math.round((img.length * 3 / 4) / 1024);
      console.log(paint('› ', C.green) + paint('(pasted image from clipboard, ~' + kb + ' KB)', C.dim));
      await turn(arg || 'Describe this image.', img);
      break;
    }
    case 'yolo': cfg.yolo = !cfg.yolo; console.log(paint('auto-approve ' + (cfg.yolo ? 'ON' : 'OFF'), C.yellow)); break;
    case 'cwd':
      if (arg) { try { process.chdir(path.resolve(cwd, arg)); cwd = process.cwd(); messages[0] = { role: 'system', content: systemPrompt() }; } catch (e) { console.log(paint(e.message, C.red)); } }
      console.log('cwd: ' + cwd);
      break;
    case 'save':
      saveFileConfig({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, maxTokens: cfg.maxTokens, yolo: cfg.yolo });
      console.log(paint('saved ' + CONFIG_FILE, C.dim));
      break;
    default: console.log(paint('unknown command /' + cmd + ' (try /help)', C.red));
  }
}

// ---------- main ----------
async function main() {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (interactive) setupBar();  // pins a status row at the top; clears the screen
  console.log(paint('zerocode ' + VERSION, C.bold) + paint('  ' + cfg.baseUrl + '  model=' + cfg.model + (cfg.yolo ? '  [yolo]' : ''), C.dim));
  console.log(paint('cwd: ' + cwd, C.dim));
  // reachability check
  try {
    const r = await fetch(cfg.baseUrl.replace(/\/v1$/, '') + '/healthz').catch(() => null);
    if (!r || !r.ok) console.log(paint('warning: gateway not reachable at ' + cfg.baseUrl + ' (start ZeroCode, or set --url)', C.yellow));
  } catch { }
  console.log(paint('Type a request (use @file to attach), /model to pick, /help for more.\n', C.gray));

  const initial = args._.join(' ').trim();
  if (initial) { console.log(paint('› ', C.green) + initial); await turn(initial); }

  // Non-interactive (piped stdin / no TTY): run the one-shot task and exit; no REPL.
  if (!process.stdin.isTTY) { rl.close(); process.exit(0); }

  rl.on('close', () => process.exit(0));

  let sigint = false;
  rl.on('SIGINT', () => {
    if (sigint) { rl.close(); process.exit(0); }
    sigint = true;
    console.log(paint('\n(Ctrl+C again to quit)', C.dim));
    rl.prompt();
    setTimeout(() => { sigint = false; }, 1500);
  });

  while (true) {
    const prompt = paint(shortCwd() + ' ', C.dim) + paint('› ', C.bold);
    const line = (await ask(prompt)).trim();
    if (!line) continue;
    if (line.startsWith('/')) { await handleSlash(line); continue; }
    try { await turn(line); } catch (e) { console.log(paint('error: ' + e.message, C.red)); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
