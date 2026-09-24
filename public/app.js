const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  view: 'overview',
  cfg: null,
  status: null,
  health: [],
  stats: null,
  logs: [],
  drafts: {},
  modal: null,
  chat: { messages: [], model: 'auto', stream: true, busy: false, maxTokens: 800 },
  logsErrorsOnly: false
};

let unlocked = false;

function apiKeyHeader() {
  const k = localStorage.getItem('tr_key');
  return k ? { 'x-api-key': k } : {};
}

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, apiKeyHeader(), opts.headers || {});
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    showUnlock();
    throw new Error('unauthorized');
  }
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error((j && (j.error || (j.error && j.error.message))) || 'HTTP ' + res.status);
  return j;
}

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

function showUnlock() {
  if (unlocked) return;
  unlocked = true;
  const root = $('#unlock-root');
  root.classList.remove('hidden');
  root.innerHTML =
    '<div class="modal" style="width:420px">' +
    '<h2>Dashboard locked</h2>' +
    '<p class="muted" style="margin:0 0 12px">This Token Route instance requires an API key. Enter the proxy key you configured.</p>' +
    '<input class="input" id="unlock-input" type="password" placeholder="proxy key">' +
    '<div class="foot"><button class="btn primary" id="unlock-save">Unlock</button></div>' +
    '</div>';
  $('#unlock-save').onclick = () => {
    const v = $('#unlock-input').value.trim();
    if (!v) return;
    localStorage.setItem('tr_key', v);
    location.reload();
  };
  $('#unlock-input').focus();
}

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function msStr(n) {
  if (n == null) return '-';
  if (n < 1000) return n + 'ms';
  return (n / 1000).toFixed(1) + 's';
}

function healthDotClass(st) {
  if (st === 'healthy') return 'ok';
  if (st === 'cooldown') return 'warn';
  return 'dim';
}

function healthLabel(h) {
  if (h.state === 'healthy') return 'ready';
  if (h.state === 'cooldown') return 'cooling ' + Math.ceil((h.remainingMs || 0) / 1000) + 's';
  return 'needs API key / sign-in';
}

async function loadStatus() { state.status = await api('/api/status'); }
async function loadConfig() { state.cfg = await api('/api/config'); }
async function loadHealth() {
  const j = await api('/api/health');
  state.health = j.candidates || [];
}
async function loadStats() { state.stats = await api('/api/stats'); }
async function loadLogs() {
  const q = state.logsErrorsOnly ? '?errors=1&limit=200' : '?limit=200';
  const j = await api('/api/logs' + q);
  state.logs = j.logs || [];
}

function setView(v) {
  state.view = v;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  const render = {
    overview: renderOverview,
    providers: renderProviders,
    routing: renderRouting,
    logs: renderLogs,
    playground: renderPlayground,
    settings: renderSettings
  }[v];
  if (render) render();
}

function renderOverview() {
  const cfg = state.cfg, st = state.stats;
  const el = $('#view-overview');
  if (!cfg || !st) { el.innerHTML = '<p class="muted">loading...</p>'; return; }
  const anyKey = (cfg.providers || []).some((p) => p.hasKey);
  const base = location.origin + '/v1';
  const t = st.totals;
  const okRate = t.requests ? Math.round((t.ok / t.requests) * 100) : null;
  const chain = (cfg.route || []).map((c, i) => {
    const h = state.health.find((x) => x.provider === c.provider && x.model === c.model);
    const dot = h ? healthDotClass(h.state) : 'dim';
    return '<span class="chip"><span class="dot ' + dot + '"></span><span class="mono">' + esc(c.provider) + '/' + esc(c.model) + '</span></span>';
  }).join('');
  const providersList = (cfg.providers || []).map((p) => {
    const url = keyUrl(p.type);
    const isG = p.type === 'antigravity';
    const status = p.hasKey ? (isG ? 'signed in' : 'key set') : (isG ? 'not signed in' : 'no key');
    const action = p.hasKey
      ? ''
      : isG
        ? '<a href="#" class="btn small" onclick="setView(\'providers\');return false">Sign in</a>'
        : url
          ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" class="btn small">Get key &#8599;</a>'
          : '';
    return (
      '<div class="row" style="padding:6px 0">' +
      '<span class="dot ' + (p.enabled ? (p.hasKey ? 'ok' : 'warn') : 'dim') + '"></span>' +
      '<span>' + esc(p.name) + '</span>' +
      '<span class="grow"></span>' +
      action +
      '<span class="muted" style="font-size:12px;min-width:84px;text-align:right">' + status + '</span>' +
      '</div>'
    );
  }).join('');
  const curl = 'curl ' + base + '/chat/completions \\\n  -H "content-type: application/json" \\\n  -d \'{"model":"auto","messages":[{"role":"user","content":"hello"}]}\'';
  const checklist = !anyKey
    ? '<div class="card"><h2>Getting started</h2>' +
      '<div class="check-item"><span class="n">1</span><span>Add a free API key on the <a href="#" onclick="setView(\'providers\');return false">Providers</a> page (Groq, OpenRouter, Gemini) or sign in with Google on the Antigravity provider</span></div>' +
      '<div class="check-item"><span class="n">2</span><span>Browse models and add your favourites to the route</span></div>' +
      '<div class="check-item"><span class="n">3</span><span>Point any OpenAI-compatible client at the API base below with model <span class="mono">auto</span></span></div>' +
      '</div>'
    : '';
  el.innerHTML =
    '<h1>Overview</h1><p class="subtitle">Gateway status, traffic and the active route chain</p>' +
    '<div class="cards">' +
    '<div class="statcard"><div class="k">Requests</div><div class="v">' + t.requests + '</div></div>' +
    '<div class="statcard"><div class="k">Success rate</div><div class="v">' + (okRate == null ? '-' : okRate + '<small>%</small>') + '</div></div>' +
    '<div class="statcard"><div class="k">Avg latency</div><div class="v">' + msStr(t.avgLatencyMs) + '</div></div>' +
    '<div class="statcard"><div class="k">Tokens routed</div><div class="v">' + ((t.tokensIn + t.tokensOut) || 0) + '</div></div>' +
    '</div>' +
    checklist +
    '<div class="card"><h2>Connect any OpenAI-compatible client <span class="muted">- model "auto" follows the route</span></h2>' +
    '<div class="row wrap"><span class="chip mono">' + esc(base) + '</span>' +
    (cfg.hasProxyKey ? '<span class="badge">protected: clients need your proxy key</span>' : '<span class="badge free">open (local)</span>') +
    '<span class="grow"></span><button class="btn small" id="copy-curl">Copy sample curl</button></div>' +
    '<code class="snippet">' + esc(curl) + '</code>' +
    '</div>' +
    '<div class="card"><h2>Route chain <span class="muted">- strategy: ' + esc(cfg.strategy) + (cfg.strategy === 'failover' ? ', tries in order' : ', rotates across candidates') + '</span></h2>' +
    (chain ? '<div class="row wrap">' + chain + '</div>' : '<p class="muted">No candidates yet. Add models from the Providers page.</p>') +
    '</div>' +
    '<div class="card"><h2>Providers</h2>' + providersList + '</div>';
  const btn = $('#copy-curl');
  if (btn) btn.onclick = () => {
    navigator.clipboard.writeText(curl).then(() => toast('Sample curl copied', 'ok'));
  };
}

function providerDraft(id) {
  if (!state.drafts[id]) state.drafts[id] = {};
  return state.drafts[id];
}

function collectProviders() {
  const list = (state.cfg.providers || []).map((p) => {
    const d = state.drafts[p.id] || {};
    const out = {
      id: p.id,
      name: d.name != null ? d.name : p.name,
      type: p.type,
      baseUrl: d.baseUrl != null ? d.baseUrl : p.baseUrl,
      enabled: d.enabled != null ? d.enabled : p.enabled
    };
    if (d.apiKey != null && d.apiKey !== '') out.apiKey = d.apiKey;
    return out;
  });
  return list;
}

async function saveProviders(providers) {
  const j = await api('/api/config', { method: 'PUT', body: { providers } });
  state.cfg = j;
  state.drafts = {};
  if (j.restartRequired) toast('Saved. Restart Token Route to apply network changes.');
  else toast('Providers saved', 'ok');
}

function renderProviders() {
  const cfg = state.cfg;
  const el = $('#view-providers');
  if (!cfg) { el.innerHTML = '<p class="muted">loading...</p>'; return; }
  const cards = (cfg.providers || []).map((p) => {
    const d = state.drafts[p.id] || {};
    const baseUrl = d.baseUrl != null ? d.baseUrl : p.baseUrl;
    const enabled = d.enabled != null ? d.enabled : p.enabled;
    const fields = p.type === 'antigravity'
      ? '<div class="field"><span>Google account</span>' +
        '<div class="row wrap" style="min-height:34px">' +
        (p.hasKey
          ? '<span class="badge free">signed in</span><span class="mono" style="font-size:12.5px">' + esc(p.keyHint || '') + '</span>' +
            '<span class="grow"></span><button class="btn small" data-act="gsignout">Sign out</button>'
          : '<button class="btn small primary" data-act="gsignin">Sign in with Google</button>' +
            '<span class="muted" style="font-size:12px">opens a Google consent window</span>') +
        '</div>' +
        (!p.hasKey && !isLocalDashboard()
          ? '<p class="muted" style="font-size:11.5px;margin:10px 0 6px">Running on a server: after approving, Google redirects to a <span class="mono">localhost</span> page that won\'t load. Copy that full URL from the address bar and paste it here.</p>' +
            '<div class="row"><input class="input mono grow" data-act="gpaste" placeholder="http://localhost:3777/oauth2callback?state=...&code=..."><button class="btn small" data-act="gpaste-submit">Finish sign-in</button></div>'
          : '') +
        '</div>'
      : '<label class="field"><span>Base URL</span><input class="input mono" data-act="baseUrl" value="' + esc(baseUrl) + '"></label>' +
        '<label class="field"><span>API key</span><input class="input mono" data-act="apiKey" type="password" placeholder="' + (p.hasKey ? esc(p.keyHint) + ' (saved)' : 'paste key...') + '"></label>';
    return (
      '<div class="provider-card" data-pid="' + esc(p.id) + '">' +
      '<div class="head">' +
      '<span class="dot ' + (p.hasKey ? 'ok' : 'dim') + '"></span>' +
      '<span class="name">' + esc(p.name) + '</span>' +
      '<span class="badge type">' + esc(p.type) + '</span>' +
      '<span class="spacer"></span>' +
      '<label class="switch"><input type="checkbox" data-act="enabled"' + (enabled ? ' checked' : '') + '><span class="track"></span></label>' +
      '</div>' +
      '<div class="fields">' + fields + '</div>' +
      '<div class="row wrap" style="margin-top:6px">' +
      (keyUrl(p.type) ? '<a href="' + esc(keyUrl(p.type)) + '" target="_blank" rel="noopener" class="btn small">Get API key &#8599;</a>' : '') +
      '<button class="btn small" data-act="test">Test</button>' +
      '<button class="btn small" data-act="browse">Browse models</button>' +
      '<button class="btn small primary" data-act="save">Save</button>' +
      '<span class="test-result" data-act="result"></span>' +
      '<span class="grow"></span>' +
      (p.type === 'custom' || p.type === 'github' ? '<button class="btn small danger" data-act="delete">Delete</button>' : '') +
      '</div>' +
      '<p class="muted" style="font-size:11.5px;margin:10px 0 0">' + providerHint(p) + '</p>' +
      '</div>'
    );
  }).join('');
  el.innerHTML =
    '<h1>Providers</h1><p class="subtitle">Paste free-tier API keys. Keys are stored locally in data/config.json only.</p>' +
    cards +
    '<div class="card"><h2>Add custom provider <span class="muted">- any OpenAI-compatible endpoint (Ollama, LM Studio, Together, ...)</span></h2>' +
    '<div class="fields" style="display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:12px">' +
    '<label class="field"><span>Name</span><input class="input" id="cp-name" placeholder="My local LLM"></label>' +
    '<label class="field"><span>Base URL</span><input class="input mono" id="cp-url" placeholder="http://localhost:11434/v1"></label>' +
    '<label class="field"><span>API key (optional)</span><input class="input mono" id="cp-key" type="password"></label>' +
    '</div>' +
    '<button class="btn primary" id="cp-add">Add provider</button>' +
    '</div>';
  $$('#view-providers .provider-card').forEach((card) => {
    const pid = card.dataset.pid;
    $$('.input, [data-act]', card).forEach((input) => { });
    $$('[data-act]', card).forEach((node) => {
      const act = node.dataset.act;
      if (act === 'baseUrl' || act === 'apiKey') {
        node.addEventListener('input', () => { providerDraft(pid)[act] = node.value; });
      } else if (act === 'enabled') {
        node.addEventListener('change', () => { providerDraft(pid).enabled = node.checked; });
      } else if (act === 'save') {
        node.addEventListener('click', async () => { await saveProviders(collectProviders()); renderProviders(); });
      } else if (act === 'test') {
        node.addEventListener('click', async () => {
          const res = node.parentElement.querySelector('[data-act=result]');
          res.textContent = 'testing...';
          res.className = 'test-result';
          if (state.drafts[pid] && state.drafts[pid].apiKey) await saveProvidersQuiet(collectProviders());
          const r = await api('/api/providers/test', { method: 'POST', body: { id: pid } });
          if (r.ok) { res.textContent = 'OK - ' + r.ms + 'ms, ' + r.count + ' models'; res.className = 'test-result ok'; }
          else { res.textContent = 'Failed: ' + r.error; res.className = 'test-result err'; }
        });
      } else if (act === 'browse') {
        node.addEventListener('click', async () => {
          if (state.drafts[pid] && state.drafts[pid].apiKey) await saveProvidersQuiet(collectProviders());
          openModelsModal(pid);
        });
      } else if (act === 'gsignin') {
        node.addEventListener('click', async () => {
          node.disabled = true;
          try {
            const j = await api('/api/google/login', { method: 'POST', body: {} });
            window.open(j.url, '_blank', 'width=520,height=680');
            toast('Complete the Google sign-in in the opened window');
            pollGoogleStatus();
          } catch (e) {
            toast('Could not start Google sign-in: ' + e.message, 'err');
            node.disabled = false;
          }
        });
      } else if (act === 'gpaste-submit') {
        node.addEventListener('click', async () => {
          const input = card.querySelector('[data-act=gpaste]');
          const url = input ? input.value.trim() : '';
          if (!url) { toast('Paste the redirected URL first', 'err'); return; }
          node.disabled = true;
          try {
            const r = await api('/api/google/callback', { method: 'POST', body: { url } });
            await loadConfig();
            toast('Google account connected' + (r.email ? ': ' + r.email : ''), 'ok');
            renderProviders();
          } catch (e) {
            toast('Sign-in failed: ' + e.message, 'err');
            node.disabled = false;
          }
        });
      } else if (act === 'gsignout') {
        node.addEventListener('click', async () => {
          await api('/api/google/logout', { method: 'POST', body: {} });
          await loadConfig();
          toast('Signed out of Google', 'ok');
          renderProviders();
        });
      } else if (act === 'delete') {
        node.addEventListener('click', async () => {
          const providers = collectProviders().filter((p) => p.id !== pid);
          await saveProviders(providers);
          renderProviders();
        });
      }
    });
  });
  $('#cp-add').onclick = async () => {
    const name = $('#cp-name').value.trim();
    const url = $('#cp-url').value.trim();
    if (!name || !url) { toast('Name and base URL required', 'err'); return; }
    let id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    let base = id, n = 2;
    while ((state.cfg.providers || []).some((p) => p.id === id)) id = base + '-' + n++;
    const providers = collectProviders().concat([{
      id,
      name,
      type: 'custom',
      baseUrl: url,
      apiKey: $('#cp-key').value.trim(),
      enabled: true
    }]);
    await saveProviders(providers);
    renderProviders();
  };
}

function isLocalDashboard() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

let googlePollTimer = null;
function pollGoogleStatus() {
  if (googlePollTimer) clearInterval(googlePollTimer);
  const startedAt = Date.now();
  googlePollTimer = setInterval(async () => {
    if (Date.now() - startedAt > 180000) {
      clearInterval(googlePollTimer);
      googlePollTimer = null;
      return;
    }
    try {
      const s = await api('/api/google/status');
      if (s.authenticated) {
        clearInterval(googlePollTimer);
        googlePollTimer = null;
        await loadConfig();
        toast('Google account connected' + (s.email ? ': ' + s.email : ''), 'ok');
        if (state.view === 'providers') renderProviders();
      }
    } catch (e) { }
  }, 2000);
}

async function saveProvidersQuiet(providers) {
  const j = await api('/api/config', { method: 'PUT', body: { providers } });
  state.cfg = j;
  state.drafts = {};
}

function keyUrl(type) {
  switch (type) {
    case 'openrouter': return 'https://openrouter.ai/keys';
    case 'groq': return 'https://console.groq.com/keys';
    case 'gemini': return 'https://aistudio.google.com/apikey';
    case 'opencode': return 'https://opencode.ai';
    default: return '';
  }
}

function providerHint(p) {
  switch (p.type) {
    case 'openrouter': return 'Get a free key at openrouter.ai/keys. Models ending in ":free" cost nothing.';
    case 'groq': return 'Free key at console.groq.com/keys. Very fast Llama models, generous free tier.';
    case 'gemini': return 'Free key at aistudio.google.com/apikey. OpenAI-compatible endpoint is used.';
    case 'github': return 'GitHub Models was retired by GitHub on July 30, 2026 - this provider no longer works. Remove it and use OpenRouter, Groq, Gemini or Antigravity instead.';
    case 'antigravity': return 'No API key needed. Sign in with your Google account to use the free Antigravity / Gemini models (Gemini 3 Pro preview, 2.5 Pro, Flash) via Google\'s Code Assist quota.';
    case 'opencode':
      return p.id === 'opencode-go'
        ? 'OpenCode Go subscription ($10/mo flat, dollar-metered). Same API key as Zen (opencode.ai console) with an active Go plan. Curated coding models: GLM, Kimi, DeepSeek, MiniMax and more.'
        : 'Key from opencode.ai (sign in, then console > API keys). Models ending in "-free" cost nothing; Claude / GPT / Gemini models there are paid credits.';
    default: return 'Custom OpenAI-compatible endpoint. Leave the key empty for local servers like Ollama.';
  }
}

function openModelsModal(pid) {
  const p = (state.cfg.providers || []).find((x) => x.id === pid);
  if (!p) return;
  state.modal = { pid, models: [], selected: new Set(), q: '', freeOnly: false, loading: true, error: null, manual: '' };
  const root = $('#modal-root');
  root.classList.remove('hidden');
  root.innerHTML =
    '<div class="modal">' +
    '<h2>Browse models <span class="muted">- ' + esc(p.name) + '</span></h2>' +
    '<div class="row" style="margin-bottom:10px">' +
    '<input class="input grow" id="mm-search" placeholder="Search models...">' +
    '<label class="row" style="gap:6px;font-size:12.5px"><input type="checkbox" id="mm-free"> free only</label>' +
    '<button class="btn small" id="mm-select-all">Select all</button>' +
    '</div>' +
    '<div class="body" id="mm-list"></div>' +
    '<label class="field" style="margin-top:12px"><span>Or add a model id manually</span><span class="row"><input class="input mono grow" id="mm-manual" placeholder="model id"><button class="btn small" id="mm-add-manual">Add</button></span></label>' +
    '<div class="foot">' +
    '<span class="muted" id="mm-count"></span><span class="grow"></span>' +
    '<button class="btn" id="mm-close">Close</button>' +
    '<button class="btn primary" id="mm-add">Add selected to route</button>' +
    '</div>' +
    '</div>';
  $('#mm-search').addEventListener('input', (e) => { state.modal.q = e.target.value.toLowerCase(); renderModelList(); });
  $('#mm-free').addEventListener('change', (e) => { state.modal.freeOnly = e.target.checked; renderModelList(); });
  $('#mm-select-all').onclick = () => {
    const m = state.modal;
    if (!m || m.loading || m.error) return;
    const existing = new Set((state.cfg.route || []).map((c) => c.provider + '/' + c.model));
    const selectable = filteredModalModels().filter((x) => !existing.has(m.pid + '/' + x.id));
    const allSelected = selectable.length > 0 && selectable.every((x) => m.selected.has(x.id));
    if (allSelected) selectable.forEach((x) => m.selected.delete(x.id));
    else selectable.forEach((x) => m.selected.add(x.id));
    renderModelList();
  };
  $('#mm-close').onclick = closeModal;
  root.addEventListener('click', (e) => { if (e.target === root) closeModal(); });
  $('#mm-add').onclick = addSelectedToRoute;
  $('#mm-add-manual').onclick = () => {
    const v = $('#mm-manual').value.trim();
    if (!v) return;
    state.modal.selected.add(v);
    addSelectedToRoute();
  };
  api('/api/providers/' + encodeURIComponent(pid) + '/models')
    .then((j) => {
      if (!state.modal || state.modal.pid !== pid) return;
      state.modal.models = j.models || [];
      state.modal.loading = false;
      renderModelList();
    })
    .catch((e) => {
      if (!state.modal || state.modal.pid !== pid) return;
      state.modal.loading = false;
      state.modal.error = String(e.message || e);
      renderModelList();
    });
  renderModelList();
}

function filteredModalModels() {
  const m = state.modal;
  if (!m) return [];
  let models = m.models;
  if (m.freeOnly) models = models.filter((x) => x.free);
  if (m.q) models = models.filter((x) => x.id.toLowerCase().includes(m.q));
  return models;
}

function renderModelList() {
  const m = state.modal;
  const list = $('#mm-list');
  if (!m || !list) return;
  if (m.loading) { list.innerHTML = '<p class="muted">Loading models from ' + esc(m.pid) + '...</p>'; return; }
  if (m.error) { list.innerHTML = '<p style="color:var(--err)">Could not list models: ' + esc(m.error) + '</p><p class="muted">You can still add a model id manually below.</p>'; $('#mm-count').textContent = ''; return; }
  const existing = new Set((state.cfg.route || []).map((c) => c.provider + '/' + c.model));
  const models = filteredModalModels();
  const hasFree = m.models.some((x) => x.free);
  $('#mm-free').parentElement.style.display = hasFree ? '' : 'none';
  let html = '';
  models.forEach((x) => {
    const already = existing.has(m.pid + '/' + x.id);
    html +=
      '<label class="model-item"><input type="checkbox" data-mid="' + esc(x.id) + '"' + (m.selected.has(x.id) ? ' checked' : '') + (already ? ' disabled' : '') + '>' +
      '<span class="id">' + esc(x.id) + '</span>' +
      (x.free ? '<span class="badge free">free</span>' : '') +
      (x.context ? '<span class="ctx">' + Math.round(x.context / 1000) + 'k ctx</span>' : '') +
      (already ? '<span class="ctx">on route</span>' : '') +
      '</label>';
  });
  if (!models.length) html = '<p class="muted">No models match.</p>';
  else if (models.every((x) => existing.has(m.pid + '/' + x.id))) {
    html += '<p class="muted" style="padding:8px 4px">All listed models are already on the route - nothing left to add. Manage them on the Routing page.</p>';
  }
  list.innerHTML = html;
  $('#mm-count').textContent = m.selected.size ? m.selected.size + ' selected' : '';
  $$('#mm-list input[data-mid]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) m.selected.add(cb.dataset.mid);
      else m.selected.delete(cb.dataset.mid);
      $('#mm-count').textContent = m.selected.size ? m.selected.size + ' selected' : '';
    });
  });
  const selAll = $('#mm-select-all');
  if (selAll) {
    const selectable = models.filter((x) => !existing.has(m.pid + '/' + x.id));
    const allSelected = selectable.length > 0 && selectable.every((x) => m.selected.has(x.id));
    selAll.textContent = allSelected ? 'Clear selection' : 'Select all (' + selectable.length + ')';
    selAll.disabled = !selectable.length;
  }
}

async function addSelectedToRoute() {
  const m = state.modal;
  if (!m) return;
  const route = (state.cfg.route || []).slice();
  const seen = new Set(route.map((c) => c.provider + '/' + c.model));
  let added = 0;
  m.selected.forEach((mid) => {
    const k = m.pid + '/' + mid;
    if (seen.has(k)) return;
    seen.add(k);
    route.push({ provider: m.pid, model: mid });
    added++;
  });
  if (!added) { toast('Nothing new selected', 'err'); return; }
  const j = await api('/api/config', { method: 'PUT', body: { route } });
  state.cfg = j;
  toast('Added ' + added + ' model' + (added > 1 ? 's' : '') + ' to the route', 'ok');
  closeModal();
}

function closeModal() {
  state.modal = null;
  const root = $('#modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

function renderRouting() {
  const cfg = state.cfg;
  const el = $('#view-routing');
  if (!cfg) { el.innerHTML = '<p class="muted">loading...</p>'; return; }
  const rows = (cfg.route || []).map((c, i) => {
    const h = state.health.find((x) => x.provider === c.provider && x.model === c.model);
    const p = (cfg.providers || []).find((x) => x.id === c.provider);
    const dot = h ? healthDotClass(h.state) : 'dim';
    const errTxt = h && h.state === 'cooldown' && h.lastError ? '<span class="last-err" title="' + esc(h.lastError) + '">' + esc(h.lastError) + '</span>' : '';
    return (
      '<div class="route-row" data-idx="' + i + '" data-key="' + esc(c.provider) + '::' + esc(c.model) + '">' +
      '<span class="num">' + (i + 1) + '</span>' +
      '<span class="dot ' + dot + '"></span>' +
      '<span class="badge type">' + esc(p ? p.name : c.provider) + '</span>' +
      '<span class="model">' + esc(c.model) + '</span>' +
      errTxt +
      '<span class="grow"></span>' +
      '<span class="muted" style="font-size:11px" data-healthlabel>' + (h ? esc(healthLabel(h)) : '') + '</span>' +
      '<button class="btn small" data-act="up"' + (i === 0 ? ' disabled' : '') + '>&#8593;</button>' +
      '<button class="btn small" data-act="down"' + (i === cfg.route.length - 1 ? ' disabled' : '') + '>&#8595;</button>' +
      '<button class="btn small danger" data-act="remove">&#10005;</button>' +
      '</div>'
    );
  }).join('');
  el.innerHTML =
    '<h1>Routing</h1><p class="subtitle">The chain every request with model "auto" walks through, in order</p>' +
    '<div class="card"><h2>General</h2>' +
    '<div class="row wrap">' +
    '<label class="field" style="margin:0"><span>Strategy</span><select class="input" id="rt-strategy">' +
    '<option value="failover"' + (cfg.strategy === 'failover' ? ' selected' : '') + '>failover (top-down)</option>' +
    '<option value="round-robin"' + (cfg.strategy === 'round-robin' ? ' selected' : '') + '>round-robin (rotate)</option>' +
    '</select></label>' +
    '<label class="field" style="margin:0"><span>Route alias</span><input class="input mono" id="rt-alias" value="' + esc(cfg.routeName) + '"></label>' +
    '<label class="field" style="margin:0"><span>Failure cooldown (s)</span><input class="input" id="rt-cooldown" type="number" min="1" max="3600" value="' + Math.round(cfg.cooldownMs / 1000) + '"></label>' +
    '<label class="field" style="margin:0"><span>Request timeout (s)</span><input class="input" id="rt-timeout" type="number" min="5" max="600" value="' + Math.round(cfg.requestTimeoutMs / 1000) + '"></label>' +
    '</div>' +
    '<p class="muted" style="font-size:12px;margin:10px 0 0">A candidate that fails goes on cooldown and is skipped until it recovers. "provider/model" in the client request pins one model directly.</p>' +
    '</div>' +
    '<div class="card"><h2>Chain (' + (cfg.route || []).length + ')</h2>' +
    (rows || '<p class="muted">Empty. Add models from the Providers page.</p>') +
    '</div>';
  $('#rt-strategy').onchange = saveRoutingGeneral;
  $('#rt-alias').onchange = saveRoutingGeneral;
  $('#rt-cooldown').onchange = saveRoutingGeneral;
  $('#rt-timeout').onchange = saveRoutingGeneral;
  $$('#view-routing .route-row').forEach((row) => {
    const idx = Number(row.dataset.idx);
    const act = (name) => row.querySelector('[data-act=' + name + ']');
    if (act('up')) act('up').onclick = () => moveRoute(idx, -1);
    if (act('down')) act('down').onclick = () => moveRoute(idx, 1);
    if (act('remove')) act('remove').onclick = () => removeRoute(idx);
  });
}

async function saveRoutingGeneral() {
  const body = {
    strategy: $('#rt-strategy').value,
    routeName: $('#rt-alias').value,
    cooldownMs: Math.max(1, Number($('#rt-cooldown').value) || 60) * 1000,
    requestTimeoutMs: Math.max(5, Number($('#rt-timeout').value) || 180) * 1000
  };
  state.cfg = await api('/api/config', { method: 'PUT', body });
  toast('Routing settings saved', 'ok');
}

async function moveRoute(idx, dir) {
  const route = (state.cfg.route || []).slice();
  const j = idx + dir;
  if (j < 0 || j >= route.length) return;
  const tmp = route[idx];
  route[idx] = route[j];
  route[j] = tmp;
  state.cfg = await api('/api/config', { method: 'PUT', body: { route } });
  renderRouting();
}

async function removeRoute(idx) {
  const route = (state.cfg.route || []).slice();
  route.splice(idx, 1);
  state.cfg = await api('/api/config', { method: 'PUT', body: { route } });
  renderRouting();
}

function renderLogs() {
  const el = $('#view-logs');
  const rows = (state.logs || []).map((l) =>
    '<tr>' +
    '<td class="muted">' + timeStr(l.ts) + '</td>' +
    '<td class="mono">' + esc(l.requested) + '</td>' +
    '<td class="mono">' + (l.servedBy ? esc(l.servedBy) : '<span class="muted">-</span>') + '</td>' +
    '<td class="' + (l.ok ? 'okc' : 'errc') + '">' + (l.ok ? 'ok' : 'fail') + (l.httpStatus ? ' ' + l.httpStatus : '') + '</td>' +
    '<td>' + msStr(l.latencyMs) + (l.ttftMs != null ? ' <span class="muted">(ttfb ' + msStr(l.ttftMs) + ')</span>' : '') + '</td>' +
    '<td>' + (l.tokensIn != null || l.tokensOut != null ? (l.tokensIn || 0) + ' / ' + (l.tokensOut || 0) : '-') + '</td>' +
    '<td>' + (l.stream ? 'stream' : 'json') + (l.attempts > 1 ? ' <span class="muted">x' + l.attempts + '</span>' : '') + '</td>' +
    '<td class="errc" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (l.error ? esc(l.error) : '') + '</td>' +
    '</tr>'
  ).join('');
  el.innerHTML =
    '<h1>Request log</h1><p class="subtitle">Last ' + (state.logs || []).length + ' requests seen by the proxy</p>' +
    '<div class="row" style="margin-bottom:14px">' +
    '<label class="row" style="gap:6px;font-size:12.5px"><input type="checkbox" id="lg-errors"' + (state.logsErrorsOnly ? ' checked' : '') + '> errors only</label>' +
    '<span class="grow"></span>' +
    '<button class="btn small" id="lg-clear">Clear log</button>' +
    '</div>' +
    '<div class="card" style="padding:0;overflow:auto;max-height:calc(100vh - 220px)"><table class="tbl">' +
    '<thead><tr><th>time</th><th>requested</th><th>served by</th><th>status</th><th>latency</th><th>tokens in/out</th><th>mode</th><th>error</th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No requests yet. Try the Playground.</td></tr>') + '</tbody>' +
    '</table></div>';
  $('#lg-errors').onchange = (e) => { state.logsErrorsOnly = e.target.checked; loadLogs().then(renderLogs); };
  $('#lg-clear').onclick = async () => { await api('/api/logs/clear', { method: 'POST' }); await loadLogs(); renderLogs(); toast('Log cleared', 'ok'); };
}

function playgroundModelOptions() {
  const cfg = state.cfg;
  if (!cfg) return [{ id: 'auto', label: 'auto (route chain)' }];
  const opts = [{ id: 'auto', label: 'auto (route chain)' }];
  if (cfg.routeName && cfg.routeName !== 'auto') opts.push({ id: cfg.routeName, label: cfg.routeName + ' (alias)' });
  (cfg.route || []).forEach((c) => opts.push({ id: c.provider + '/' + c.model, label: c.provider + '/' + c.model }));
  return opts;
}

function codingScore(model) {
  const m = model.toLowerCase();
  let s = 0;
  if (/codex|coder|-code(\b|-)|code-/.test(m)) s += 50;
  if (/claude|sonnet|opus|fable/.test(m)) s += 42;
  if (/gpt-[56]/.test(m)) s += 38;
  if (/gemini-3/.test(m)) s += 36;
  if (/deepseek/.test(m)) s += 32;
  if (/kimi/.test(m)) s += 28;
  if (/glm/.test(m)) s += 26;
  if (/qwen/.test(m)) s += 24;
  if (/grok/.test(m)) s += 22;
  if (/gemini-2\.5-pro/.test(m)) s += 20;
  if (/llama|nemotron|minimax|mistral/.test(m)) s += 12;
  if (/pro|max|ultra/.test(m)) s += 4;
  if (/flash|mini|lite/.test(m)) s -= 6;
  if (/nano|1b|3b|8b|haiku/.test(m)) s -= 12;
  return s;
}

function topCodingModels(n) {
  const route = (state.cfg && state.cfg.route) || [];
  return route
    .map((c) => ({ id: c.provider + '/' + c.model, score: codingScore(c.model) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

function renderPlayground() {
  const el = $('#view-playground');
  const opts = playgroundModelOptions();
  if (!state.chat.messages.length) {
    state.chat.messages.push({ role: 'assistant', content: 'Pick a model, type a message and press Enter. Replies show which free model actually served the request.', intro: true });
  }
  if (!opts.some((o) => o.id === state.chat.model)) state.chat.model = 'auto';
  el.innerHTML =
    '<h1>Playground</h1><p class="subtitle">Test the route exactly like a real client would</p>' +
    '<div class="playwrap">' +
    '<div class="playchat">' +
    '<div class="pg-msgs" id="pg-msgs"></div>' +
    '<div class="pg-input-row">' +
    '<textarea id="pg-input" placeholder="Message... (Enter to send, Shift+Enter for newline)"></textarea>' +
    '<button class="btn primary" id="pg-send">Send</button>' +
    '</div>' +
    '</div>' +
    '<div class="pg-side">' +
    '<label class="field"><span>Model</span><select class="input" id="pg-model">' +
    opts.map((o) => '<option value="' + esc(o.id) + '"' + (o.id === state.chat.model ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
    '</select></label>' +
    (function () {
      const top = topCodingModels(5);
      if (!top.length) return '';
      return '<div class="field"><span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px">Top for coding</span>' +
        '<div class="col" style="display:flex;flex-direction:column;gap:5px">' +
        top.map((t, i) =>
          '<button class="btn small pg-top-model' + (t.id === state.chat.model ? ' primary' : '') + '" data-model="' + esc(t.id) + '" style="justify-content:flex-start;text-align:left;font-family:var(--mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          (i + 1) + '. ' + esc(t.id) +
          '</button>'
        ).join('') +
        '</div></div>';
    })() +
    '<label class="field"><span>Max output tokens <span class="muted">- lower if a provider rejects the request</span></span><input class="input" id="pg-maxtok" type="number" min="16" max="32000" value="' + state.chat.maxTokens + '"></label>' +
    '<label class="field"><span>Streaming</span><label class="switch"><input type="checkbox" id="pg-stream"' + (state.chat.stream ? ' checked' : '') + '><span class="track"></span></label></label>' +
    '<button class="btn" id="pg-clear" style="width:100%">Clear conversation</button>' +
    '<div class="card" style="margin:0"><h2 style="font-size:13px">How it works</h2><p class="muted" style="font-size:12px;margin:0">"auto" walks the route chain. A specific "provider/model" pins one candidate. Failed candidates are retried on the next one automatically.</p></div>' +
    '</div>' +
    '</div>';
  $('#pg-model').onchange = (e) => { state.chat.model = e.target.value; };
  $$('.pg-top-model').forEach((btn) => {
    btn.onclick = () => {
      state.chat.model = btn.dataset.model;
      const sel = $('#pg-model');
      if (sel) sel.value = state.chat.model;
      $$('.pg-top-model').forEach((b) => b.classList.toggle('primary', b.dataset.model === state.chat.model));
    };
  });
  $('#pg-stream').onchange = (e) => { state.chat.stream = e.target.checked; };
  $('#pg-maxtok').onchange = (e) => {
    const v = Math.max(16, Math.min(32000, Number(e.target.value) || 800));
    state.chat.maxTokens = v;
    e.target.value = v;
  };
  $('#pg-clear').onclick = () => { state.chat.messages = []; renderPlayground(); };
  $('#pg-send').onclick = sendChat;
  $('#pg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  renderChat();
}

function formatMessage(text) {
  // Split on ``` fences: even chunks are prose, odd chunks are code blocks.
  const parts = String(text == null ? '' : text).split('```');
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) {
        html += '<span class="content">' + esc(part).replace(/`([^`\n]+)`/g, '<code class="ic">$1</code>') + '</span>';
      }
    } else {
      const nl = part.indexOf('\n');
      let lang = '', code = part;
      if (nl > -1 && nl < 30 && /^[a-zA-Z0-9+#._-]*$/.test(part.slice(0, nl).trim())) {
        lang = part.slice(0, nl).trim();
        code = part.slice(nl + 1);
      }
      code = code.replace(/\n$/, '');
      html +=
        '<div class="codeblock">' +
        '<div class="cb-head"><span class="cb-lang">' + esc(lang || 'code') + '</span>' +
        '<button class="btn small cb-copy" type="button">Copy</button></div>' +
        '<pre class="cb-body"><code>' + esc(code) + '</code></pre>' +
        '</div>';
    }
  });
  return html || '<span class="content"></span>';
}

function renderChat() {
  const box = $('#pg-msgs');
  if (!box) return;
  box.innerHTML = state.chat.messages.map((m, i) => {
    const cls = m.role === 'user' ? 'user' : m.error ? 'assistant error' : 'assistant';
    const body = m.pending
      ? '<span class="typing"><span></span><span></span><span></span></span>'
      : m.role === 'assistant' && !m.error && !m.streaming
        ? formatMessage(m.content)
        : '<span class="content">' + esc(m.content) + '</span>';
    return (
      '<div class="msg ' + cls + (m.streaming ? ' streaming' : '') + '">' +
      body +
      (m.via ? '<div class="via">via ' + esc(m.via) + '</div>' : '') +
      (m.usage ? '<div class="usage">' + (m.usage.prompt_tokens || 0) + ' in / ' + (m.usage.completion_tokens || 0) + ' out tokens</div>' : '') +
      '</div>'
    );
  }).join('');
  $$('.cb-copy', box).forEach((btn) => {
    btn.onclick = () => {
      const code = btn.closest('.codeblock').querySelector('.cb-body').textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }).catch(() => toast('Copy failed - clipboard blocked', 'err'));
    };
  });
  box.scrollTop = box.scrollHeight;
}

function scrollChat() {
  const box = $('#pg-msgs');
  if (box) box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  if (state.chat.busy) return;
  const input = $('#pg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  state.chat.messages.push({ role: 'user', content: text });
  const opts = playgroundModelOptions().map((o) => o.id);
  if (!opts.includes(state.chat.model)) state.chat.model = 'auto';
  state.chat.busy = true;
  $('#pg-send').disabled = true;
  const wait = { role: 'assistant', content: '', pending: true };
  state.chat.messages.push(wait);
  renderChat();
  try {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, apiKeyHeader());
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: state.chat.model, messages: state.chat.messages.filter((m) => !m.intro && !m.pending).map((m) => ({ role: m.role, content: m.content })), stream: state.chat.stream, max_tokens: state.chat.maxTokens })
    });
    const via = res.headers.get('x-token-route-candidate');
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) { }
      wait.pending = false;
      wait.content = msg;
      wait.error = true;
    } else if (state.chat.stream) {
      const live = wait;
      live.pending = false;
      live.streaming = true;
      live.via = via;
      renderChat();
      const liveEl = $('#pg-msgs').lastElementChild;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const j = JSON.parse(raw);
            const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (d) {
              acc += d;
              live.content = acc;
              const cEl = liveEl.querySelector('.content');
              if (cEl) cEl.textContent = acc;
              scrollChat();
            }
            if (j.usage) live.usage = j.usage;
          } catch (e) { }
        }
      }
      live.streaming = false;
      if (!acc) live.content = '(no content returned)';
      live.usage = live.usage || null;
    } else {
      const j = await res.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      wait.pending = false;
      wait.content = msg.content || '(empty response)';
      wait.via = via;
      wait.usage = j.usage;
    }
  } catch (e) {
    wait.pending = false;
    wait.content = 'Request failed: ' + e.message;
    wait.error = true;
  } finally {
    state.chat.busy = false;
    $('#pg-send').disabled = false;
    renderChat();
    loadHealth().catch(() => { });
  }
}

function renderSettings() {
  const cfg = state.cfg;
  const el = $('#view-settings');
  if (!cfg) { el.innerHTML = '<p class="muted">loading...</p>'; return; }
  el.innerHTML =
    '<h1>Settings</h1><p class="subtitle">Proxy key, port and storage location</p>' +
    '<div class="card"><h2>Security</h2>' +
    '<label class="field"><span>Proxy API key <span class="muted">- clients and this dashboard must send it as x-api-key or Bearer. Empty = open (fine on localhost).</span></span>' +
    '<input class="input mono" id="st-key" type="password" placeholder="' + (cfg.hasProxyKey ? esc(cfg.proxyKeyMasked) + ' (saved)' : 'not set') + '">' +
    '</label>' +
    '<div class="row"><button class="btn" id="st-key-clear">Remove key</button></div>' +
    '</div>' +
    '<div class="grid2">' +
    '<div class="card"><h2>Network</h2>' +
    '<label class="field"><span>Port</span><input class="input" id="st-port" type="number" value="' + cfg.port + '"></label>' +
    '<label class="field"><span>Host <span class="muted">- use 0.0.0.0 to expose to your LAN (risk)</span></span><input class="input mono" id="st-host" value="' + esc(cfg.host) + '"></label>' +
    '<p class="muted" style="font-size:12px">Port/host changes apply after restart.</p>' +
    '</div>' +
    '<div class="card"><h2>Storage</h2>' +
    '<p class="muted" style="font-size:13px">Everything lives in <span class="mono">data/config.json</span> next to the app (override with the <span class="mono">TOKEN_ROUTE_HOME</span> env var). API keys never leave this machine.</p>' +
    '</div>' +
    '</div>' +
    '<button class="btn primary" id="st-save">Save settings</button>';
  $('#st-save').onclick = async () => {
    const body = {
      port: Number($('#st-port').value) || cfg.port,
      host: $('#st-host').value.trim() || cfg.host
    };
    const keyVal = $('#st-key').value.trim();
    if (keyVal) body.proxyKey = keyVal;
    const j = await api('/api/config', { method: 'PUT', body });
    state.cfg = j;
    if (keyVal) localStorage.setItem('tr_key', keyVal);
    toast(j.restartRequired ? 'Saved. Restart Token Route to apply port/host.' : 'Settings saved', 'ok');
    renderSettings();
  };
  $('#st-key-clear').onclick = async () => {
    const j = await api('/api/config', { method: 'PUT', body: { proxyKey: null } });
    state.cfg = j;
    localStorage.removeItem('tr_key');
    toast('Proxy key removed', 'ok');
    renderSettings();
  };
}

let pollBusy = false;
async function tick() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    if (!state.status) await loadStatus().catch(() => { });
    if (!state.cfg) await loadConfig().catch(() => { });
    if (state.view === 'overview') {
      await Promise.all([loadStats(), loadHealth(), loadStatus()]).catch(() => { });
      renderOverview();
    } else if (state.view === 'routing') {
      await loadHealth().catch(() => { });
      updateRoutingDots();
    } else if (state.view === 'logs') {
      await loadLogs().catch(() => { });
      renderLogs();
    }
  } finally {
    pollBusy = false;
  }
}

function updateRoutingDots() {
  $$('#view-routing .route-row').forEach((row) => {
    const dot = row.querySelector('.dot');
    if (!dot || !row.dataset.key) return;
    const h = state.health.find((x) => x.key === row.dataset.key);
    if (!h) return;
    dot.className = 'dot ' + healthDotClass(h.state);
    const lbl = row.querySelector('[data-healthlabel]');
    if (lbl) lbl.textContent = healthLabel(h);
  });
}

async function init() {
  $$('#nav button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });
  try {
    await loadStatus();
    $('#side-status-text').textContent = 'running :' + state.status.port;
    $('#side-version').textContent = 'v' + state.status.version;
  } catch (e) { }
  try {
    await loadConfig();
    await loadHealth();
    await loadStats();
  } catch (e) { }
  setView('overview');
  setInterval(tick, 3000);
}

init();
