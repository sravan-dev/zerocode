'use strict';

/*
 * Zero Code web chat. Talks to the ZeroCode gateway's OpenAI-compatible
 * /v1 endpoints on the same origin, streams replies over SSE, and keeps
 * chats + settings in localStorage. No build step, no dependencies.
 */

(function () {
  // ---------- storage ----------
  const KEYS = { chats: 'zc.chats', settings: 'zc.settings', theme: 'zc.theme', ui: 'zc.ui', projects: 'zc.projects' };

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function save(key, value, quiet) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch {
      if (!quiet) toast('Could not save — browser storage is full or blocked');
      return false;
    }
  }

  const settings = Object.assign(
    { name: '', apiKey: '', maxTokens: '', model: 'auto', about: '', system: 'You are Zero Code, an expert software engineer. Give correct, concise answers. Put code in fenced blocks with a language tag.' },
    load(KEYS.settings, {})
  );
  // v1 always sent max_tokens=4096, which reasoning models can burn entirely on thinking.
  // Empty now means "let the model decide"; move users still on the old default to it.
  if (!settings.v) { if (Number(settings.maxTokens) === 4096) settings.maxTokens = ''; settings.v = 2; save(KEYS.settings, settings); }
  let chats = load(KEYS.chats, []);
  let ui = Object.assign({ sideClosed: false, panelClosed: false }, load(KEYS.ui, {}));
  let currentId = null;
  let streaming = null; // { controller, chatId }
  let pendingFiles = []; // { name, text } or { name, image: dataUrl }
  let models = [];
  let view = 'chat'; // chat | templates | history | gateway
  let gwTimer = 0;

  const MAX_FILE_BYTES = 200 * 1024;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGES = 6;
  const IMAGE_MAX_SIDE = 1568; // what vision models downscale to anyway

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id);
  const shell = $('shell');
  const scroll = $('scroll');
  const welcome = $('welcome');
  const thread = $('thread');
  const templatesView = $('templates');
  const input = $('input');
  const composer = $('composer');
  const counter = $('counter');
  const chatList = $('chat-list');
  const searchInput = $('search');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
  };

  // ---------- markdown (small, escape-first) ----------
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>');
  }

  function renderTable(rows) {
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
    const head = cells(rows[0]);
    let h = '<table><thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
    for (const r of rows.slice(2)) h += '<tr>' + cells(r).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
    return h + '</tbody></table>';
  }

  function renderBlocks(text) {
    const lines = esc(text).split('\n');
    let out = '';
    let para = [];
    let list = null; // { type, items }
    const flushPara = () => { if (para.length) { out += '<p>' + inline(para.join('<br>')) + '</p>'; para = []; } };
    const flushList = () => {
      if (list) { out += '<' + list.type + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.type + '>'; list = null; }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        flushPara(); flushList();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
        i--;
        out += renderTable(rows);
        continue;
      }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out += '<hr>'; continue; }
      if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out += '<blockquote>' + inline(m[1]) + '</blockquote>'; continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(m[1]); continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(m[1]); continue;
      }
      if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out;
  }

  // ---------- code block -> file name ----------
  const LANG_EXT = {
    python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
    html: 'html', css: 'css', scss: 'scss', json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1',
    ps1: 'ps1', ps: 'ps1', bat: 'bat', cmd: 'bat', batch: 'bat', java: 'java', go: 'go', golang: 'go', rust: 'rs', rs: 'rs',
    c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', ruby: 'rb', rb: 'rb', php: 'php', sql: 'sql',
    yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini', md: 'md', markdown: 'md', xml: 'xml', kotlin: 'kt', kt: 'kt',
    swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', vue: 'vue', svelte: 'svelte', env: 'env', txt: 'txt', text: 'txt'
  };
  const KNOWN_EXT = new Set([...Object.values(LANG_EXT), 'mjs', 'cjs', 'jsonc', 'csv', 'svg', 'cfg', 'conf', 'lock', 'gitignore',
    'dockerignore', 'gradle', 'properties', 'hpp', 'cc', 'scala', 'pl', 'ex', 'exs', 'hs', 'jl', 'less', 'sass', 'graphql', 'proto']);
  const knownFile = (n) => KNOWN_EXT.has(n.split('.').pop().toLowerCase());
  const FILE_RE = /(?:^|[\s`*"'(])((?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.[a-z0-9]{1,8})(?=$|[\s`*"'):,])/gi;

  // Best guess at the file a code block belongs to: a comment naming it on the first line,
  // else the last file name mentioned just before the block, else "<lang>.<ext>".
  function guessFileName(lang, code, before) {
    const l = (lang || '').toLowerCase().split(/[\s{]/)[0];
    if (l === 'dockerfile') return 'Dockerfile';
    if (l === 'makefile') return 'Makefile';
    const first = (code.split('\n')[0] || '').trim();
    const cm = first.match(/^(?:#|\/\/|--|;|\/\*|<!--)\s*(?:file(?:name)?\s*:\s*)?((?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.[a-z0-9]{1,8})\s*(?:\*\/|-->)?$/i);
    if (cm && knownFile(cm[1])) return cm[1];
    const tail = (before || '').slice(-400);
    let m, last = null;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(tail))) if (knownFile(m[1]) && !/^\d+(\.\d+)+$/.test(m[1])) last = m[1];
    if (last) return last;
    const ext = LANG_EXT[l] || (/^[a-z0-9]{1,6}$/.test(l) ? l : 'txt');
    return (l === 'python' || l === 'py' ? 'main' : 'code') + '.' + ext;
  }

  function safeFileName(name) {
    const base = String(name || 'code.txt').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
    return base || 'code.txt';
  }

  async function saveCodeFile(name, text) {
    name = safeFileName(name);
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        const w = await handle.createWritable();
        await w.write(text.endsWith('\n') ? text : text + '\n');
        await w.close();
        toast(`Saved ${handle.name}`);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the dialog
        // Anything else (e.g. blocked in this context): fall back to a download.
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text.endsWith('\n') ? text : text + '\n'], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Downloaded ${name}`);
  }

  function markdown(src) {
    // Split on ``` fences; odd parts are code. An unclosed fence while streaming
    // naturally renders the tail as code.
    const parts = src.split(/^```/m);
    let html = '';
    parts.forEach((part, idx) => {
      if (idx % 2 === 0) { html += renderBlocks(part); return; }
      const nl = part.indexOf('\n');
      const lang = nl === -1 ? part.trim() : part.slice(0, nl).trim();
      const code = nl === -1 ? '' : part.slice(nl + 1).replace(/\n$/, '');
      const file = safeFileName(guessFileName(lang, code, parts[idx - 1]));
      html += '<pre><div class="code-head"><span class="code-lang">' + esc(lang || 'code') + '</span>' +
        '<span class="code-actions"><button type="button" data-copy-code title="Copy code">' + ICON.copy + 'Copy</button>' +
        '<button type="button" data-save-code="' + esc(file) + '" title="Save as ' + esc(file) + '">' + ICON.save + 'Save file</button></span>' +
        '</div><code>' + esc(code) + '</code></pre>';
    });
    return html;
  }

  // ---------- chats ----------
  // Images make chats big. If storage is full, drop image data from the oldest chats first
  // (the thread keeps a placeholder) until everything fits.
  function persistChats() {
    if (save(KEYS.chats, chats, true)) return;
    const withImages = chats
      .filter((c) => c.messages.some((m) => m.images && m.images.length))
      .sort((a, b) => a.updated - b.updated);
    for (const c of withImages) {
      for (const m of c.messages) if (m.images && m.images.length) { m.imagesDropped = (m.imagesDropped || 0) + m.images.length; m.images = []; }
      if (save(KEYS.chats, chats, true)) { toast('Browser storage full — removed images from older chats'); return; }
    }
    save(KEYS.chats, chats);
  }
  function getChat(id) { return chats.find((c) => c.id === id) || null; }
  function current() { return getChat(currentId); }

  function newChat() {
    if (streaming) stopStreaming();
    currentId = null;
    draftProject = null;
    pendingFiles = [];
    renderAttachments();
    showView('chat');
    renderThread();
    renderChatList();
    input.focus();
    closeOverlays();
  }

  function openChat(id) {
    if (streaming && streaming.chatId !== id) stopStreaming();
    currentId = id;
    showView('chat');
    renderThread();
    renderChatList();
    scrollToBottom(true);
    closeOverlays();
  }

  function deleteChat(id) {
    const c = getChat(id);
    if (!c) return;
    if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
    if (streaming && streaming.chatId === id) stopStreaming();
    chats = chats.filter((x) => x.id !== id);
    persistChats();
    if (currentId === id) currentId = null;
    renderThread();
    renderChatList();
  }

  function titleFrom(text) {
    const t = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
    return (t.length > 48 ? t.slice(0, 48) + '…' : t) || 'New chat';
  }

  function previewOf(chat) {
    const last = [...chat.messages].reverse().find((m) => m.content || m.error || (m.images && m.images.length));
    if (!last) return '…';
    if (!last.content && !last.error) return '🖼 Image';
    const t = (last.error ? 'Error: ' + last.error : last.content).replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 90) || '…';
  }

  // ---------- rendering ----------
  function renderChatList() {
    const q = searchInput.value.trim().toLowerCase();
    const sorted = [...chats].sort((a, b) => b.updated - a.updated);
    const shown = q
      ? sorted.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => (m.content || '').toLowerCase().includes(q)))
      : sorted;
    $('chat-count').textContent = `(${chats.length})`;
    $('nav-count').textContent = String(chats.length);
    if (view === 'history') renderHistory();
    if (!shown.length) {
      chatList.innerHTML = `<div class="chat-empty">${q ? 'No chats match your search.' : 'No chats yet.<br>Start one from the composer.'}</div>`;
      return;
    }
    chatList.innerHTML = shown.map((c) => `
      <div class="chat-card${c.id === currentId ? ' active' : ''}" data-id="${c.id}" role="button" tabindex="0">
        ${c.projectId && getProject(c.projectId) ? `<span class="c-proj">${esc(getProject(c.projectId).name)}</span>` : ''}
        <span class="c-title">${esc(c.title)}</span>
        <span class="c-prev">${esc(previewOf(c))}</span>
        <button class="c-del" data-del="${c.id}" title="Delete chat" aria-label="Delete chat">${ICON.trash}</button>
      </div>`).join('');
  }

  function msgHtml(m, i, isLast) {
    if (m.role === 'user') {
      const files = (m.files || []).map((f) => `<span class="file-chip">${ICON.file}${esc(f)}</span>`).join('');
      const imgs = (m.images || []).map((u) => `<img class="msg-img" src="${esc(u)}" alt="Attached image" data-zoom>`).join('')
        + (m.imagesDropped ? `<span class="file-chip">${m.imagesDropped} image${m.imagesDropped === 1 ? '' : 's'} removed to save space</span>` : '');
      const text = m.display ?? m.content;
      return `<div class="msg user" data-i="${i}">
        ${imgs ? `<div class="msg-imgs">${imgs}</div>` : ''}
        ${files || text ? `<div class="bubble">${files ? files + (text ? '<br>' : '') : ''}${esc(text || '')}</div>` : ''}
      </div>`;
    }
    const thinking = !!m.reasoning && !m.content && !m.done;
    let think = '';
    if (m.reasoning) {
      const label = thinking ? 'Thinking…' : m.thinkMs ? `Thought for ${Math.max(1, Math.round(m.thinkMs / 1000))}s` : 'Thoughts';
      const open = m.thinkOpen ?? thinking;
      const text = m.reasoning.length > 20000 ? '…' + m.reasoning.slice(-20000) : m.reasoning;
      think = `<details class="think${thinking ? ' live' : ''}" ${open ? 'open' : ''}><summary>${label}</summary><div class="think-body">${esc(text)}</div></details>`;
    }
    let body;
    if (m.error) body = think + `<div class="err">${esc(m.error)}</div>` + (m.content ? `<div class="md">${markdown(m.content)}</div>` : '');
    else if (!m.content) body = think || '<div class="typing"><i></i><i></i><i></i></div>';
    else body = think + `<div class="md">${markdown(m.content)}</div>`;
    const meta = m.done || m.error
      ? `<div class="meta">
          ${m.content ? `<button data-copy-msg="${i}">${ICON.copy}Copy</button>` : ''}
          ${isLast ? `<button data-retry>${ICON.retry}Retry</button>` : ''}
          ${m.model ? `<span>${esc(m.model)}</span>` : ''}
          ${m.truncated && m.content ? '<span class="warn-txt">Cut off at the output limit</span>' : ''}
        </div>`
      : '';
    return `<div class="msg assistant" data-i="${i}"><div class="av"><img src="logo.svg" alt=""></div><div class="body">${body}${meta}</div></div>`;
  }

  function renderThread() {
    if (view !== 'chat') return;
    updateProjectUi();
    updateHash();
    const chat = current();
    const hasMsgs = !!(chat && chat.messages.length);
    welcome.classList.toggle('hidden', hasMsgs);
    thread.classList.toggle('hidden', !hasMsgs);
    $('page-title').textContent = hasMsgs ? chat.title : 'AI Chat';
    document.title = hasMsgs ? `${chat.title} · Zero Code` : 'Zero Code';
    if (!hasMsgs) { thread.innerHTML = ''; return; }
    const n = chat.messages.length;
    thread.innerHTML = chat.messages.map((m, i) => msgHtml(m, i, i === n - 1)).join('');
  }

  // Re-render only the streaming message, throttled to one paint per frame.
  let rafPending = false;
  function updateStreamingMessage() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const chat = current();
      if (!chat || !streaming || streaming.chatId !== chat.id) return;
      const i = chat.messages.length - 1;
      const node = thread.querySelector(`.msg[data-i="${i}"]`);
      if (!node) { renderThread(); return; }
      const stick = nearBottom();
      node.outerHTML = msgHtml(chat.messages[i], i, true);
      // Keep the live thinking box pinned to its newest text.
      const tb = thread.querySelector(`.msg[data-i="${i}"] .think.live .think-body`);
      if (tb) tb.scrollTop = tb.scrollHeight;
      if (stick) scrollToBottom(true);
    });
  }

  function nearBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120; }
  function scrollToBottom(force) { if (force || nearBottom()) scroll.scrollTop = scroll.scrollHeight; }

  const VIEW_TITLES = { projects: 'Projects', templates: 'Templates', history: 'History', models: 'Models', gateway: 'Gateway' };

  // ---------- location hash: survive refresh, allow links + back/forward ----------
  // #/chat/<id>  #/new[?project=<id>]  #/projects[/<id>]  #/templates #/history #/models #/gateway
  function routeHash() {
    if (view === 'chat') {
      if (currentId && getChat(currentId)) return '#/chat/' + currentId;
      return draftProject ? '#/new?project=' + draftProject : '#/new';
    }
    if (view === 'projects' && pv.sel) return '#/projects/' + pv.sel;
    return '#/' + view;
  }
  function updateHash() {
    const h = routeHash();
    if (location.hash === h) return;
    // A different chat or page is a new history entry; everything else just replaces it.
    const cur = location.hash;
    const samePage = (cur.split('/')[1] === h.split('/')[1] && !cur.startsWith('#/chat/') && !h.startsWith('#/chat/'))
      || (cur.startsWith('#/new') && h.startsWith('#/chat/')); // first message turned the draft into a chat
    if (samePage || !cur) history.replaceState(null, '', h);
    else history.pushState(null, '', h);
  }
  function applyRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const [path, query] = h.split('?');
    const [name, arg] = path.split('/');
    if (name === 'chat' && arg && getChat(arg)) { currentId = arg; draftProject = null; showView('chat'); scrollToBottom(true); return true; }
    if (name === 'new') {
      currentId = null;
      const pid = new URLSearchParams(query || '').get('project');
      draftProject = pid && getProject(pid) ? pid : null;
      showView('chat');
      return true;
    }
    if (name === 'projects') { pv.sel = arg && getProject(arg) ? arg : null; showView('projects'); return true; }
    if (['templates', 'history', 'models', 'gateway'].includes(name)) { showView(name); return true; }
    return false;
  }

  function showView(next) {
    view = next;
    for (const k of Object.keys(VIEW_TITLES)) $(k).classList.toggle('hidden', k !== next);
    $('composer-wrap').classList.toggle('hidden', next !== 'chat' && next !== 'templates');
    document.querySelectorAll('#nav > button').forEach((b) => b.classList.toggle('active', b.dataset.view === next));
    if (next === 'chat') {
      renderThread();
    } else {
      welcome.classList.add('hidden');
      thread.classList.add('hidden');
      $('page-title').textContent = VIEW_TITLES[next];
      document.title = `${VIEW_TITLES[next]} · Zero Code`;
      scroll.scrollTop = 0;
    }
    if (next === 'history') renderHistory();
    if (next === 'projects') renderProjects();
    $('chat-project').classList.toggle('hidden', next !== 'chat');
    if (next === 'models') { renderModelsView(); loadModelsView(); startModelsPoll(); }
    else stopModelsPoll();
    updateHash();
    if (next === 'gateway') startGateway();
    else stopGateway();
  }

  // ---------- history view ----------
  function fmtWhen(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function groupLabel(ts) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const day = 86400000;
    if (ts >= start.getTime()) return 'Today';
    if (ts >= start.getTime() - day) return 'Yesterday';
    if (ts >= start.getTime() - 7 * day) return 'Previous 7 days';
    if (ts >= start.getTime() - 30 * day) return 'Previous 30 days';
    return 'Older';
  }

  // Snippet around the first match, escaped, with the match highlighted.
  function snippet(text, q) {
    const flat = text.replace(/\s+/g, ' ');
    const i = flat.toLowerCase().indexOf(q);
    if (i === -1) return null;
    const from = Math.max(0, i - 40);
    return (from ? '…' : '') + esc(flat.slice(from, i)) + '<mark>' + esc(flat.slice(i, i + q.length)) + '</mark>' + esc(flat.slice(i + q.length, i + q.length + 90));
  }

  function renderHistory() {
    const q = $('history-search').value.trim().toLowerCase();
    const totalMsgs = chats.reduce((n, c) => n + c.messages.length, 0);
    $('history-sub').textContent = `${chats.length} chat${chats.length === 1 ? '' : 's'} · ${totalMsgs} message${totalMsgs === 1 ? '' : 's'} saved in this browser.`;
    const list = $('history-list');
    const rows = [];
    for (const c of [...chats].sort((a, b) => b.updated - a.updated)) {
      let prev = esc(previewOf(c));
      if (q) {
        let hit = c.title.toLowerCase().includes(q) ? prev : null;
        if (hit === null) {
          for (const m of c.messages) {
            const sn = snippet(m.display ?? m.content ?? '', q);
            if (sn) { hit = sn; break; }
          }
        }
        if (hit === null) continue;
        prev = hit;
      }
      rows.push({ c, prev });
    }
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state">${q ? 'No chats match your search.' : 'No chats yet. Start one with New chat.'}</div>`;
      return;
    }
    const groups = new Map();
    for (const r of rows) {
      const g = groupLabel(r.c.updated);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    list.innerHTML = [...groups].map(([label, items]) => `
      <section class="h-group">
        <h3>${label}</h3>
        <div class="h-rows">
          ${items.map(({ c, prev }) => {
            const lastModel = [...c.messages].reverse().find((m) => m.model)?.model;
            const n = c.messages.length;
            return `<div class="h-row" data-id="${c.id}" role="button" tabindex="0">
              <div style="min-width:0"><div class="h-title">${esc(c.title)}</div><div class="h-prev">${prev}</div></div>
              <div class="h-meta">${n} msg${n === 1 ? '' : 's'}${lastModel ? ' · ' + esc(lastModel) : ''}<br>${esc(fmtWhen(c.updated))}</div>
              <button class="c-del" data-del="${c.id}" title="Delete chat" aria-label="Delete chat">${ICON.trash}</button>
            </div>`;
          }).join('')}
        </div>
      </section>`).join('');
  }

  // ---------- gateway view ----------
  function startGateway() {
    loadGateway();
    clearInterval(gwTimer);
    gwTimer = setInterval(() => { if (!document.hidden) loadGateway(); }, 5000);
  }
  function stopGateway() { clearInterval(gwTimer); gwTimer = 0; }

  async function api(path) {
    const res = await fetch('/api' + path, { headers: headers() });
    if (res.status === 401) throw new Error('The gateway has a proxy key set. Add it in Settings to see this page.');
    if (!res.ok) {
      let msg = `Gateway returned HTTP ${res.status}`;
      try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch { }
      throw new Error(String(msg));
    }
    return res.json();
  }

  const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Number(n || 0).toLocaleString());
  const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
  function fmtDur(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function setGatewayDot(ok) { $('nav-status').className = 'nav-status ' + (ok ? 'ok' : 'err'); }

  async function loadGateway() {
    const errBox = $('gw-error');
    try {
      const errorsOnly = $('gw-errors-only').checked;
      const [status, stats, health, logs] = await Promise.all([
        api('/status'), api('/stats'), api('/health'), api('/logs?limit=50' + (errorsOnly ? '&errors=1' : ''))
      ]);
      if (view !== 'gateway') return;
      errBox.classList.add('hidden');
      setGatewayDot(true);
      renderGateway(status, stats, health.candidates || [], logs.logs || []);
    } catch (e) {
      if (view !== 'gateway') return;
      setGatewayDot(false);
      errBox.textContent = e.message === 'Failed to fetch' ? 'Cannot reach the ZeroCode gateway. Is it running?' : e.message;
      errBox.classList.remove('hidden');
    }
  }

  function renderGateway(status, stats, health, logs) {
    const t = stats.totals || {};
    const rate = t.requests ? Math.round((t.ok / t.requests) * 100) : 0;
    const live = health.filter((h) => h.enabled !== false);
    const healthy = live.filter((h) => h.state === 'healthy').length;
    $('gw-sub').textContent = `ZeroCode v${status.version} on ${status.host}:${status.port} · route "${status.routeName}" · ${status.strategy}`;
    const tile = (label, value, sub) => `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div><div class="t-sub">${sub}</div></div>`;
    $('gw-tiles').innerHTML =
      tile('Status', '<span class="pill ok">Online</span>', `up ${fmtDur(status.uptimeMs)} · ${healthy}/${live.length} healthy`) +
      tile('Requests', fmtNum(t.requests || 0), `${rate}% success · ${fmtNum(t.failed || 0)} failed`) +
      tile('Avg latency', fmtMs(t.avgLatencyMs), 'across all requests') +
      tile('Tokens', fmtNum((t.tokensIn || 0) + (t.tokensOut || 0)), `${fmtNum(t.tokensIn || 0)} in · ${fmtNum(t.tokensOut || 0)} out`);

    const byLabel = new Map((stats.candidates || []).map((c) => [c.label, c]));
    const statePill = (h) => h.enabled === false ? '<span class="pill off">Disabled</span>'
      : h.state === 'healthy' ? '<span class="pill ok">Healthy</span>'
      : h.state === 'cooldown' ? `<span class="pill warn">Cooldown ${Math.ceil((h.remainingMs || 0) / 1000)}s</span>`
      : '<span class="pill off">Unavailable</span>';
    $('gw-route').innerHTML = '<thead><tr><th class="num">#</th><th>Model</th><th>State</th><th class="num">Requests</th><th class="num">Success</th><th class="num">Avg latency</th><th>Last error</th></tr></thead><tbody>' +
      (health.length ? health.map((h, i) => {
        const st = byLabel.get(`${h.provider}/${h.model}`);
        const lastErr = h.lastError || (st && st.lastError) || '';
        return `<tr>
          <td class="num">${i + 1}</td>
          <td class="mono">${esc(h.provider)}/${esc(h.model)}</td>
          <td>${statePill(h)}</td>
          <td class="num">${st ? fmtNum(st.requests) : '—'}</td>
          <td class="num">${st && st.requests ? Math.round((st.ok / st.requests) * 100) + '%' : '—'}</td>
          <td class="num">${st ? fmtMs(st.avgLatencyMs) : '—'}</td>
          <td class="errtxt${h.state === 'cooldown' ? '' : ' past'}">${esc(lastErr.slice(0, 160))}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="7" class="empty">No models on the route. Add some in the full dashboard.</td></tr>') + '</tbody>';

    $('gw-logs').innerHTML = '<thead><tr><th>Time</th><th>Requested</th><th>Served by</th><th>Status</th><th class="num">Latency</th><th class="num">Tokens in / out</th><th class="num">Tries</th></tr></thead><tbody>' +
      (logs.length ? logs.map((l) => `<tr>
          <td class="num">${esc(new Date(l.ts).toLocaleTimeString())}</td>
          <td class="mono">${esc(l.requested)}</td>
          <td class="mono">${esc(l.servedBy || '—')}${l.error ? `<div class="errtxt">${esc(l.error.slice(0, 160))}</div>` : ''}</td>
          <td>${l.ok ? `<span class="pill ok">${esc(l.httpStatus || 'OK')}</span>` : `<span class="pill err">${esc(l.httpStatus || 'Error')}</span>`}</td>
          <td class="num">${fmtMs(l.latencyMs)}${l.ttftMs != null && l.stream ? `<div class="muted">first ${fmtMs(l.ttftMs)}</div>` : ''}</td>
          <td class="num">${l.tokensIn != null || l.tokensOut != null ? `${fmtNum(l.tokensIn || 0)} / ${fmtNum(l.tokensOut || 0)}` : '—'}</td>
          <td class="num">${l.attempts || 1}</td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty">No requests yet.</td></tr>') + '</tbody>';
  }

  // ---------- starters + templates ----------
  const STARTERS = [
    { name: 'Write code', tone: 'tone-amber', icon: '<svg viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>',
      prompt: 'Write a function that ' },
    { name: 'Fix a bug', tone: 'tone-sky', icon: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7V4M9 4l1.5 3M15 4l-1.5 3M3 12h4M17 12h4M4 18l3-1.5M20 18l-3-1.5"/></svg>',
      prompt: 'This code has a bug. Find it, explain the cause, and give a fixed version:\n\n```\n\n```' },
    { name: 'Explain code', tone: 'tone-lime', icon: '<svg viewBox="0 0 24 24"><path d="M4 5h11a5 5 0 0 1 5 5v9H9a5 5 0 0 1-5-5z"/><path d="M9 10h6M9 14h4"/></svg>',
      prompt: 'Explain what this code does, step by step, and point out anything risky:\n\n```\n\n```' },
    { name: 'Write tests', tone: 'tone-rose', icon: '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/></svg>',
      prompt: 'Write unit tests for this code. Cover edge cases and failure paths:\n\n```\n\n```' }
  ];

  const TEMPLATES = [
    { tag: 'Build', title: 'REST API endpoint', prompt: 'Build an Express.js REST endpoint for `POST /items` that validates the JSON body, saves it, and returns 201 with the created item. Include error handling.' },
    { tag: 'Build', title: 'React component', prompt: 'Create a React component for a searchable, sortable table. Props: `rows`, `columns`. Use hooks, no external libraries.' },
    { tag: 'Build', title: 'CLI script', prompt: 'Write a Node.js CLI script that takes a folder path and prints the 10 largest files with their sizes. No dependencies.' },
    { tag: 'Fix', title: 'Debug an error', prompt: 'I get this error. Explain the likely cause and how to fix it:\n\n```\n\n```' },
    { tag: 'Fix', title: 'Speed up slow code', prompt: 'This code is slow. Find the bottleneck, explain why, and rewrite it faster:\n\n```\n\n```' },
    { tag: 'Review', title: 'Code review', prompt: 'Review this code for bugs, security issues and readability. List findings by severity, then show the improved version:\n\n```\n\n```' },
    { tag: 'Review', title: 'Security check', prompt: 'Audit this code for security problems (injection, auth, secrets, unsafe input). Explain each and show a fix:\n\n```\n\n```' },
    { tag: 'Learn', title: 'Explain a concept', prompt: 'Explain how JavaScript promises and async/await work, with a short example of each.' },
    { tag: 'Convert', title: 'Translate code', prompt: 'Convert this code from Python to TypeScript, keeping behavior identical:\n\n```python\n\n```' },
    { tag: 'Data', title: 'SQL query', prompt: 'Write a SQL query that returns the top 5 customers by total order value in the last 30 days. Tables: `customers(id, name)`, `orders(id, customer_id, total, created_at)`.' },
    { tag: 'Data', title: 'Regex', prompt: 'Write a regular expression that matches ' },
    { tag: 'Docs', title: 'Write a README', prompt: 'Write a clear README for this project: what it does, install, usage, config. Project details:\n\n' }
  ];

  function renderStarters() {
    $('starters').innerHTML = STARTERS.map((s, i) => `
      <button class="starter" data-starter="${i}">
        <span class="s-ico ${s.tone}">${s.icon}</span>
        <span class="s-name">${s.name}</span>
        <span class="s-plus">${ICON.plus}</span>
      </button>`).join('');
    $('tpl-grid').innerHTML = TEMPLATES.map((t, i) => `
      <button class="tpl" data-tpl="${i}">
        <em>${esc(t.tag)}</em><b>${esc(t.title)}</b><span>${esc(t.prompt)}</span>
      </button>`).join('');
  }

  function usePrompt(text) {
    showView('chat');
    input.value = text;
    autoGrow();
    input.focus();
    // Put the caret inside an empty code fence if there is one.
    const fence = text.indexOf('```\n\n```');
    const pyFence = text.indexOf('```python\n\n```');
    const pos = pyFence !== -1 ? pyFence + 10 : fence !== -1 ? fence + 4 : text.length;
    input.setSelectionRange(pos, pos);
  }

  // ---------- composer ----------
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
    counter.textContent = `${input.value.length.toLocaleString()} / 32,000`;
    composer.classList.toggle('has-text', !!input.value.trim() || pendingFiles.length > 0);
  }

  function renderAttachments() {
    composer.classList.toggle('has-text', !!input.value.trim() || pendingFiles.length > 0);
    $('attachments').innerHTML = pendingFiles.map((f, i) => f.image
      ? `<span class="img-chip"><img src="${esc(f.image)}" alt="${esc(f.name)}"><button type="button" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">${ICON.x}</button></span>`
      : `<span class="file-chip">${ICON.file}${esc(f.name)}<button type="button" data-unattach="${i}" aria-label="Remove">${ICON.x}</button></span>`).join('');
  }

  // Decode, downscale and re-encode as JPEG (PNG when it has transparency is not worth the size).
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // flatten transparency onto white for JPEG
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  async function addFiles(fileList) {
    for (const f of fileList) {
      if (f.type && f.type.startsWith('image/')) {
        if (pendingFiles.filter((x) => x.image).length >= MAX_IMAGES) { toast(`Up to ${MAX_IMAGES} images per message`); continue; }
        if (f.size > MAX_IMAGE_BYTES) { toast(`${f.name} is over 20 MB — skipped`); continue; }
        try {
          pendingFiles.push({ name: f.name || 'image.png', image: await loadImage(f) });
        } catch {
          toast(`${f.name || 'Image'} could not be read`);
        }
        continue;
      }
      if (f.size > MAX_FILE_BYTES) { toast(`${f.name} is over 200 KB — skipped`); continue; }
      const text = await f.text();
      if (/\u0000/.test(text.slice(0, 2000))) { toast(`${f.name} looks binary — attach text, code or image files`); continue; }
      pendingFiles.push({ name: f.name, text });
    }
    renderAttachments();
  }

  function setBusy(on) { composer.classList.toggle('busy', on); }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (settings.apiKey) h.Authorization = 'Bearer ' + settings.apiKey;
    return h;
  }

  function send(text) {
    text = text.trim();
    if (!text && !pendingFiles.length) return;
    if (streaming) return;
    if (!pendingFiles.length && handleSlashRemember(text)) return;

    let chat = current();
    if (!chat) {
      const firstText = pendingFiles.find((f) => !f.image);
      chat = { id: uid(), title: titleFrom(text || (firstText ? firstText.name : 'Image')), created: Date.now(), updated: Date.now(), messages: [] };
      if (draftProject && getProject(draftProject)) chat.projectId = draftProject;
      chats.push(chat);
      currentId = chat.id;
    }

    let content = text;
    const textFiles = pendingFiles.filter((f) => !f.image);
    const images = pendingFiles.filter((f) => f.image).map((f) => f.image);
    if (textFiles.length) {
      const blocks = textFiles.map((f) => {
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        return `File: ${f.name}\n\`\`\`${ext}\n${f.text}\n\`\`\``;
      }).join('\n\n');
      content = blocks + (text ? '\n\n' + text : '');
    }
    chat.messages.push({ role: 'user', content, display: text, files: textFiles.map((f) => f.name), images });
    pendingFiles = [];
    renderAttachments();
    input.value = '';
    try { sessionStorage.removeItem('zc.draft'); } catch { }
    autoGrow();
    runAssistant(chat);
  }

  async function runAssistant(chat) {
    const reply = { role: 'assistant', content: '', model: '', done: false };
    chat.messages.push(reply);
    chat.updated = Date.now();
    persistChats();
    renderThread();
    renderChatList();
    scrollToBottom(true);

    const history = chat.messages
      .slice(0, -1)
      .filter((m) => !m.error && (m.content || (m.images && m.images.length)))
      .map((m) => (m.images && m.images.length
        ? { role: m.role, content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))
          ] }
        : { role: m.role, content: m.content }));
    const hasImages = history.some((m) => Array.isArray(m.content));
    const sys = buildSystemPrompt(chat);
    const messages = sys ? [{ role: 'system', content: sys }, ...history] : history;

    const controller = new AbortController();
    let thinkStart = 0;
    streaming = { controller, chatId: chat.id };
    setBusy(true);

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(Object.assign(
          { model: settings.model || 'auto', messages, stream: true },
          Number(settings.maxTokens) > 0 ? { max_tokens: Number(settings.maxTokens) } : {}
        )),
        signal: controller.signal
      });
      const via = res.headers.get('x-zerocode-candidate');
      if (via) reply.model = via;

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j?.error?.message || msg; } catch { }
        if (res.status === 401) msg += ' — set the gateway proxy key in Settings.';
        throw new Error(msg);
      }

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) {
        // Gateway fell back to a non-streaming response.
        const j = await res.json();
        const msg = j?.choices?.[0]?.message || {};
        reply.content = msg.content || '';
        reply.reasoning = msg.reasoning_content || msg.reasoning || '';
        if (j?.choices?.[0]?.finish_reason === 'length') reply.truncated = true;
        if (!reply.model && j?.model) reply.model = j.model;
      } else {
        await readStream(res.body, (evt) => {
          if (evt.error) throw new Error(evt.error.message || 'stream error');
          const choice = evt.choices?.[0];
          const delta = choice?.delta;
          const think = delta?.reasoning_content || delta?.reasoning;
          if (think) {
            if (!reply.reasoning) { reply.reasoning = ''; thinkStart = Date.now(); }
            reply.reasoning += think;
            updateStreamingMessage();
          }
          if (delta?.content) {
            if (thinkStart && !reply.thinkMs) reply.thinkMs = Date.now() - thinkStart;
            reply.content += delta.content;
            updateStreamingMessage();
          }
          if (choice?.finish_reason === 'length') reply.truncated = true;
          if (!reply.model && evt.model) reply.model = evt.model;
        });
      }
      if (thinkStart && !reply.thinkMs) reply.thinkMs = Date.now() - thinkStart;
      if (!reply.content) {
        reply.error = reply.truncated && reply.reasoning
          ? (Number(settings.maxTokens) > 0
            ? `The model used its whole ${Number(settings.maxTokens).toLocaleString()}-token output limit thinking and never answered. Clear or raise "Max output tokens" in Settings, then Retry.`
            : 'The model hit its output limit while thinking and never answered. Retry, or pick another model.')
          : 'The model returned an empty reply. Try again or pick another model.';
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        if (!reply.content) reply.error = 'Stopped.';
      } else {
        const visionErr = hasImages && /image|vision|multimodal|content must be a string|modalit|not support|unsupported/i.test(e.message);
        reply.error = e.message === 'Failed to fetch'
          ? 'Cannot reach the ZeroCode gateway. Is it running?'
          : visionErr
            ? `This model can't read images. Pick a vision-capable model (for example a Gemini, GPT-4o/5, Claude, Qwen-VL or Llama 4 model) in the model picker, then Retry. (${e.message.slice(0, 200)})`
          : /upstream stream failed/i.test(e.message)
            ? `The provider dropped the connection mid-reply (${e.message.replace(/^upstream stream failed:\s*/i, '')}). Retry, or pick another model.`
            : e.message;
      }
    } finally {
      reply.done = true;
      streaming = null;
      setBusy(false);
      chat.updated = Date.now();
      persistChats();
      if (currentId === chat.id) { renderThread(); scrollToBottom(); }
      renderChatList();
      if (!reply.error) scheduleContinuity(chat);
    }
  }

  async function readStream(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        onEvent(evt);
      }
    }
  }

  function stopStreaming() {
    if (streaming) streaming.controller.abort();
  }

  function retryLast() {
    const chat = current();
    if (!chat || streaming) return;
    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === 'assistant') chat.messages.pop();
    if (!chat.messages.length) return;
    runAssistant(chat);
  }

  // ---------- models ----------
  async function loadModels() {
    const status = $('gateway-status');
    const pdot = $('profile-dot');
    try {
      const res = await fetch('/v1/models', { headers: headers() });
      if (res.status === 401) {
        status.innerHTML = '<span class="dot err"></span>proxy key needed';
        models = [{ id: 'auto' }];
      } else if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      } else {
        const j = await res.json();
        models = Array.isArray(j.data) ? j.data : [{ id: 'auto' }];
        setGatewayDot(true);
        pdot.className = 'profile-dot ok';
        status.innerHTML = `<span class="dot ok"></span>gateway online · ${models.length} model${models.length === 1 ? '' : 's'}`;
      }
    } catch {
      status.innerHTML = '<span class="dot err"></span>gateway offline';
      pdot.className = 'profile-dot err';
      setGatewayDot(false);
      models = [{ id: 'auto' }];
    }
    setModel(models.some((m) => m.id === settings.model) ? settings.model : 'auto');
  }

  // The gateway's virtual models get friendly names; real model ids show as-is.
  const isRouteAlias = (m) => m.id !== 'auto' && m.owned_by === 'zerocode' && !m.zerocode;
  function modelName(id) {
    if (id === 'auto') return 'Smart';
    const m = models.find((x) => x.id === id);
    return m && isRouteAlias(m) ? 'Smart Route' : id;
  }

  function modelSub(m) {
    if (m.id === 'auto') return 'Picks a working model for you, falls back on failure';
    if (isRouteAlias(m)) return `Follows your "${m.id}" route in order`;
    if (m.zerocode) return 'via ' + m.zerocode.provider;
    return m.owned_by ? 'via ' + m.owned_by : '';
  }

  // The top bar and the composer each have a picker; both show the same list.
  const MODEL_PICKERS = [['model-btn', 'model-menu'], ['cmodel-btn', 'cmodel-menu']];

  function renderModelMenu() {
    const html = models.length
      ? models.map((m) => `
        <button type="button" role="option" data-model="${esc(m.id)}" class="${m.id === settings.model ? 'sel' : ''}" aria-selected="${m.id === settings.model}">
          <span class="m-id">${esc(modelName(m.id))}</span><span class="m-sub">${esc(modelSub(m))}</span>
        </button>`).join('')
      : '<div class="m-empty">No models on your route yet. Add providers in the Gateway dashboard.</div>';
    for (const [, menuId] of MODEL_PICKERS) $(menuId).innerHTML = html;
  }

  function setModel(id) {
    settings.model = id;
    save(KEYS.settings, settings);
    $('model-label').textContent = modelName(id);
    $('cmodel-label').textContent = modelName(id);
    $('footer-model').textContent = modelName(id);
    renderModelMenu();
  }

  // ---------- theme + layout ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === t));
  }
  function setTheme(t) {
    try { localStorage.setItem(KEYS.theme, t); } catch { }
    applyTheme(t);
  }

  const narrowSide = matchMedia('(max-width: 820px)');
  const narrowPanel = matchMedia('(max-width: 1100px)');

  function applyLayout() {
    shell.classList.toggle('side-closed', !narrowSide.matches && ui.sideClosed);
    shell.classList.toggle('panel-closed', !narrowPanel.matches && ui.panelClosed);
  }
  function closeOverlays() { shell.classList.remove('side-open', 'panel-open'); }

  function applyUser() {
    const name = (settings.name || '').trim() || 'You';
    $('user-name').textContent = name;
    $('user-avatar').textContent = name.charAt(0).toUpperCase();
    $('user-avatar-lg').textContent = name.charAt(0).toUpperCase();
  }

  // ---------- voice ----------
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $('voice');
    if (!SR) { btn.classList.add('hidden'); return; }
    let rec = null;
    btn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
      rec.onresult = (e) => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        input.value = base + t;
        autoGrow();
      };
      rec.onerror = (e) => { if (e.error !== 'aborted') toast('Voice input error: ' + e.error); };
      rec.onend = () => { rec = null; btn.classList.remove('rec'); $('voice-label').textContent = 'Voice'; input.focus(); };
      rec.start();
      btn.classList.add('rec');
      $('voice-label').textContent = 'Stop';
    });
  }

  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); toast(label || 'Copied'); }
    catch { toast('Copy failed — clipboard blocked'); }
  }

  // ---------- connectors (providers + route) ----------
  const CATALOG = [
    { key: 'openrouter', type: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', desc: 'Hundreds of models, many free', keyUrl: 'https://openrouter.ai/keys',
      hint: 'Get a free key at openrouter.ai/keys. Models ending in ":free" cost nothing.' },
    { key: 'groq', type: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', desc: 'Very fast open models, free tier', keyUrl: 'https://console.groq.com/keys',
      hint: 'Free key at console.groq.com/keys. Very fast open models with a generous free tier.' },
    { key: 'opencode', type: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', desc: 'Coding models, some free', keyUrl: 'https://opencode.ai',
      hint: 'Key from opencode.ai (console > API keys). Models ending in "-free" cost nothing.' },
    { key: 'opencode-go', type: 'opencode', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', desc: 'Flat-rate coding plan', keyUrl: 'https://opencode.ai',
      hint: 'Same key as OpenCode Zen, with an active Go plan. Curated coding models.' },
    { key: 'antigravity', type: 'antigravity', name: 'Google Antigravity', baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal', desc: 'Gemini and Claude models via Google sign-in', keyUrl: '',
      hint: 'Uses Google sign-in and the Antigravity / Code Assist model API. Configure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, then restart ZeroCode.' },
    { key: 'aihubmix', type: 'aihubmix', name: 'AIHubMix', baseUrl: 'https://aihubmix.com/v1', desc: 'One key for many vendors', keyUrl: 'https://console.aihubmix.com/token',
      hint: 'Key from console.aihubmix.com/token. Mostly paid credits; a few models are free.' },
    { key: 'gemini', type: 'custom', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', desc: 'Free tier with an AI Studio key', keyUrl: 'https://aistudio.google.com/apikey',
      hint: 'Free tier: create a key at aistudio.google.com/apikey. Rate-limited, and Google may use free-tier prompts to improve its products. Gemini models can read images.' },
    { key: 'deepseek', type: 'custom', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', desc: 'DeepSeek chat and reasoner', keyUrl: 'https://platform.deepseek.com/api_keys',
      hint: 'Paid API key from platform.deepseek.com.' },
    { key: 'mistral', type: 'custom', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', desc: 'Mistral and Codestral', keyUrl: 'https://console.mistral.ai/api-keys',
      hint: 'API key from console.mistral.ai.' },
    { key: 'together', type: 'custom', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', desc: 'Open models at scale', keyUrl: 'https://api.together.ai/settings/api-keys',
      hint: 'API key from your Together AI settings.' },
    { key: 'cerebras', type: 'custom', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', desc: 'Very fast inference', keyUrl: 'https://cloud.cerebras.ai',
      hint: 'API key from cloud.cerebras.ai.' },
    { key: 'ollama', type: 'custom', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', desc: 'Local models, no key', keyUrl: '',
      hint: 'Runs models on this computer. Start Ollama first; no API key needed.' },
    { key: 'lmstudio', type: 'custom', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', desc: 'Local models, no key', keyUrl: '',
      hint: 'Start the LM Studio local server first; no API key needed.' },
    { key: 'custom', type: 'custom', name: 'Custom endpoint', baseUrl: '', desc: 'Any OpenAI-compatible API', keyUrl: '',
      hint: 'Any OpenAI-compatible /v1 endpoint. Leave the key empty for local servers.' }
  ];
  const TONES = ['tone-sky', 'tone-amber', 'tone-lime', 'tone-rose'];

  const conn = { cfg: null, sel: null, models: {}, test: {}, filter: '', freeOnly: false, busy: false, error: '', testing: null, search: '' };

  function catalogFor(p) {
    return CATALOG.find((c) => c.key === p.id) || CATALOG.find((c) => c.baseUrl && c.baseUrl === p.baseUrl) || CATALOG.find((c) => c.key === p.type);
  }
  function providerStatus(p) {
    if (p.type === 'github') return ['err', 'Retired'];
    if (!p.enabled) return ['off', 'Off'];
    if (p.type === 'antigravity' || p.id === 'antigravity') {
      if (p.google && p.google.authenticated) return ['ok', 'Connected'];
      return ['warn', p.google && p.google.oauthConfigured ? 'Sign in' : 'OAuth setup'];
    }
    if (!p.hasKey && p.type !== 'custom') return ['warn', 'Needs key'];
    return ['ok', 'Connected'];
  }
  const routeCount = (pid) => conn.cfg.route.filter((c) => c.provider === pid).length;

  async function putConfig(body) {
    const res = await fetch('/api/config', { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (res.status === 401) throw new Error('The gateway has a proxy key set. Add it in Settings first.');
    if (!res.ok) throw new Error(`Gateway returned HTTP ${res.status}`);
    conn.cfg = await res.json();
    updateConnCount();
    loadModels();
  }

  function updateConnCount() {
    if (!conn.cfg) return;
    $('conn-count').textContent = String(conn.cfg.providers.filter((p) => providerStatus(p)[0] === 'ok').length);
    $('models-count').textContent = String(conn.cfg.route.filter((c) => c.enabled !== false).length);
  }

  async function openConnectors(selId) {
    closeOverlays();
    const dlg = $('conn-dlg');
    if (!dlg.open) dlg.showModal();
    conn.error = '';
    try {
      conn.cfg = await api('/config');
      updateConnCount();
    } catch (e) {
      conn.error = e.message === 'Failed to fetch' ? 'Cannot reach the ZeroCode gateway. Is it running?' : e.message;
    }
    if (conn.cfg && !conn.cfg.providers.some((p) => p.id === conn.sel)) conn.sel = null;
    if (selId) conn.sel = selId;
    // Default to OpenRouter (or the first connector) so the panel never opens empty.
    if (!conn.sel && conn.cfg && conn.cfg.providers.length) {
      conn.sel = (conn.cfg.providers.find((p) => p.id === 'openrouter') || conn.cfg.providers[0]).id;
    }
    renderConn();
    autoLoadModels(conn.sel);
  }

  // Load the model list for a connected provider the first time it's shown.
  function autoLoadModels(pid) {
    const p = conn.cfg && conn.cfg.providers.find((x) => x.id === pid);
    if (!p || conn.models[pid] || providerStatus(p)[0] !== 'ok') return;
    loadProviderModels(pid);
  }

  async function runConn(fn) {
    if (conn.busy) return;
    conn.busy = true;
    renderConn();
    try { await fn(); } catch (e) { toast(e.message); } finally { conn.busy = false; renderConn(); }
  }

  function renderConn() {
    const side = $('cx-side');
    const main = $('cx-main');
    if (!conn.cfg) {
      side.innerHTML = '';
      main.innerHTML = `<div class="cx-empty">${esc(conn.error || 'Loading…')}</div>`;
      return;
    }
    const providers = conn.cfg.providers;
    const available = CATALOG.filter((c) => c.type === 'custom'
      ? c.key === 'custom' || !providers.some((p) => p.baseUrl === c.baseUrl)
      : !providers.some((p) => p.id === c.key));

    const q = conn.search.trim().toLowerCase();
    const hit = (...s) => !q || s.some((x) => (x || '').toLowerCase().includes(q));
    const shownProviders = providers.map((p, i) => ({ p, i })).filter(({ p }) => hit(p.name, p.id, p.baseUrl));
    const shownAvailable = available.filter((c) => hit(c.name, c.desc));

    side.innerHTML = `
      <div class="cx-label">Connected <span class="muted">(${q ? `${shownProviders.length} of ` : ''}${providers.length})</span></div>
      ${shownProviders.map(({ p, i }) => {
        const [tone, label] = providerStatus(p);
        const n = routeCount(p.id);
        return `<button class="cx-item${p.id === conn.sel ? ' sel' : ''}" data-sel="${esc(p.id)}">
          <span class="cx-av ${TONES[i % TONES.length]}">${esc(p.name.charAt(0).toUpperCase())}</span>
          <span class="cx-txt"><b>${esc(p.name)}</b><small>${n} model${n === 1 ? '' : 's'} on route</small></span>
          <span class="pill ${tone}">${label}</span>
        </button>`;
      }).join('')}
      ${shownAvailable.length ? `<div class="cx-label">Add connector</div>` : ''}
      ${shownAvailable.map((c) => `<button class="cx-item add" data-add="${c.key}" ${conn.busy ? 'disabled' : ''}>
          <span class="cx-av plus">${ICON.plus}</span>
          <span class="cx-txt"><b>${esc(c.name)}</b><small>${esc(c.desc)}</small></span>
        </button>`).join('')}
      ${q && !shownProviders.length && !shownAvailable.length ? `<div class="cx-none">No connectors match “${esc(conn.search.trim())}”.</div>` : ''}`;

    const p = providers.find((x) => x.id === conn.sel);
    if (!p) {
      main.innerHTML = `<div class="cx-empty">
        <b>Pick a connector</b>
        <p>Select a provider on the left to set its API key and choose models, or add a new one.</p>
        <p class="muted">${conn.cfg.route.length} model${conn.cfg.route.length === 1 ? '' : 's'} on your route across ${providers.length} providers.</p>
      </div>`;
      return;
    }
    main.innerHTML = connDetailHtml(p);
  }

  function connVisibleModels(m) {
    const q = conn.filter.toLowerCase();
    return m.list.filter((x) => x.chat !== false && (!conn.freeOnly || x.free) && (!q || x.id.toLowerCase().includes(q)));
  }

  // Test every model currently shown (after filter / Free only), three at a time.
  async function testAllConnModels() {
    const pid = conn.sel;
    const m = conn.models[pid];
    if (conn.testing || !m || !m.list) return;
    const keys = connVisibleModels(m).slice(0, 300).map((x) => candKey({ provider: pid, model: x.id }));
    if (!keys.length) return;
    if (keys.length > 20 && !confirm(`Test ${keys.length} models? Each test sends one small request and may use quota.`)) return;
    conn.testing = { done: 0, total: keys.length };
    renderConn();
    const queue = keys.slice();
    const worker = async () => {
      while (queue.length) {
        await testModel(queue.shift());
        conn.testing.done++;
        renderConn();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const failed = keys.filter((k) => !mv.tests[k]?.ok).length;
    conn.testing = null;
    renderConn();
    toast(failed ? `${keys.length - failed} passed, ${failed} failed` : `All ${keys.length} models passed`);
  }

  function connTestPill(t) {
    if (!t || t.running) return '';
    return t.ok
      ? `<span class="pill ok">OK · ${t.ms} ms</span>`
      : `<span class="pill err" title="${esc(t.error)}">Failed</span>`;
  }

  function connDetailHtml(p) {
    const cat = catalogFor(p) || {};
    const [tone, label] = providerStatus(p);
    const custom = p.type === 'custom';
    const antigravity = p.type === 'antigravity' || p.id === 'antigravity';
    const removable = custom || p.type === 'github' || antigravity;
    const t = conn.test[p.id];
    const m = conn.models[p.id];
    const onRoute = new Set(conn.cfg.route.filter((c) => c.provider === p.id).map((c) => c.model));
    const dis = conn.busy ? 'disabled' : '';

    let modelsHtml;
    if (!m) {
      modelsHtml = `<div class="cx-note">Load the model list to add models to your route.</div>`;
    } else if (m.loading) {
      modelsHtml = `<div class="cx-note">Loading models…</div>`;
    } else if (m.error) {
      modelsHtml = `<div class="cx-note err">${esc(m.error)}</div>`;
    } else {
      const list = connVisibleModels(m);
      modelsHtml = list.length
        ? `<div class="cx-models">${list.slice(0, 300).map((x) => {
            const on = onRoute.has(x.id);
            const k = candKey({ provider: p.id, model: x.id });
            return `<div class="cx-model">
              <span class="cx-mid">${esc(x.id)}</span>
              ${x.free ? '<span class="pill ok">Free</span>' : ''}
              ${x.context ? `<span class="muted cx-ctx">${fmtNum(x.context)} ctx</span>` : ''}
              ${connTestPill(mv.tests[k])}
              <button class="btn sm ghost cx-test" data-test-model="${esc(k)}" ${mv.tests[k]?.running ? 'disabled' : ''}>${mv.tests[k]?.running ? 'Testing…' : 'Test'}</button>
              <button class="btn sm ${on ? 'on' : 'ghost'}" data-route="${esc(x.id)}" ${dis}>${on ? '✓ On route' : 'Add'}</button>
            </div>`;
          }).join('')}</div>${list.length > 300 ? `<div class="cx-note">Showing 300 of ${list.length}. Search to narrow down.</div>` : ''}`
        : `<div class="cx-note">No models match.</div>`;
    }
    // Route models this provider no longer lists (or before the list is loaded) stay removable.
    const listed = new Set((m && m.list) ? m.list.map((x) => x.id) : []);
    const orphans = [...onRoute].filter((id) => !listed.has(id));
    const orphanHtml = orphans.length ? `
      <div class="cx-sub">On your route</div>
      <div class="cx-models">${orphans.map((id) => `<div class="cx-model">
        <span class="cx-mid">${esc(id)}</span>
        <button class="btn sm on" data-route="${esc(id)}" ${dis}>✓ On route</button>
      </div>`).join('')}</div>` : '';

    const formHtml = antigravity
      ? `<div class="cx-form">
          <div class="cx-note">${p.google && p.google.oauthConfigured
            ? p.google.authenticated
              ? `Signed in${p.google.email ? ` as ${esc(p.google.email)}` : ''}. Your Google refresh token is stored locally in the ZeroCode data directory.`
              : 'Google OAuth is configured. Save changes below if needed, then sign in.'
            : 'Enter your Google OAuth client ID and secret here, or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the server environment.'}</div>
          <label>Google OAuth client ID<input id="cx-google-client-id" value="${esc(p.google && p.google.oauthClientId || '')}" placeholder="...apps.googleusercontent.com" autocomplete="off"></label>
          <label>Google OAuth client secret<input id="cx-google-client-secret" type="password" placeholder="${p.google && p.google.oauthConfigured ? 'Saved — leave blank to keep current secret' : 'Paste your OAuth client secret'}" autocomplete="new-password"></label>
          <div class="cx-actions"><button type="button" class="btn ghost sm" id="cx-google-client-save" ${dis}>Save OAuth settings</button><a class="btn ghost sm" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">Get OAuth client ID ↗</a><span class="muted">Stored in ZEROCODE_HOME/google-oauth-client.json.</span></div>
          <div class="cx-actions">
            <button type="button" class="btn primary sm" id="cx-google-login" ${dis} ${p.google && p.google.oauthConfigured ? '' : 'disabled'} title="${p.google && p.google.oauthConfigured ? 'Sign in with Google' : 'Save the OAuth client ID and secret below first.'}">${p.google && p.google.authenticated ? 'Reconnect Google' : 'Sign in with Google'}</button>
            ${p.google && p.google.authenticated ? '<button type="button" class="btn ghost sm danger" id="cx-google-logout" ' + dis + '>Sign out</button>' : ''}
            ${t ? `<span class="cx-test ${t.ok ? 'ok' : 'err'}">${esc(t.ok ? `Connected · ${t.count} models · ${t.ms} ms` : t.error || 'Test failed')}</span>` : ''}
          </div>
          ${p.google && p.google.oauthConfigured ? `<label style="margin-top:12px">Remote sign-in callback URL<input id="cx-google-url" placeholder="Paste the full localhost callback URL here"></label>
          <div class="cx-actions"><button type="button" class="btn ghost sm" id="cx-google-connect" ${dis}>Connect pasted URL</button><span class="muted">For remote installs, paste the URL from the browser address bar after Google redirects.</span></div>` : ''}
          ${removable ? `<div class="cx-actions"><button type="button" class="btn ghost sm danger" id="cx-remove" ${dis}>Remove connector</button></div>` : ''}
        </div>`
      : `<form class="cx-form" id="cx-form" autocomplete="off">
        ${custom ? `<label>Name<input name="name" value="${esc(p.name)}" maxlength="60" required></label>
        <label>Base URL<input name="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://example.com/v1" required></label>`
        : `<label>Base URL<input value="${esc(p.baseUrl)}" disabled></label>`}
        <label>API key
          <input name="apiKey" type="password" placeholder="${p.hasKey ? `Saved (${esc(p.keyHint)}) — paste to replace` : custom ? 'Optional for local servers' : 'Paste your API key'}">
        </label>
        <div class="cx-actions">
          <button type="submit" class="btn primary sm" ${dis}>Save &amp; test</button>
          ${removable ? `<button type="button" class="btn ghost sm danger" id="cx-remove" ${dis}>Remove</button>` : ''}
          ${p.id === 'antigravity' ? '<a class="btn ghost sm" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">Get OAuth client ID ↗</a>' : ''}
          <span class="cx-test ${t ? (t.ok ? 'ok' : 'err') : ''}">${t ? esc(t.ok ? `Connected · ${t.count} models · ${t.ms} ms` : t.error || 'Test failed') : ''}</span>
        </div>
      </form>`;

    return `
      <div class="cx-head">
        <div>
          <h4>${esc(p.name)} <span class="pill ${tone}">${label}</span></h4>
          <p class="muted">${esc(cat.hint || 'OpenAI-compatible endpoint.')}${cat.keyUrl ? ` <a href="${esc(cat.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a key ↗</a>` : ''}</p>
        </div>
        <label class="switch" title="Enable or disable">
          <input type="checkbox" id="cx-enabled" ${p.enabled ? 'checked' : ''} ${dis}><span></span>
        </label>
      </div>

      ${formHtml}

      <div class="cx-models-head">
        <div class="cx-sub">Models <span class="muted">(${onRoute.size} on route)</span></div>
        <div class="cx-tools">
          ${m && m.list ? `<input type="search" id="cx-filter" placeholder="Filter" value="${esc(conn.filter)}">
          <label class="check"><input type="checkbox" id="cx-free" ${conn.freeOnly ? 'checked' : ''}> Free only</label>
          <button class="btn ghost sm" id="cx-test-all" ${conn.testing ? 'disabled' : ''}>${conn.testing ? `Testing ${conn.testing.done}/${conn.testing.total}…` : 'Test all'}</button>` : ''}
          <button class="btn ghost sm" id="cx-load" ${dis}>${m && m.list ? 'Reload' : 'Load models'}</button>
        </div>
      </div>
      ${modelsHtml}
      ${orphanHtml}`;
  }

  async function loadProviderModels(pid) {
    conn.models[pid] = { loading: true };
    renderConn();
    try {
      const j = await api(`/providers/${encodeURIComponent(pid)}/models`);
      conn.models[pid] = { list: j.models || [] };
    } catch (e) {
      // The admin API returns the upstream reason in the JSON body.
      conn.models[pid] = { error: e.message };
    }
    renderConn();
  }

  async function refreshAntigravity(pid) {
    conn.cfg = await api('/config');
    updateConnCount();
    const response = await fetch('/api/providers/test', { method: 'POST', headers: headers(), body: JSON.stringify({ id: pid }) });
    conn.test[pid] = await response.json();
    if (conn.test[pid].ok) await loadProviderModels(pid);
  }

  async function saveGoogleOAuthClient() {
    const clientId = $('cx-google-client-id')?.value.trim() || '';
    const clientSecret = $('cx-google-client-secret')?.value || '';
    if (!clientId) { toast('Enter the Google OAuth client ID'); return; }
    if (conn.busy) return;
    conn.busy = true;
    renderConn();
    try {
      const response = await fetch('/api/google/client', {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ clientId, clientSecret })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Could not save OAuth settings (HTTP ${response.status})`);
      conn.cfg = await api('/config');
      updateConnCount();
      toast('Google OAuth settings saved');
    } catch (e) {
      toast(e.message || 'Could not save OAuth settings');
    } finally {
      conn.busy = false;
      renderConn();
    }
  }

  async function startGoogleLogin() {
    const pid = conn.sel;
    if (!pid || conn.busy) return;
    const provider = conn.cfg.providers.find((item) => item.id === pid);
    const wasConnected = !!(provider && provider.google && provider.google.authenticated);
    // Open synchronously from the click handler to avoid popup blockers.
    const popup = window.open('about:blank', 'zerocode-google', 'popup,width=520,height=720');
    conn.busy = true;
    renderConn();
    try {
      const response = await fetch('/api/google/login', { method: 'POST', headers: headers() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Google sign-in failed (HTTP ${response.status})`);
      if (popup) popup.location.href = result.url;
      else window.open(result.url, '_blank', 'noopener');
      toast('Complete Google sign-in in the opened window');
      for (let i = 0; i < 90; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await api('/google/status');
        let callbackComplete = false;
        try {
          const callbackUrl = new URL(popup.location.href);
          callbackComplete = callbackUrl.pathname === '/oauth2callback' && callbackUrl.searchParams.has('code') && callbackUrl.searchParams.has('state');
        } catch { }
        if (status.authenticated && (!wasConnected || callbackComplete)) {
          conn.busy = false;
          await refreshAntigravity(pid);
          toast('Google Antigravity connected');
          return;
        }
        if (popup && popup.closed) break;
      }
    } catch (e) {
      if (popup && !popup.closed) popup.close();
      toast(e.message || 'Google sign-in failed');
    } finally {
      conn.busy = false;
      renderConn();
    }
  }

  async function connectGoogleCallback() {
    const pid = conn.sel;
    const input = $('cx-google-url');
    const url = input ? input.value.trim() : '';
    if (!url) { toast('Paste the full Google redirect URL first'); return; }
    if (conn.busy) return;
    conn.busy = true;
    renderConn();
    try {
      const response = await fetch('/api/google/callback', { method: 'POST', headers: headers(), body: JSON.stringify({ url }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Google sign-in failed (HTTP ${response.status})`);
      conn.busy = false;
      await refreshAntigravity(pid);
      toast(`Google Antigravity connected${result.email ? ` as ${result.email}` : ''}`);
    } catch (e) {
      toast(e.message || 'Could not connect Google account');
    } finally {
      conn.busy = false;
      renderConn();
    }
  }

  async function signOutGoogle() {
    if (!confirm('Sign out of Google Antigravity on this ZeroCode instance?')) return;
    const response = await fetch('/api/google/logout', { method: 'POST', headers: headers() });
    if (!response.ok) { toast('Could not sign out'); return; }
    const pid = conn.sel;
    delete conn.models[pid];
    delete conn.test[pid];
    conn.cfg = await api('/config');
    updateConnCount();
    renderConn();
  }

  async function addConnector(key) {
    const c = CATALOG.find((x) => x.key === key);
    if (!c) return;
    await runConn(async () => {
      const ids = new Set(conn.cfg.providers.map((p) => p.id));
      let id = c.key;
      for (let i = 2; ids.has(id); i++) id = `${c.key}-${i}`;
      await putConfig({
        providers: [...conn.cfg.providers.map((p) => ({ id: p.id })), { id, name: c.name, type: c.type, baseUrl: c.baseUrl, enabled: true }]
      });
      conn.sel = id;
    });
    const input = $('cx-main').querySelector(c.key === 'custom' ? 'input[name="baseUrl"]' : 'input[name="apiKey"]');
    if (input) input.focus();
  }

  async function saveConnector(form) {
    const p = conn.cfg.providers.find((x) => x.id === conn.sel);
    if (!p) return;
    const fd = new FormData(form);
    const upd = { id: p.id };
    if (p.type === 'custom') {
      upd.name = String(fd.get('name') || '').trim();
      upd.baseUrl = String(fd.get('baseUrl') || '').trim();
      if (!/^https?:\/\//i.test(upd.baseUrl)) { toast('Base URL must start with http:// or https://'); return; }
    }
    const key = String(fd.get('apiKey') || '').trim();
    if (key) upd.apiKey = key;
    await runConn(async () => {
      await putConfig({ providers: conn.cfg.providers.map((x) => (x.id === p.id ? upd : { id: x.id })) });
      const res = await fetch('/api/providers/test', { method: 'POST', headers: headers(), body: JSON.stringify({ id: p.id }) });
      conn.test[p.id] = await res.json();
    });
    if (conn.test[p.id] && conn.test[p.id].ok && !(conn.models[p.id] && conn.models[p.id].list)) loadProviderModels(p.id);
  }

  function setEnabled(on) {
    const pid = conn.sel;
    runConn(() => putConfig({ providers: conn.cfg.providers.map((x) => (x.id === pid ? { id: x.id, enabled: on } : { id: x.id })) }));
  }

  function removeConnector() {
    const p = conn.cfg.providers.find((x) => x.id === conn.sel);
    if (!p) return;
    const n = routeCount(p.id);
    if (!confirm(`Remove ${p.name}?${n ? ` Its ${n} model${n === 1 ? '' : 's'} will be taken off your route.` : ''}`)) return;
    runConn(async () => {
      await putConfig({ providers: conn.cfg.providers.filter((x) => x.id !== p.id).map((x) => ({ id: x.id })) });
      delete conn.models[p.id];
      delete conn.test[p.id];
      conn.sel = null;
    });
  }

  function toggleRoute(model) {
    const pid = conn.sel;
    const route = conn.cfg.route.slice();
    const i = route.findIndex((c) => c.provider === pid && c.model === model);
    if (i === -1) route.push({ provider: pid, model });
    else route.splice(i, 1);
    runConn(() => putConfig({ route }));
  }

  function bindConnectors() {
    const dlg = $('conn-dlg');
    $('fab').addEventListener('click', () => openConnectors());
    $('open-connectors').addEventListener('click', () => openConnectors());
    $('conn-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

    $('cx-side').addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) { addConnector(add.dataset.add); return; }
      const sel = e.target.closest('[data-sel]');
      if (sel) { conn.sel = sel.dataset.sel; conn.filter = ''; renderConn(); autoLoadModels(conn.sel); }
    });
    $('cx-search').addEventListener('input', (e) => { conn.search = e.target.value; renderConn(); });
    const main = $('cx-main');
    main.addEventListener('submit', (e) => { e.preventDefault(); saveConnector(e.target); });
    main.addEventListener('click', (e) => {
      const r = e.target.closest('[data-route]');
      if (r) { toggleRoute(r.dataset.route); return; }
      const tb = e.target.closest('[data-test-model]');
      if (tb) {
        const k = tb.dataset.testModel;
        const run = testModel(k);
        renderConn();
        run.then(() => {
          const t = mv.tests[k];
          if (t && !t.ok) toast(`${k.slice(k.indexOf('::') + 2)}: ${t.error}`);
          renderConn();
        });
        return;
      }
      if (e.target.closest('#cx-load')) loadProviderModels(conn.sel);
      else if (e.target.closest('#cx-test-all')) testAllConnModels();
      else if (e.target.closest('#cx-remove')) removeConnector();
      else if (e.target.closest('#cx-google-login')) startGoogleLogin();
      else if (e.target.closest('#cx-google-client-save')) saveGoogleOAuthClient();
      else if (e.target.closest('#cx-google-connect')) connectGoogleCallback();
      else if (e.target.closest('#cx-google-logout')) signOutGoogle();
    });
    main.addEventListener('change', (e) => {
      if (e.target.id === 'cx-enabled') setEnabled(e.target.checked);
      else if (e.target.id === 'cx-free') { conn.freeOnly = e.target.checked; renderConn(); }
    });
    main.addEventListener('input', (e) => {
      if (e.target.id !== 'cx-filter') return;
      conn.filter = e.target.value;
      const pos = e.target.selectionStart;
      renderConn();
      const f = $('cx-filter');
      if (f) { f.focus(); f.setSelectionRange(pos, pos); }
    });
  }

  // ---------- models view (enable / disable route models) ----------
  const mv = { sel: new Set(), state: 'all', provider: '', q: '', health: [], stats: [], error: '', busy: false, tests: {}, checking: null, timer: 0 };
  const candKey = (c) => c.provider + '::' + c.model;

  async function loadModelsView() {
    try {
      const [cfg, health, stats] = await Promise.all([api('/config'), api('/health'), api('/stats')]);
      conn.cfg = cfg;
      mv.health = health.candidates || [];
      mv.stats = stats.candidates || [];
      mv.error = '';
      updateConnCount();
    } catch (e) {
      mv.error = e.message === 'Failed to fetch' ? 'Cannot reach the ZeroCode gateway. Is it running?' : e.message;
    }
    if (view === 'models') renderModelsView();
  }

  function modelsShown() {
    const q = mv.q.toLowerCase();
    return conn.cfg.route
      .map((c, i) => ({ c, i }))
      .filter(({ c }) =>
        (!mv.provider || c.provider === mv.provider) &&
        (mv.state === 'all' || (mv.state === 'on') === (c.enabled !== false)) &&
        (!q || (c.provider + '/' + c.model).toLowerCase().includes(q)));
  }

  // One health verdict per model: tone (ok|warn|err|off), label, detail line, last error.
  function modelHealth(c, p, h, st, test) {
    if (!p || !p.enabled) return { tone: 'off', label: 'Provider off', detail: 'Turn the provider on in Connectors' };
    if (h && h.state === 'no-key') return p.type === 'antigravity'
      ? { tone: 'off', label: 'Needs sign-in', detail: 'Sign in with Google in Connectors' }
      : { tone: 'off', label: 'Needs key', detail: 'Add an API key in Connectors' };
    if (test && test.running) return { tone: 'off', label: 'Testing…', detail: '' };
    const cooling = h && h.state === 'cooldown';
    const lastError = (cooling && h.lastError) || (test && !test.ok && test.error) || (st && st.lastError) || '';
    if (cooling) return { tone: 'warn', label: `Cooling down · ${Math.ceil((h.remainingMs || 0) / 1000)}s`, detail: 'Skipped after recent errors', lastError };
    // A fresh manual test is the most direct signal.
    if (test && Date.now() - test.at < 10 * 60 * 1000) {
      return test.ok
        ? { tone: 'ok', label: 'Healthy', detail: `Test passed · ${fmtMs(test.ms)}` }
        : { tone: 'err', label: 'Failing', detail: 'Test failed', lastError };
    }
    if (!st || !st.requests) return { tone: 'off', label: 'Untested', detail: 'No traffic yet — press Test' };
    const rate = st.ok / st.requests;
    const detail = `${Math.round(rate * 100)}% of ${fmtNum(st.requests)} req · avg ${fmtMs(st.avgLatencyMs)}`;
    if (rate >= 0.9) return { tone: 'ok', label: 'Healthy', detail, lastError: rate < 1 ? lastError : '' };
    if (rate >= 0.5) return { tone: 'warn', label: 'Unstable', detail, lastError };
    return { tone: 'err', label: 'Failing', detail, lastError };
  }

  function renderModelsView() {
    const errBox = $('models-error');
    errBox.classList.toggle('hidden', !mv.error);
    errBox.textContent = mv.error;
    const list = $('models-list');
    if (!conn.cfg) { list.innerHTML = ''; return; }

    const route = conn.cfg.route;
    const providers = new Map(conn.cfg.providers.map((p) => [p.id, p]));
    const on = route.filter((c) => c.enabled !== false).length;
    $('models-sub').textContent = `${on} of ${route.length} models enabled. Disabled models are skipped by Smart and hidden from the picker.`;

    // Provider filter: only providers that have models on the route.
    const pids = [...new Set(route.map((c) => c.provider))];
    if (mv.provider && !pids.includes(mv.provider)) mv.provider = '';
    $('models-provider').innerHTML = '<option value="">All providers</option>' +
      pids.map((id) => `<option value="${esc(id)}"${id === mv.provider ? ' selected' : ''}>${esc(providers.get(id)?.name || id)}</option>`).join('');
    document.querySelectorAll('#models-state button').forEach((b) => b.classList.toggle('on', b.dataset.state === mv.state));

    // Drop selections that no longer exist.
    const keys = new Set(route.map(candKey));
    for (const k of mv.sel) if (!keys.has(k)) mv.sel.delete(k);

    const shown = modelsShown();
    const shownKeys = shown.map(({ c }) => candKey(c));
    const selShown = shownKeys.filter((k) => mv.sel.has(k)).length;
    const all = $('models-all');
    all.checked = shown.length > 0 && selShown === shown.length;
    all.indeterminate = selShown > 0 && selShown < shown.length;
    all.disabled = !shown.length;
    $('models-sel-label').textContent = mv.sel.size ? `${mv.sel.size} selected` : `Select all (${shown.length})`;
    document.querySelectorAll('[data-bulk]').forEach((b) => {
      const verb = b.dataset.bulk === 'on' ? 'Enable' : 'Disable';
      b.textContent = mv.sel.size ? `${verb} selected` : `${verb} all shown`;
      b.disabled = mv.busy || (!mv.sel.size && !shown.length);
    });
    const rm = $('models-remove');
    rm.textContent = mv.sel.size ? `Remove selected` : 'Remove all shown';
    rm.disabled = mv.busy || (!mv.sel.size && !shown.length);

    if (!route.length) {
      list.innerHTML = '<div class="empty-state">No models on your route yet. Use <b>+ Add models</b> to pick some from a connector.</div>';
      return;
    }
    if (!shown.length) {
      list.innerHTML = '<div class="empty-state">No models match these filters.</div>';
      return;
    }
    const health = new Map(mv.health.map((h) => [h.provider + '::' + h.model, h]));
    const stats = new Map(mv.stats.map((s) => [s.label, s]));
    const dis = mv.busy ? 'disabled' : '';
    const verdicts = new Map(route.map((c) => [candKey(c),
      modelHealth(c, providers.get(c.provider), health.get(candKey(c)), stats.get(`${c.provider}/${c.model}`), mv.tests[candKey(c)])]));

    // Health summary across every model on the route, enabled or not.
    const counts = { ok: 0, warn: 0, err: 0, off: 0 };
    for (const c of route) counts[verdicts.get(candKey(c)).tone]++;
    $('models-health').innerHTML = [
      ['ok', 'Healthy'], ['warn', 'Unstable / cooling'], ['err', 'Failing'], ['off', 'Untested / unavailable']
    ].map(([t, l]) => `<div class="mh ${t}"><b>${counts[t]}</b><span>${l}</span></div>`).join('');
    const chk = $('models-check');
    chk.disabled = !!mv.checking || !shown.length;
    chk.textContent = mv.checking ? `Checking ${mv.checking.done}/${mv.checking.total}…` : `Check health (${shown.length})`;

    list.innerHTML = '<div class="h-rows">' + shown.map(({ c, i }) => {
      const k = candKey(c);
      const p = providers.get(c.provider);
      const v = verdicts.get(k);
      const testing = mv.tests[k] && mv.tests[k].running;
      return `<div class="m-row${c.enabled === false ? ' off' : ''}">
        <input type="checkbox" data-pick="${esc(k)}" ${mv.sel.has(k) ? 'checked' : ''} aria-label="Select ${esc(c.model)}">
        <span class="m-num">${i + 1}</span>
        <div class="m-main">
          <div class="m-name">${esc(c.model)}${c.enabled === false ? ' <span class="m-off">off</span>' : ''}</div>
          <div class="m-meta">${esc(p ? p.name : c.provider)}${v.detail ? ' · ' + esc(v.detail) : ''}</div>
          ${v.lastError ? `<div class="m-err" title="${esc(v.lastError)}">${esc(v.lastError.slice(0, 180))}</div>` : ''}
        </div>
        <span class="health ${v.tone}"><i></i>${esc(v.label)}</span>
        <button type="button" class="btn ghost sm m-test" data-test="${esc(k)}" ${testing || v.label === 'Needs key' || v.label === 'Provider off' ? 'disabled' : ''}>Test</button>
        <label class="switch" title="${c.enabled === false ? 'Enable' : 'Disable'}">
          <input type="checkbox" data-toggle="${esc(k)}" ${c.enabled === false ? '' : 'checked'} ${dis}><span></span>
        </label>
        <button type="button" class="icon-btn m-remove" data-remove="${esc(k)}" title="Remove from route" aria-label="Remove ${esc(c.model)} from route" ${dis}>
          <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </div>`;
    }).join('') + '</div>';
  }

  // Take models off the route entirely. They can be added back from Connectors.
  async function removeModels(keys) {
    if (!keys.size || mv.busy) return;
    const n = keys.size;
    const one = n === 1 ? [...keys][0] : '';
    if (!confirm(one
      ? `Remove ${one.slice(one.indexOf('::') + 2)} from your route? You can add it back from Connectors.`
      : `Remove ${n} models from your route? You can add them back from Connectors.`)) return;
    mv.busy = true;
    renderModelsView();
    try {
      await putConfig({ route: conn.cfg.route.filter((c) => !keys.has(candKey(c))) });
      for (const k of keys) { mv.sel.delete(k); delete mv.tests[k]; }
      toast(n === 1 ? 'Model removed' : `Removed ${n} models`);
    } catch (e) {
      toast(e.message);
    } finally {
      mv.busy = false;
      renderModelsView();
    }
  }

  async function setModelsEnabled(keys, on) {
    if (!keys.size || mv.busy) return;
    mv.busy = true;
    renderModelsView();
    try {
      const route = conn.cfg.route.map((c) => {
        if (!keys.has(candKey(c))) return c;
        const next = { provider: c.provider, model: c.model };
        if (!on) next.enabled = false;
        return next;
      });
      await putConfig({ route });
      const h = await api('/health');
      mv.health = h.candidates || [];
      if (keys.size > 1) toast(`${on ? 'Enabled' : 'Disabled'} ${keys.size} models`);
    } catch (e) {
      toast(e.message);
    } finally {
      mv.busy = false;
      renderModelsView();
    }
  }

  // Send a tiny pinned request straight to one model. Pinned ids bypass the on/off switch,
  // so disabled models can be checked before turning them back on.
  async function testModel(k) {
    const [provider, model] = [k.slice(0, k.indexOf('::')), k.slice(k.indexOf('::') + 2)];
    mv.tests[k] = { running: true, at: Date.now() };
    if (view === 'models') renderModelsView();
    const t0 = Date.now();
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        // Strict: a failing model must fail its test, not be answered by a fallback.
        headers: { ...headers(), 'x-zerocode-strict': '1' },
        body: JSON.stringify({ model: `${provider}/${model}`, stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] })
      });
      let err = '';
      if (!res.ok) {
        try { const j = await res.json(); err = (j.error && (j.error.message || j.error)) || ''; } catch { }
        err = String(err || `HTTP ${res.status}`);
      }
      mv.tests[k] = { ok: res.ok, ms: Date.now() - t0, error: err, at: Date.now() };
    } catch (e) {
      mv.tests[k] = { ok: false, ms: Date.now() - t0, error: e.message === 'Failed to fetch' ? 'Gateway unreachable' : e.message, at: Date.now() };
    }
  }

  async function checkHealth(keys) {
    if (mv.checking || !keys.length) return;
    mv.checking = { done: 0, total: keys.length };
    renderModelsView();
    const queue = keys.slice();
    const worker = async () => {
      while (queue.length) {
        await testModel(queue.shift());
        mv.checking.done++;
        if (view === 'models') renderModelsView();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    mv.checking = null;
    await loadModelsView();
    const failed = keys.filter((k) => mv.tests[k] && !mv.tests[k].ok).length;
    toast(failed ? `${keys.length - failed} healthy, ${failed} failing` : `All ${keys.length} models healthy`);
  }

  function startModelsPoll() {
    clearInterval(mv.timer);
    mv.timer = setInterval(() => { if (!document.hidden && !mv.busy) loadModelsView(); }, 10000);
  }
  function stopModelsPoll() { clearInterval(mv.timer); mv.timer = 0; }

  function bindModelsView() {
    $('models-check').addEventListener('click', () => {
      const ready = modelsShown()
        .map(({ c }) => candKey(c))
        .filter((k) => {
          const c = conn.cfg.route.find((x) => candKey(x) === k);
          const h = mv.health.find((x) => x.key === k);
          const p = conn.cfg.providers.find((x) => x.id === c.provider);
          return p && p.enabled && !(h && h.state === 'no-key');
        });
      if (!ready.length) { toast('No testable models here — add keys in Connectors first'); return; }
      checkHealth(ready);
    });
    $('models-add').addEventListener('click', () => openConnectors());
    $('models-search').addEventListener('input', (e) => { mv.q = e.target.value; renderModelsView(); });
    $('models-provider').addEventListener('change', (e) => { mv.provider = e.target.value; renderModelsView(); });
    $('models-state').addEventListener('click', (e) => {
      const b = e.target.closest('[data-state]');
      if (b) { mv.state = b.dataset.state; renderModelsView(); }
    });
    $('models-all').addEventListener('change', (e) => {
      for (const { c } of modelsShown()) {
        if (e.target.checked) mv.sel.add(candKey(c));
        else mv.sel.delete(candKey(c));
      }
      renderModelsView();
    });
    document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
      const on = b.dataset.bulk === 'on';
      const keys = mv.sel.size ? new Set(mv.sel) : new Set(modelsShown().map(({ c }) => candKey(c)));
      const n = keys.size;
      if (!on && n > 1 && !confirm(`Disable ${n} models? Smart will stop using them until you enable them again.`)) return;
      setModelsEnabled(keys, on).then(() => { mv.sel.clear(); renderModelsView(); });
    }));
    $('models-remove').addEventListener('click', () => {
      removeModels(mv.sel.size ? new Set(mv.sel) : new Set(modelsShown().map(({ c }) => candKey(c))));
    });
    $('models-list').addEventListener('click', (e) => {
      const rb = e.target.closest('[data-remove]');
      if (rb) { removeModels(new Set([rb.dataset.remove])); return; }
      const b = e.target.closest('[data-test]');
      if (b) testModel(b.dataset.test).then(() => loadModelsView());
    });
    $('models-list').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.toggle) setModelsEnabled(new Set([t.dataset.toggle]), t.checked);
      else if (t.dataset.pick) {
        if (t.checked) mv.sel.add(t.dataset.pick);
        else mv.sel.delete(t.dataset.pick);
        renderModelsView();
      }
    });
    // Connector changes (added/removed models) should show up here right away.
    $('conn-dlg').addEventListener('close', () => { if (view === 'models') loadModelsView(); });
  }

  // ---------- projects, memory and continuity ----------
  // Everything here lives in this browser. A project's memory and chat summaries are only
  // ever added to chats inside that project; chats outside projects are unaffected.
  let projects = load(KEYS.projects, []);
  let draftProject = null; // project for the next new chat
  const pv = { sel: null };
  const MAX_MEMORIES = 60;
  const MEMORY_CHARS = 4000;
  const RECENT_SUMMARIES = 5;

  function persistProjects() { save(KEYS.projects, projects); }
  const getProject = (id) => projects.find((p) => p.id === id) || null;
  const chatProject = (chat) => (chat && chat.projectId ? getProject(chat.projectId) : null);
  const projectChats = (pid) => chats.filter((c) => c.projectId === pid).sort((a, b) => b.updated - a.updated);

  function newProject() {
    const p = { id: uid(), name: 'Untitled project', instructions: '', memory: [], continuity: true, autoMemory: true, created: Date.now(), updated: Date.now() };
    projects.push(p);
    persistProjects();
    return p;
  }

  function addMemory(p, text, source, chatId) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) return false;
    if (p.memory.some((m) => m.text.toLowerCase() === text.toLowerCase())) return false;
    p.memory.push({ id: uid(), text, source: source || 'manual', chatId: chatId || null, at: Date.now() });
    if (p.memory.length > MAX_MEMORIES) p.memory.splice(0, p.memory.length - MAX_MEMORIES);
    p.updated = Date.now();
    persistProjects();
    return true;
  }

  // System prompt = base prompt + "about you" + (for project chats) instructions, memory, recent chats.
  function buildSystemPrompt(chat) {
    const parts = [];
    if (settings.system) parts.push(settings.system);
    if (settings.about && settings.about.trim()) parts.push('About the user (remember this in every chat):\n' + settings.about.trim());
    const p = chatProject(chat);
    if (p) {
      let block = `You are working inside the project "${p.name}". Stay consistent with its instructions, memory and earlier work.`;
      if (p.instructions.trim()) block += '\n\nProject instructions:\n' + p.instructions.trim();
      if (p.memory.length) {
        let mem = '';
        for (const m of [...p.memory].reverse()) {
          const line = `- ${m.text}\n`;
          if (mem.length + line.length > MEMORY_CHARS) break;
          mem = line + mem;
        }
        block += '\n\nProject memory (facts and decisions to keep using):\n' + mem.trimEnd();
      }
      if (p.continuity) {
        const recent = projectChats(p.id).filter((c) => c.id !== chat.id && c.summary).slice(0, RECENT_SUMMARIES);
        if (recent.length) block += '\n\nRecent chats in this project (for continuity):\n' + recent.map((c) => `- "${c.title}": ${c.summary}`).join('\n');
      }
      parts.push(block);
    }
    return parts.join('\n\n');
  }

  // ---- background summaries + auto memory (one small request per finished reply) ----
  const summaryQueue = new Set();
  let summaryBusy = false;

  function scheduleContinuity(chat) {
    const p = chatProject(chat);
    if (!p || !(p.continuity || p.autoMemory)) return;
    if (!chat.messages.some((m) => m.role === 'assistant' && m.content && !m.error)) return;
    summaryQueue.add(chat.id);
    setTimeout(drainSummaries, 2500);
  }

  async function drainSummaries() {
    if (summaryBusy || streaming) { if (summaryQueue.size) setTimeout(drainSummaries, 4000); return; }
    const id = summaryQueue.values().next().value;
    if (!id) return;
    summaryQueue.delete(id);
    const chat = getChat(id);
    const p = chatProject(chat);
    if (chat && p && (chat.summaryAt || 0) < chat.updated) {
      summaryBusy = true;
      try { await summarizeChat(chat, p); } catch { /* best effort; retried after the next reply */ }
      summaryBusy = false;
    }
    if (summaryQueue.size) setTimeout(drainSummaries, 1000);
  }

  function extractJson(text) {
    const s = String(text || '').replace(/```(?:json)?/gi, '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  }

  async function summarizeChat(chat, p) {
    let transcript = '';
    for (const m of chat.messages.filter((x) => x.content && !x.error).slice(-12)) {
      transcript += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}\n\n`;
    }
    transcript = transcript.slice(-7000);
    const known = p.memory.map((m) => '- ' + m.text).join('\n') || '(none)';
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'auto',
        stream: false,
        messages: [
          { role: 'system', content: 'You maintain memory for a coding project. Reply with ONLY a JSON object, no prose: {"summary": "1-2 sentences: what this chat worked on and what was decided", "facts": ["durable facts worth remembering in future chats of this project: tech stack, conventions, names, decisions, user preferences. Max 4. Skip anything already in known memory, one-off details, and code. Empty list if none."]}' },
          { role: 'user', content: `Project: ${p.name}\n\nKnown memory:\n${known}\n\nChat transcript:\n${transcript}` }
        ]
      })
    });
    if (!res.ok) return;
    const j = await res.json();
    const out = extractJson(j?.choices?.[0]?.message?.content);
    if (!out) return;
    if (typeof out.summary === 'string' && out.summary.trim()) chat.summary = out.summary.trim().slice(0, 400);
    chat.summaryAt = Date.now();
    persistChats();
    let added = 0;
    if (p.autoMemory && Array.isArray(out.facts)) {
      for (const f of out.facts.slice(0, 4)) if (typeof f === 'string' && addMemory(p, f, 'auto', chat.id)) added++;
    }
    if (added && currentId === chat.id) toast(`Remembered ${added} new fact${added === 1 ? '' : 's'} for ${p.name}`);
    if (view === 'projects') renderProjects();
    updateProjectUi();
  }

  // ---- chat-level UI: project picker in the top bar, footer context line ----
  function updateProjectUi() {
    const chat = current();
    const pid = chat ? chat.projectId || '' : draftProject || '';
    const sel = $('chat-project');
    sel.innerHTML = '<option value="">No project</option>' +
      [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('') +
      '<option value="__new">+ New project…</option>';
    sel.classList.toggle('in-project', !!pid);
    $('nav-projects-count').textContent = String(projects.length);
    const p = getProject(pid);
    const ctx = $('project-context');
    if (p) {
      const recent = p.continuity ? projectChats(p.id).filter((c) => c.summary && (!chat || c.id !== chat.id)).length : 0;
      ctx.innerHTML = `<b>${esc(p.name)}</b> · ${p.memory.length} memor${p.memory.length === 1 ? 'y' : 'ies'}${p.continuity ? ` · ${Math.min(recent, RECENT_SUMMARIES)} earlier chat${recent === 1 ? '' : 's'} in context` : ''}`;
      ctx.classList.remove('hidden');
    } else if (settings.about && settings.about.trim()) {
      ctx.innerHTML = 'Using your <b>About you</b> memory';
      ctx.classList.remove('hidden');
    } else {
      ctx.classList.add('hidden');
    }
  }

  function setChatProject(pid) {
    if (pid === '__new') {
      const p = newProject();
      pid = p.id;
      toast('Project created — rename it on the Projects page');
    }
    const chat = current();
    if (chat) {
      chat.projectId = pid || undefined;
      delete chat.summaryAt;
      persistChats();
      renderChatList();
      if (pid) scheduleContinuity(chat);
    } else {
      draftProject = pid || null;
      updateHash();
    }
    updateProjectUi();
  }

  // "/remember <text>" in the composer saves to the current project, or to About you.
  function handleSlashRemember(text) {
    const m = text.match(/^\/remember\s+([\s\S]+)/i);
    if (!m) return false;
    const chat = current();
    const p = getProject(chat ? chat.projectId : draftProject);
    if (p) {
      toast(addMemory(p, m[1], 'manual', chat && chat.id) ? `Saved to ${p.name} memory` : 'Already remembered');
    } else {
      settings.about = ((settings.about || '').trim() + '\n- ' + m[1].trim()).trim();
      save(KEYS.settings, settings);
      toast('Saved to About you (applies to every chat)');
    }
    input.value = '';
    autoGrow();
    updateProjectUi();
    return true;
  }

  // ---- projects view ----
  function fmtAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return fmtWhen(ts);
  }

  function renderProjects() {
    const root = $('projects');
    const p = getProject(pv.sel);
    if (view === 'projects') setTimeout(updateHash);
    if (!p) {
      pv.sel = null;
      const list = [...projects].sort((a, b) => b.updated - a.updated);
      root.innerHTML = `
        <div class="view-head">
          <div>
            <h2>Projects</h2>
            <p class="muted">Group chats, give them shared instructions and memory. A project's memory is only used inside that project.</p>
          </div>
          <div class="view-actions"><button type="button" class="btn primary sm" data-pact="create">+ New project</button></div>
        </div>
        ${list.length ? `<div class="proj-grid">${list.map((x) => {
          const n = projectChats(x.id).length;
          return `<button class="proj-card" data-open-project="${esc(x.id)}">
            <span class="proj-ico">${esc(x.name.charAt(0).toUpperCase() || 'P')}</span>
            <b>${esc(x.name)}</b>
            <span class="proj-desc">${esc(x.instructions.trim().slice(0, 140) || 'No instructions yet')}</span>
            <span class="proj-meta">${n} chat${n === 1 ? '' : 's'} · ${x.memory.length} memor${x.memory.length === 1 ? 'y' : 'ies'} · ${esc(fmtAgo(x.updated))}</span>
          </button>`;
        }).join('')}</div>`
        : `<div class="empty-state"><b>No projects yet.</b><br>Create one to keep related chats together with shared memory.</div>`}`;
      return;
    }
    const pchats = projectChats(p.id);
    root.innerHTML = `
      <button type="button" class="back-link" data-pact="back">← All projects</button>
      <div class="proj-head">
        <input class="proj-name" id="proj-name" value="${esc(p.name)}" maxlength="60" aria-label="Project name">
        <div class="view-actions">
          <button type="button" class="btn primary sm" data-pact="chat">+ New chat in project</button>
          <button type="button" class="btn ghost sm danger" data-pact="delete">Delete</button>
        </div>
      </div>

      <div class="proj-cols">
        <section class="proj-panel">
          <h3>Instructions</h3>
          <p class="muted">Sent with every chat in this project: goals, stack, style rules.</p>
          <textarea id="proj-instructions" rows="6" placeholder="e.g. Python 3.12 + FastAPI backend, React frontend. Use type hints. Keep answers short.">${esc(p.instructions)}</textarea>
          <div class="proj-toggles">
            <label class="proj-toggle"><span><b>Continuity</b><small>New chats see short summaries of recent chats here</small></span>
              <span class="switch"><input type="checkbox" id="proj-continuity" ${p.continuity ? 'checked' : ''}><span></span></span></label>
            <label class="proj-toggle"><span><b>Auto-remember</b><small>Save durable facts from chats into memory</small></span>
              <span class="switch"><input type="checkbox" id="proj-auto" ${p.autoMemory ? 'checked' : ''}><span></span></span></label>
          </div>
        </section>

        <section class="proj-panel">
          <h3>Memory <span class="muted">(${p.memory.length})</span></h3>
          <p class="muted">Facts the model keeps using in this project. Tip: type <code>/remember …</code> in a chat.</p>
          <form class="mem-add" id="mem-add"><input name="text" placeholder="Add something to remember" maxlength="400" autocomplete="off"><button class="btn ghost sm">Add</button></form>
          <div class="mem-list">
            ${p.memory.length ? [...p.memory].reverse().map((m) => `<div class="mem-item">
              <span class="mem-src ${m.source === 'auto' ? 'auto' : ''}" title="${m.source === 'auto' ? 'Learned from a chat' : 'Added by you'}">${m.source === 'auto' ? 'auto' : 'you'}</span>
              <span class="mem-text" contenteditable="true" spellcheck="false" data-mem="${esc(m.id)}">${esc(m.text)}</span>
              <button type="button" class="c-del" data-mem-del="${esc(m.id)}" aria-label="Forget">${ICON.trash}</button>
            </div>`).join('') : '<div class="cx-note">Nothing remembered yet.</div>'}
          </div>
        </section>
      </div>

      <section class="proj-panel">
        <h3>Chats <span class="muted">(${pchats.length})</span></h3>
        ${pchats.length ? `<div class="h-rows">${pchats.map((c) => `<div class="h-row" data-id="${c.id}" role="button" tabindex="0">
            <div style="min-width:0"><div class="h-title">${esc(c.title)}</div><div class="h-prev">${esc(c.summary || previewOf(c))}</div></div>
            <div class="h-meta">${c.messages.length} msgs<br>${esc(fmtWhen(c.updated))}</div>
            <button class="c-del" data-del="${c.id}" title="Delete chat" aria-label="Delete chat">${ICON.trash}</button>
          </div>`).join('')}</div>`
        : '<div class="cx-note">No chats yet. Start one with “New chat in project”.</div>'}
      </section>`;
  }

  function startChatInProject(pid) {
    newChat();
    draftProject = pid;
    updateProjectUi();
    updateHash();
  }

  let projSaveTimer = 0;
  function bindProjects() {
    $('chat-project').addEventListener('change', (e) => setChatProject(e.target.value));
    const root = $('projects');
    root.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open-project]');
      if (open) { pv.sel = open.dataset.openProject; renderProjects(); scroll.scrollTop = 0; return; }
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteChat(del.dataset.del); renderProjects(); return; }
      const row = e.target.closest('.h-row');
      if (row) { openChat(row.dataset.id); return; }
      const memDel = e.target.closest('[data-mem-del]');
      if (memDel) {
        const p = getProject(pv.sel);
        p.memory = p.memory.filter((m) => m.id !== memDel.dataset.memDel);
        p.updated = Date.now();
        persistProjects();
        renderProjects();
        return;
      }
      const act = e.target.closest('[data-pact]');
      if (!act) return;
      const a = act.dataset.pact;
      if (a === 'create') { const p = newProject(); pv.sel = p.id; renderProjects(); const n = $('proj-name'); n.focus(); n.select(); }
      else if (a === 'back') { pv.sel = null; renderProjects(); }
      else if (a === 'chat') startChatInProject(pv.sel);
      else if (a === 'delete') {
        const p = getProject(pv.sel);
        const n = projectChats(p.id).length;
        if (!confirm(`Delete project "${p.name}" and its memory?${n ? ` Its ${n} chat${n === 1 ? '' : 's'} will be kept, without a project.` : ''}`)) return;
        for (const c of chats) if (c.projectId === p.id) { delete c.projectId; delete c.summary; delete c.summaryAt; }
        projects = projects.filter((x) => x.id !== p.id);
        if (draftProject === p.id) draftProject = null;
        persistProjects();
        persistChats();
        pv.sel = null;
        renderProjects();
        renderChatList();
        updateProjectUi();
      }
    });
    root.addEventListener('input', (e) => {
      const p = getProject(pv.sel);
      if (!p) return;
      if (e.target.id === 'proj-name') p.name = e.target.value.trim() || 'Untitled project';
      else if (e.target.id === 'proj-instructions') p.instructions = e.target.value;
      else return;
      p.updated = Date.now();
      clearTimeout(projSaveTimer);
      projSaveTimer = setTimeout(() => { persistProjects(); updateProjectUi(); renderChatList(); }, 400);
    });
    root.addEventListener('change', (e) => {
      const p = getProject(pv.sel);
      if (!p) return;
      if (e.target.id === 'proj-continuity') p.continuity = e.target.checked;
      else if (e.target.id === 'proj-auto') p.autoMemory = e.target.checked;
      else return;
      persistProjects();
      updateProjectUi();
    });
    // Inline edit of a memory item; saved when focus leaves it.
    root.addEventListener('focusout', (e) => {
      const el = e.target.closest('[data-mem]');
      const p = getProject(pv.sel);
      if (!el || !p) return;
      const m = p.memory.find((x) => x.id === el.dataset.mem);
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!m) return;
      if (!text) p.memory = p.memory.filter((x) => x !== m);
      else { m.text = text.slice(0, 400); m.source = 'manual'; }
      persistProjects();
      renderProjects();
    });
    root.addEventListener('keydown', (e) => {
      if (e.target.closest('[data-mem]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    root.addEventListener('submit', (e) => {
      if (e.target.id !== 'mem-add') return;
      e.preventDefault();
      const p = getProject(pv.sel);
      const text = e.target.text.value;
      if (p && addMemory(p, text, 'manual')) { renderProjects(); $('mem-add').text.focus(); }
    });
    window.addEventListener('storage', (e) => {
      if (e.key !== KEYS.projects) return;
      projects = load(KEYS.projects, []);
      if (view === 'projects') renderProjects();
      updateProjectUi();
    });
  }

  // ---------- events ----------
  function bind() {
    composer.addEventListener('submit', (e) => {
      e.preventDefault();
      if (streaming) stopStreaming();
      else send(input.value);
    });
    input.addEventListener('input', autoGrow);
    input.addEventListener('input', () => { try { sessionStorage.setItem('zc.draft', input.value); } catch { } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!streaming) send(input.value);
      }
    });
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    composer.addEventListener('dragover', (e) => e.preventDefault());
    composer.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
    $('file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
    $('attachments').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unattach]');
      if (b) { pendingFiles.splice(+b.dataset.unattach, 1); renderAttachments(); }
    });

    $('starters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-starter]');
      if (b) usePrompt(STARTERS[+b.dataset.starter].prompt);
    });
    $('tpl-grid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tpl]');
      if (b) { if (current()?.messages.length) currentId = null; usePrompt(TEMPLATES[+b.dataset.tpl].prompt); renderChatList(); }
    });
    $('browse-prompts').addEventListener('click', () => showView('templates'));

    thread.addEventListener('click', (e) => {
      const saveBtn = e.target.closest('[data-save-code]');
      if (saveBtn) { saveCodeFile(saveBtn.dataset.saveCode, saveBtn.closest('pre').querySelector('code').textContent); return; }
      const codeBtn = e.target.closest('[data-copy-code]');
      if (codeBtn) { copyText(codeBtn.closest('pre').querySelector('code').textContent, 'Code copied'); return; }
      const msgBtn = e.target.closest('[data-copy-msg]');
      if (msgBtn) { copyText(current().messages[+msgBtn.dataset.copyMsg].content); return; }
      if (e.target.closest('[data-retry]')) { retryLast(); return; }
      const zoom = e.target.closest('[data-zoom]');
      if (zoom) { $('img-view-img').src = zoom.src; $('img-view').showModal(); return; }
      const sum = e.target.closest('.think > summary');
      if (sum) {
        const m = current()?.messages[+sum.closest('.msg').dataset.i];
        if (m) m.thinkOpen = !sum.parentElement.open;
      }
    });

    chatList.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteChat(del.dataset.del); return; }
      const card = e.target.closest('.chat-card');
      if (card) openChat(card.dataset.id);
    });
    chatList.addEventListener('keydown', (e) => {
      const card = e.target.closest('.chat-card');
      if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChat(card.dataset.id); }
    });
    searchInput.addEventListener('input', () => {
      renderChatList();
      if (narrowPanel.matches && searchInput.value) shell.classList.add('panel-open');
    });

    $('nav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b) return;
      if (b.dataset.view === 'chat') newChat();
      else { showView(b.dataset.view); closeOverlays(); }
    });
    bindConnectors();
    bindModelsView();
    bindProjects();

    // profile menu (top right)
    const pmenu2 = $('profile-menu');
    const pbtn = $('profile-btn');
    const closeProfile = () => { pmenu2.classList.add('hidden'); pbtn.setAttribute('aria-expanded', 'false'); };
    pbtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = pmenu2.classList.toggle('hidden') === false;
      pbtn.setAttribute('aria-expanded', String(open));
    });
    pmenu2.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pm]');
      if (!b) return;
      closeProfile();
      const a = b.dataset.pm;
      if (a === 'settings') $('open-settings').click();
      else if (a === 'connectors') openConnectors();
      else if (a === 'gateway') showView('gateway');
      else if (a === 'help') $('help-dlg').showModal();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.profile')) closeProfile(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfile(); });

    $('history-search').addEventListener('input', renderHistory);
    $('history-list').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteChat(del.dataset.del); return; }
      const row = e.target.closest('.h-row');
      if (row) openChat(row.dataset.id);
    });
    $('history-list').addEventListener('keydown', (e) => {
      const row = e.target.closest('.h-row');
      if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChat(row.dataset.id); }
    });
    $('gw-refresh').addEventListener('click', loadGateway);
    $('gw-errors-only').addEventListener('change', loadGateway);

    // model pickers (top bar + composer)
    const closePickers = (except) => {
      for (const [btnId, menuId] of MODEL_PICKERS) {
        if (menuId === except) continue;
        $(menuId).classList.add('hidden');
        $(btnId).setAttribute('aria-expanded', 'false');
      }
    };
    for (const [btnId, menuId] of MODEL_PICKERS) {
      $(btnId).addEventListener('click', (e) => {
        e.stopPropagation();
        closePickers(menuId);
        const open = $(menuId).classList.toggle('hidden') === false;
        $(btnId).setAttribute('aria-expanded', String(open));
        if (open) loadModels();
      });
      $(menuId).addEventListener('click', (e) => {
        const b = e.target.closest('[data-model]');
        if (!b) return;
        setModel(b.dataset.model);
        closePickers();
      });
    }

    // panel menu
    const pmenu = $('panel-menu');
    $('panel-more').addEventListener('click', (e) => { e.stopPropagation(); pmenu.classList.toggle('hidden'); });
    $('export-chats').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(chats, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `zerocode-chats-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('clear-chats').addEventListener('click', () => {
      if (!chats.length) return;
      if (!confirm(`Delete all ${chats.length} chats? This cannot be undone.`)) return;
      stopStreaming();
      chats = [];
      currentId = null;
      persistChats();
      renderThread();
      renderChatList();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.model-picker')) closePickers();
      if (!e.target.closest('.panel-menu')) pmenu.classList.add('hidden');
    });

    // theme
    document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));

    // layout toggles
    $('collapse-side').addEventListener('click', () => { ui.sideClosed = true; save(KEYS.ui, ui); applyLayout(); });
    $('open-side').addEventListener('click', () => {
      if (narrowSide.matches) shell.classList.add('side-open');
      else { ui.sideClosed = false; save(KEYS.ui, ui); applyLayout(); }
    });
    $('toggle-panel').addEventListener('click', () => {
      if (narrowPanel.matches) shell.classList.toggle('panel-open');
      else { ui.panelClosed = !ui.panelClosed; save(KEYS.ui, ui); applyLayout(); }
    });
    $('scrim').addEventListener('click', closeOverlays);
    narrowSide.addEventListener('change', () => { closeOverlays(); applyLayout(); });
    narrowPanel.addEventListener('change', () => { closeOverlays(); applyLayout(); });

    // settings
    const dlg = $('settings-dlg');
    const form = $('settings-form');
    $('open-settings').addEventListener('click', () => {
      form.name.value = settings.name;
      form.apiKey.value = settings.apiKey;
      form.maxTokens.value = Number(settings.maxTokens) > 0 ? settings.maxTokens : '';
      form.system.value = settings.system;
      form.about.value = settings.about || '';
      closeOverlays();
      dlg.showModal();
    });
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'save') return;
      settings.name = form.name.value.trim();
      settings.apiKey = form.apiKey.value.trim();
      const mt = parseInt(form.maxTokens.value, 10);
      settings.maxTokens = mt > 0 ? Math.max(64, Math.min(200000, mt)) : '';
      settings.system = form.system.value;
      settings.about = form.about.value.trim();
      updateProjectUi();
      save(KEYS.settings, settings);
      applyUser();
      loadModels();
      toast('Settings saved');
    });

    const help = () => { closeOverlays(); $('help-dlg').showModal(); };
    $('open-help').addEventListener('click', help);
    $('help-top').addEventListener('click', help);

    // keyboard
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (narrowSide.matches) shell.classList.add('side-open');
        searchInput.focus();
        searchInput.select();
      } else if (e.key === 'Escape') {
        if (streaming) stopStreaming();
        closeOverlays();
      }
    });

    // Another tab changed the chats.
    window.addEventListener('storage', (e) => {
      if (e.key !== KEYS.chats || streaming) return;
      chats = load(KEYS.chats, []);
      if (currentId && !getChat(currentId)) currentId = null;
      renderThread();
      renderChatList();
    });
  }

  // ---------- init ----------
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  applyLayout();
  applyUser();
  renderStarters();
  setModel(settings.model || 'auto');
  // Replies cut off by a reload mid-stream: keep what arrived and offer Retry.
  chats.forEach((c) => c.messages.forEach((m) => {
    if (m.role === 'assistant' && !m.done) { m.done = true; m.error = m.content ? 'Interrupted by a page reload — the reply above is incomplete.' : 'Interrupted by a page reload.'; }
  }));
  if (!applyRoute()) renderThread();
  renderChatList();
  try { const d = sessionStorage.getItem('zc.draft'); if (d && !input.value) input.value = d; } catch { }
  window.addEventListener('hashchange', () => { if (location.hash !== routeHash()) { applyRoute(); renderChatList(); } });
  window.addEventListener('popstate', () => { if (location.hash !== routeHash()) { applyRoute(); renderChatList(); } });
  // A refresh while a reply is streaming would cut it off, so ask first.
  window.addEventListener('beforeunload', (e) => { if (streaming) { e.preventDefault(); e.returnValue = ''; } });
  setupVoice();
  bind();
  autoGrow();
  loadModels();
  api('/config').then((c) => { conn.cfg = c; updateConnCount(); }).catch(() => { });
  updateProjectUi();
  input.focus();
})();
