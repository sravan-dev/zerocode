// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const els = {
    model: /** @type {HTMLSelectElement} */ ($('model')),
    refresh: $('refresh'),
    vision: $('vision'),
    notice: $('notice'),
    messages: $('messages'),
    attachments: $('attachments'),
    warn: $('warn'),
    mention: $('mention'),
    input: /** @type {HTMLTextAreaElement} */ ($('input')),
    send: /** @type {HTMLButtonElement} */ ($('send')),
    attachFile: $('attachFile'),
    attachImage: $('attachImage'),
    attachSel: $('attachSel')
  };

  const state = {
    model: 'auto',
    models: /** @type {string[]} */ ([]),
    history: /** @type {any[]} */ ([]),
    attachments: /** @type {any[]} */ ([]),
    busy: false,
    live: /** @type {any} */ (null),
    liveEl: /** @type {HTMLElement|null} */ (null),
    renderQueued: false,
    mention: { open: false, start: 0, query: '', items: /** @type {any[]} */ ([]), index: 0 }
  };

  // ---------- helpers ----------

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function looksVision(model) {
    const m = String(model || '').toLowerCase();
    if (!m || m === 'auto') return null;
    return /vision|[-/]vl\b|-vl-|4o|gpt-4\.1|gpt-5|gpt-6|claude|gemini|llama-4|pixtral|qwen[\d.]*-?vl|kimi-k2\.[5-9]|kimi-k3|glm-[\d.]+v|grok-4|mimo|omni|multimodal|nemotron.*vl|mistral-(medium|small)-3/.test(m);
  }

  // ---------- markdown ----------

  function inline(text) {
    const codes = [];
    let s = esc(text).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code class="ic">' + codes[Number(i)] + '</code>');
  }

  function prose(src) {
    const lines = src.split('\n');
    let html = '';
    let para = [];
    let list = null; // 'ul' | 'ol'
    const flushPara = () => {
      if (para.length) html += '<p>' + para.map(inline).join('<br>') + '</p>';
      para = [];
    };
    const closeList = () => {
      if (list) html += '</' + list + '>';
      list = null;
    };
    for (const line of lines) {
      let m;
      if (!line.trim()) {
        flushPara();
        closeList();
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara();
        closeList();
        const level = Math.min(6, m[1].length + 2);
        html += '<h' + level + '>' + inline(m[2]) + '</h' + level + '>';
      } else if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
        flushPara();
        closeList();
        html += '<hr>';
      } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += '<li>' + inline(m[1]) + '</li>';
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += '<li>' + inline(m[1]) + '</li>';
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        flushPara();
        closeList();
        html += '<blockquote>' + inline(m[1]) + '</blockquote>';
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
    return html;
  }

  function markdown(src) {
    const parts = String(src || '').split('```');
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        html += prose(part);
        return;
      }
      const nl = part.indexOf('\n');
      let lang = '';
      let code = part;
      if (nl > -1 && /^[\w+#.-]{0,30}$/.test(part.slice(0, nl).trim())) {
        lang = part.slice(0, nl).trim();
        code = part.slice(nl + 1);
      }
      code = code.replace(/\n$/, '');
      const open = i === parts.length - 1 && parts.length % 2 === 0; // unclosed fence while streaming
      html +=
        '<div class="code' + (open ? ' open' : '') + '">' +
        '<div class="code-head"><span class="lang">' + esc(lang || 'code') + '</span>' +
        '<span class="grow"></span>' +
        '<button class="code-btn" data-act="copy">Copy</button>' +
        '<button class="code-btn" data-act="insert" title="Insert at cursor / replace selection">Insert</button>' +
        '</div><pre><code>' + esc(code) + '</code></pre></div>';
    });
    return html;
  }

  // ---------- rendering ----------

  function attachmentChips(atts, removable) {
    return (atts || [])
      .map((a, i) => {
        const icon = a.kind === 'image' ? '' : a.kind === 'selection' ? '&#10697;' : '&#128196;';
        const label = a.label || a.name || a.path || 'attachment';
        const thumb = a.kind === 'image' && (a.thumb || a.dataUrl) ? '<img src="' + esc(a.thumb || a.dataUrl) + '" alt="">' : '';
        const openable = a.kind === 'file' || a.kind === 'selection';
        return (
          '<span class="chip ' + a.kind + (openable ? ' openable' : '') + '" data-i="' + i + '" title="' + esc(label) + '">' +
          thumb + (icon ? '<span class="ci">' + icon + '</span>' : '') +
          '<span class="cl">' + esc(shortLabel(label)) + '</span>' +
          (removable ? '<button class="x" data-remove="' + i + '" title="Remove">&times;</button>' : '') +
          '</span>'
        );
      })
      .join('');
  }

  function shortLabel(label) {
    const s = String(label);
    const slash = s.lastIndexOf('/');
    return slash > -1 && s.length > 28 ? '…' + s.slice(slash) : s;
  }

  function messageHtml(m) {
    if (m.role === 'user') {
      const text = esc(m.text).replace(/(^|\s)(@[\w./\\-]+)/g, '$1<span class="at">$2</span>');
      return (
        '<div class="msg user">' +
        (m.attachments && m.attachments.length ? '<div class="chips">' + attachmentChips(m.attachments, false) + '</div>' : '') +
        (m.text ? '<div class="body">' + text + '</div>' : '') +
        '</div>'
      );
    }
    const thinking = m.reasoning
      ? '<details class="think"' + (m.streaming && !m.text ? ' open' : '') + '><summary>' + (m.streaming && !m.text ? 'Thinking…' : 'Thought process') + '</summary><div class="think-body">' + esc(m.reasoning) + '</div></details>'
      : '';
    const pending = m.streaming && !m.text && !m.reasoning ? '<div class="typing"><span></span><span></span><span></span></div>' : '';
    const meta = [];
    if (m.via) meta.push('via ' + esc(m.via));
    if (m.usage && (m.usage.prompt_tokens || m.usage.completion_tokens)) {
      meta.push((m.usage.prompt_tokens || 0) + ' in / ' + (m.usage.completion_tokens || 0) + ' out');
    }
    return (
      '<div class="msg assistant' + (m.streaming ? ' streaming' : '') + '">' +
      thinking + pending +
      (m.text ? '<div class="md">' + markdown(m.text) + '</div>' : '') +
      (m.error ? '<div class="err">' + esc(m.error) + '</div>' : '') +
      (meta.length ? '<div class="meta">' + meta.join(' · ') + '</div>' : '') +
      '</div>'
    );
  }

  function renderAll() {
    if (!state.history.length) {
      els.messages.innerHTML =
        '<div class="empty"><div class="logo">tkroll</div>' +
        '<p>Chat through your ZeroCode gateway.</p>' +
        '<ul>' +
        '<li>Type <b>@</b> to mention a file, current file or selection</li>' +
        '<li>Paste or attach images for vision models</li>' +
        '<li>Switch model at the top; <b>auto</b> walks the route chain</li>' +
        '<li>Select code and press <b>Ctrl+Shift+L</b> to add it here</li>' +
        '</ul></div>';
      state.liveEl = null;
      return;
    }
    els.messages.innerHTML = state.history.map(messageHtml).join('');
    state.liveEl = state.live ? /** @type {HTMLElement} */ (els.messages.lastElementChild) : null;
    scrollBottom(true);
  }

  function renderLive() {
    state.renderQueued = false;
    if (!state.live || !state.liveEl) return;
    const stick = nearBottom();
    const tmp = document.createElement('div');
    tmp.innerHTML = messageHtml(state.live);
    const next = /** @type {HTMLElement} */ (tmp.firstElementChild);
    const openDetails = state.liveEl.querySelector('details.think');
    if (openDetails && next.querySelector('details.think')) {
      /** @type {HTMLDetailsElement} */ (next.querySelector('details.think')).open = /** @type {HTMLDetailsElement} */ (openDetails).open;
    }
    state.liveEl.replaceWith(next);
    state.liveEl = next;
    if (stick) scrollBottom(true);
  }

  function queueLive() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(renderLive);
  }

  function nearBottom() {
    const m = els.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  function scrollBottom(force) {
    if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function renderAttachments() {
    els.attachments.innerHTML = attachmentChips(state.attachments, true);
    els.attachments.hidden = !state.attachments.length;
    updateWarn();
  }

  function renderModels(error) {
    const list = state.models.slice();
    if (!list.includes(state.model)) list.unshift(state.model);
    els.model.innerHTML = list.map((id) => '<option value="' + esc(id) + '"' + (id === state.model ? ' selected' : '') + '>' + esc(id) + '</option>').join('');
    if (error) {
      els.notice.innerHTML =
        esc(error) +
        ' <span class="links"><a href="#" data-cmd="setApiKey">Set API key</a> · <a href="#" data-cmd="openSettings">Settings</a> · <a href="#" data-cmd="refreshModels">Retry</a></span>';
      els.notice.hidden = false;
    } else {
      els.notice.hidden = true;
    }
    updateVision();
  }

  function updateVision() {
    els.vision.hidden = looksVision(state.model) !== true;
    updateWarn();
  }

  function updateWarn() {
    const hasImage = state.attachments.some((a) => a.kind === 'image');
    const v = looksVision(state.model);
    if (hasImage && v === false) {
      els.warn.textContent = '⚠ ' + state.model + ' may not accept images. Pick a vision model (e.g. gemini, gpt-4o/5, claude, llama-4, qwen-vl) or the request may fail.';
      els.warn.hidden = false;
    } else if (hasImage && v === null) {
      els.warn.textContent = 'Images go to whichever model "auto" picks. Pin a vision model to be sure.';
      els.warn.hidden = false;
    } else {
      els.warn.hidden = true;
    }
  }

  function setBusy(b) {
    state.busy = b;
    els.send.textContent = b ? 'Stop' : 'Send';
    els.send.classList.toggle('stop', b);
    els.model.disabled = b;
  }

  // ---------- attachments ----------

  function addAttachment(a) {
    if (!a || !a.kind) return;
    const key = (x) => (x.kind === 'image' ? 'img:' + x.dataUrl.length + ':' + x.dataUrl.slice(-64) : x.kind + ':' + x.path + ':' + (x.startLine || '') + '-' + (x.endLine || ''));
    if (state.attachments.some((x) => key(x) === key(a))) return;
    if (a.kind === 'file') a.label = a.path;
    if (a.kind === 'selection') a.label = a.path + ':' + a.startLine + '-' + a.endLine;
    if (a.kind === 'image') a.label = a.name || 'image';
    state.attachments.push(a);
    renderAttachments();
  }

  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    if (file.size > 8 * 1024 * 1024) {
      flashWarn('Image larger than 8 MB skipped.');
      return;
    }
    const r = new FileReader();
    r.onload = () => addAttachment({ kind: 'image', name: file.name || 'pasted-image.png', dataUrl: String(r.result) });
    r.readAsDataURL(file);
  }

  function flashWarn(text) {
    els.warn.textContent = text;
    els.warn.hidden = false;
    setTimeout(updateWarn, 3000);
  }

  // ---------- mentions ----------

  const SPECIALS = [
    { special: 'addActiveFile', name: 'Current file', dir: 'the file open in the editor', match: 'current file' },
    { special: 'addSelection', name: 'Selection', dir: 'the selected code in the editor', match: 'selection' }
  ];

  function mentionContext() {
    const pos = els.input.selectionStart;
    const before = els.input.value.slice(0, pos);
    const m = /(^|\s)@([\w./\\-]*)$/.exec(before);
    if (!m) return null;
    return { start: pos - m[2].length - 1, query: m[2] };
  }

  let mentionTimer = 0;
  function updateMention() {
    const ctx = mentionContext();
    if (!ctx) return closeMention();
    state.mention.open = true;
    state.mention.start = ctx.start;
    state.mention.query = ctx.query;
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => vscode.postMessage({ type: 'searchFiles', query: ctx.query }), 90);
    renderMention(state.mention.items);
  }

  function renderMention(files) {
    const q = state.mention.query.toLowerCase();
    const specials = SPECIALS.filter((s) => !q || s.match.includes(q));
    state.mention.items = specials.concat(files || []);
    if (state.mention.index >= state.mention.items.length) state.mention.index = 0;
    if (!state.mention.items.length) {
      els.mention.innerHTML = '<div class="m-empty">No matching files</div>';
    } else {
      els.mention.innerHTML = state.mention.items
        .map((it, i) =>
          '<div class="m-item' + (i === state.mention.index ? ' active' : '') + (it.special ? ' special' : '') + '" data-mi="' + i + '">' +
          '<span class="m-name">' + esc(it.name) + '</span><span class="m-dir">' + esc(it.dir || '') + '</span></div>'
        )
        .join('');
    }
    els.mention.hidden = false;
    const active = els.mention.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function closeMention() {
    state.mention.open = false;
    state.mention.index = 0;
    els.mention.hidden = true;
  }

  function pickMention(i) {
    const it = state.mention.items[i];
    if (!it) return;
    const input = els.input;
    const end = input.selectionStart;
    const insert = it.special ? '' : '@' + it.name + ' ';
    input.value = input.value.slice(0, state.mention.start) + insert + input.value.slice(end);
    const caret = state.mention.start + insert.length;
    input.setSelectionRange(caret, caret);
    if (it.special) vscode.postMessage({ type: it.special });
    else addAttachment({ kind: 'file', path: it.path });
    closeMention();
    autosize();
    input.focus();
  }

  // ---------- send ----------

  function send() {
    if (state.busy) {
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const text = els.input.value.trim();
    if (!text && !state.attachments.length) return;
    const atts = state.attachments.map((a) => Object.assign({}, a));
    state.history.push({ role: 'user', text, attachments: atts.map((a) => ({ kind: a.kind, label: a.label, thumb: a.dataUrl })) });
    state.live = { role: 'assistant', text: '', streaming: true };
    state.history.push(state.live);
    renderAll();
    vscode.postMessage({ type: 'send', text, attachments: atts });
    els.input.value = '';
    state.attachments = [];
    renderAttachments();
    autosize();
    setBusy(true);
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
  }

  // ---------- events ----------

  els.send.addEventListener('click', send);
  els.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
  els.attachFile.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
  els.attachImage.addEventListener('click', () => vscode.postMessage({ type: 'pickImages' }));
  els.attachSel.addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));

  els.model.addEventListener('change', () => {
    state.model = els.model.value;
    vscode.postMessage({ type: 'setModel', model: state.model });
    updateVision();
  });

  els.input.addEventListener('input', () => {
    autosize();
    updateMention();
  });
  els.input.addEventListener('click', updateMention);
  els.input.addEventListener('blur', () => setTimeout(closeMention, 150));

  els.input.addEventListener('keydown', (e) => {
    if (state.mention.open && state.mention.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = state.mention.items.length;
        state.mention.index = (state.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderMention(state.mention.items.filter((x) => !x.special));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(state.mention.index);
        return;
      }
    }
    if (state.mention.open && e.key === 'Escape') {
      e.preventDefault();
      closeMention();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  els.input.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const images = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type));
    if (!images.length) return;
    e.preventDefault();
    images.forEach((it) => addImageFile(it.getAsFile()));
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    files.forEach(addImageFile);
  });

  els.mention.addEventListener('mousedown', (e) => {
    const item = /** @type {HTMLElement} */ (e.target).closest('[data-mi]');
    if (!item) return;
    e.preventDefault();
    pickMention(Number(/** @type {HTMLElement} */ (item).dataset.mi));
  });

  els.attachments.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const rm = t.closest('[data-remove]');
    if (rm) {
      state.attachments.splice(Number(/** @type {HTMLElement} */ (rm).dataset.remove), 1);
      renderAttachments();
      return;
    }
    const chip = /** @type {HTMLElement|null} */ (t.closest('.chip.openable'));
    if (chip) {
      const a = state.attachments[Number(chip.dataset.i)];
      if (a) vscode.postMessage({ type: 'openFile', path: a.path });
    }
  });

  els.messages.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const btn = /** @type {HTMLElement|null} */ (t.closest('.code-btn'));
    if (btn) {
      const code = btn.closest('.code')?.querySelector('pre code')?.textContent || '';
      if (btn.dataset.act === 'copy') {
        vscode.postMessage({ type: 'copy', text: code });
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1400);
      } else {
        vscode.postMessage({ type: 'insertCode', code });
        btn.textContent = 'Inserted';
        setTimeout(() => (btn.textContent = 'Insert'), 1400);
      }
    }
  });

  els.notice.addEventListener('click', (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest('[data-cmd]');
    if (!a) return;
    e.preventDefault();
    vscode.postMessage({ type: /** @type {HTMLElement} */ (a).dataset.cmd });
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m && m.type) {
      case 'init': {
        state.model = m.model || 'auto';
        state.history = Array.isArray(m.history) ? m.history : [];
        state.models = [state.model];
        const last = state.history[state.history.length - 1];
        if (m.busy && last && last.role === 'assistant') {
          last.streaming = true;
          state.live = last;
          setBusy(true);
        }
        renderModels();
        renderAll();
        break;
      }
      case 'start':
        // A turn started from the other chat surface: mirror it here.
        if (!state.live && m.user) {
          state.history.push(m.user);
          state.live = { role: 'assistant', text: '', streaming: true };
          state.history.push(state.live);
          renderAll();
          setBusy(true);
        }
        break;
      case 'modelChanged':
        if (m.model && m.model !== state.model) {
          state.model = m.model;
          if (!Array.from(els.model.options).some((o) => o.value === m.model)) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = m.model;
            els.model.prepend(opt);
          }
          els.model.value = m.model;
          updateVision();
        }
        break;
      case 'models':
        state.models = m.models || [];
        if (m.model) state.model = m.model;
        renderModels(m.error);
        break;
      case 'fileResults':
        if (state.mention.open && m.query === state.mention.query) renderMention(m.items || []);
        break;
      case 'addAttachment':
        addAttachment(m.attachment);
        els.input.focus();
        break;
      case 'via':
        if (state.live) {
          state.live.via = m.via;
          queueLive();
        }
        break;
      case 'delta':
        if (state.live) {
          if (m.content) state.live.text += m.content;
          if (m.reasoning) state.live.reasoning = (state.live.reasoning || '') + m.reasoning;
          queueLive();
        }
        break;
      case 'done':
        if (state.live) {
          Object.assign(state.live, m.message || {}, { streaming: false });
          renderLive();
        }
        state.live = null;
        state.liveEl = null;
        setBusy(false);
        break;
      case 'cleared':
        state.history = [];
        state.live = null;
        setBusy(false);
        renderAll();
        break;
    }
  });

  renderAll();
  autosize();
  vscode.postMessage({ type: 'ready' });
})();
