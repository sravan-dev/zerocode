'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const next = (() => {
    const n = params.get('next') || '';
    return n.startsWith('/') && !n.startsWith('//') ? n : '/zerocode/';
  })();
  let mode = 'login';

  function showError(msg) {
    const e = $('error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  function setMode(m) {
    mode = m;
    const reg = m === 'register';
    $('tab-login').setAttribute('aria-selected', String(!reg));
    $('tab-register').setAttribute('aria-selected', String(reg));
    $('name-field').classList.toggle('hidden', !reg);
    $('title').textContent = reg ? 'Create your account' : 'Welcome back';
    $('subtitle').textContent = reg ? 'Free to start. Chat with many AI models in one place.' : 'Sign in to keep chatting with the best AI models.';
    $('submit').textContent = reg ? 'Create account' : 'Sign in';
    $('google-label').textContent = reg ? 'Sign up with Google' : 'Continue with Google';
    $('form').password.autocomplete = reg ? 'new-password' : 'current-password';
    showError('');
  }

  $('tab-login').addEventListener('click', () => setMode('login'));
  $('tab-register').addEventListener('click', () => setMode('register'));

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { email: f.email.value.trim(), password: f.password.value };
    if (mode === 'register') body.name = f.name.value.trim();
    if (!body.email || !body.password) { showError('Enter your email and password.'); return; }
    if (mode === 'register' && body.password.length < 8) { showError('Password must be at least 8 characters.'); return; }
    const btn = $('submit');
    btn.disabled = true;
    showError('');
    try {
      const res = await fetch(mode === 'register' ? '/auth/register' : '/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Something went wrong (HTTP ${res.status}).`);
      location.replace(next);
    } catch (err) {
      showError(err.message === 'Failed to fetch' ? 'Cannot reach the server. Check your connection.' : err.message);
      btn.disabled = false;
    }
  });

  // Google button only when the server has a Google client configured.
  fetch('/auth/config').then((r) => r.json()).then((c) => {
    if (!c.google) return;
    $('google').href = '/auth/google?next=' + encodeURIComponent(next);
    $('google').classList.remove('hidden');
    $('or').classList.remove('hidden');
  }).catch(() => { });

  if (params.get('mode') === 'register') setMode('register');
  if (params.get('error')) showError(params.get('error'));
})();
