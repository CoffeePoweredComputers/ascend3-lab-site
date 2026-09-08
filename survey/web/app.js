/* Participant app. Server-authoritative: this file only renders what
 * GET /api/s/:id/state returns and posts actions. No framework, no bundler,
 * no third-party requests (a CSP enforces that too). */
(function () {
  'use strict';
  const body = document.body;
  const BASE = body.dataset.base || '';
  const SURVEY = body.dataset.survey || '';
  const params = new URLSearchParams(location.search);
  const previewSession = params.get('session');

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const screens = $$('[data-screen]');
  const errorEl = $('[data-error]');

  let view = null; // last SessionView
  let survey = null;
  let waveLabel = '';
  let busy = false;

  /* ── theme (light by default; explicit choice remembered per browser) ── */
  const THEME_KEY = 'ascend-survey-theme';
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const b = $('[data-theme-toggle]');
    if (b) b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  try { applyTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'); } catch (_) { applyTheme('light'); }
  $('[data-theme-toggle]').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* storage blocked */ }
  });

  function show(name) {
    screens.forEach((s) => (s.hidden = s.dataset.screen !== name));
    if (name !== 'chat') document.title = survey ? survey.title : 'Adaptive survey';
  }
  function setError(msg) {
    if (!msg) { errorEl.hidden = true; errorEl.textContent = ''; return; }
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  async function api(path, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    o.credentials = 'same-origin';
    o.headers = Object.assign({ 'X-Requested-With': 'fetch', 'X-Survey-Page': location.pathname + location.search }, o.headers || {});
    if (o.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const res = await fetch(BASE + '/api' + path, o);
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json: json || {} };
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }); } catch (_) { return iso; }
  }

  /* ── model status light (polled while signed in; refreshed after each answer) ── */
  const statusEl = $('[data-llm-status]');
  const llmNote = $('[data-llm-note]');
  const STATUS_LABELS = { ok: 'Follow-ups ready', degraded: 'Follow-ups slow', down: 'Follow-ups unavailable', unknown: 'Checking…' };
  let statusTimer = null;
  function paintStatus(st) {
    if (!statusEl) return;
    const state = st && STATUS_LABELS[st.state] ? st.state : 'unknown';
    const mock = !!(st && st.provider === 'mock');
    statusEl.className = 'status is-' + state + (mock ? ' is-mock' : '');
    $('.status__label', statusEl).textContent = mock && state === 'ok' ? 'Test model' : STATUS_LABELS[state];
    const bits = [];
    if (st) {
      if (st.provider) bits.push(st.provider === 'arc' ? 'Virginia Tech ARC' : st.provider);
      if (st.lastCall && st.lastCall.ms != null) bits.push('last follow-up took ' + (st.lastCall.ms / 1000).toFixed(1) + ' s');
      if (st.probe && st.probe.error) bits.push(st.probe.error);
    }
    statusEl.title = bits.join(' · ');
    if (llmNote) llmNote.hidden = state !== 'down';
  }
  async function pollStatus() {
    try {
      const r = await api('/llm-status');
      if (r.ok) paintStatus(r.json);
      else if (r.status === 401) stopStatus();
    } catch (_) { /* transient; next tick */ }
  }
  function startStatus() {
    if (statusTimer) return;
    pollStatus();
    statusTimer = setInterval(pollStatus, 30000);
  }
  function stopStatus() { if (statusTimer) clearInterval(statusTimer); statusTimer = null; }

  /* ── boot ── */
  async function load() {
    setError('');
    if (!SURVEY) { show('landing'); return; }
    const q = previewSession ? '?session=' + encodeURIComponent(previewSession) : '';
    const r = await api('/s/' + encodeURIComponent(SURVEY) + '/state' + q);
    if (r.status === 401) { renderSignedOut(r.json.login); return; }
    if (!r.ok) { show('landing'); setError(r.json.message || 'Could not load this survey.'); return; }
    render(r.json);
  }

  function renderSignedOut(loginUrl) {
    show('signedout');
    $('[data-login-link]').href = loginUrl || BASE + '/auth/login?next=' + encodeURIComponent(location.pathname + location.search);
    $('[data-signedout-note]').hidden = !params.has('signedout');
    $('[data-cas-logout]').href = BASE + '/auth/cas-logout';
  }

  function render(state) {
    survey = state.survey;
    waveLabel = state.wave ? state.wave.label : '';
    const nav = $('[data-topnav]');
    nav.hidden = false;
    $$('[data-info-link]').forEach((a) => (a.href = BASE + '/s/' + survey.id + '/info-sheet'));
    $('[data-admin-link]').hidden = !(state.roles && (state.roles.researcher || state.roles.keyholder));
    $('[data-preview-banner]').hidden = !state.preview;
    startStatus();

    switch (state.phase) {
      case 'consent': return renderConsent(state);
      case 'closed': return renderClosed(state);
      case 'ready': return renderReady(state);
      case 'in_session': view = state.view; return renderChat();
      case 'completed': view = state.view; return renderDone(state.sessionStatus);
      default: show('landing');
    }
  }

  /* ── consent ── */
  function renderConsent(state) {
    const c = state.consent;
    show('consent');
    $('[data-sheet]').innerHTML = c.sheetHtml; // server-rendered from the researcher's approved markdown
    $('[data-agree-label]').textContent = c.agreeLabel;
    $('[data-consent-decline]').textContent = c.declineLabel;
    const ferpa = $('[data-ferpa]');
    ferpa.hidden = !c.ferpa;
    if (c.ferpa) $('[data-ferpa-label]').textContent = c.ferpa.label;
    const blocked = c.rosterMode === 'required' && c.onRoster === false;
    $('[data-roster-note]').hidden = !blocked;
    $('[data-consent-continue]').disabled = blocked;
    if (c.ferpa && c.ferpa.requireNameAndDate) {
      const t = new Date();
      $('[name=ferpaDate]').value = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    }
  }

  $('[data-consent-form]').addEventListener('change', (ev) => {
    if (ev.target.name === 'ferpaGranted') {
      const fields = $('[data-ferpa-fields]');
      fields.hidden = !ev.target.checked;
      if (ev.target.checked) $('[name=ferpaName]').focus();
    }
  });

  $('[data-consent-form]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const f = ev.currentTarget;
    if (!f.elements.agree.checked) { setError('Please tick the consent box to continue, or choose "I do not wish to participate".'); return; }
    const ferpaGranted = f.elements.ferpaGranted && f.elements.ferpaGranted.checked;
    const payload = { adult: true, agree: true };
    if (ferpaGranted) payload.ferpa = { granted: true, name: f.elements.ferpaName.value.trim(), date: f.elements.ferpaDate.value };
    busy = true; setError('');
    const r = await api('/s/' + SURVEY + '/consent', { method: 'POST', body: payload });
    busy = false;
    if (r.status === 201 || r.status === 409) { await load(); return; }
    setError(r.json.message || 'Could not record your consent. Please try again.');
  });

  $('[data-consent-decline]').addEventListener('click', () => {
    // Nothing is recorded. Sign out of the survey and show the signed-out note.
    const form = document.createElement('form');
    form.method = 'post'; form.action = BASE + '/auth/logout';
    document.body.appendChild(form); form.submit();
  });

  /* ── closed / ready ── */
  function renderClosed(state) {
    show('closed');
    const title = $('[data-closed-title]');
    const msg = $('[data-closed-msg]');
    if (state.reason === 'survey_closed') { title.textContent = 'This survey has closed'; msg.textContent = 'Thank you for taking part. There is nothing more to do here.'; }
    else if (state.reason === 'not_yet_open' && state.nextWave) { title.textContent = 'Not open yet'; msg.textContent = 'The next survey (' + state.nextWave.label + ') opens on ' + fmtDate(state.nextWave.opensAt) + '. You are all set until then.'; }
    else { title.textContent = 'No survey is open right now'; msg.textContent = 'You are enrolled. Come back when the next survey is announced.'; }
  }

  function renderReady(state) {
    show('ready');
    $('[data-ready-eyebrow]').textContent = state.wave.label;
    $('[data-ready-title]').textContent = survey.title;
    $('[data-opening]').textContent = survey.opening;
  }

  $('[data-start]').addEventListener('click', async () => {
    if (busy) return;
    busy = true; setError('');
    const r = await api('/s/' + SURVEY + '/sessions', { method: 'POST', body: {} });
    busy = false;
    if (!r.ok) { setError(r.json.message || 'Could not start the survey.'); return; }
    view = r.json.view;
    renderChat();
  });

  /* ── chat ── */
  const scrollEl = $('[data-transcript]');
  const composer = $('[data-composer]');
  const textarea = $('#answer');
  const sendBtn = $('[data-send]');
  const skipBtn = $('[data-skip]');
  const stopBtn = $('[data-stop]');
  const stopDialog = $('[data-stop-dialog]');
  const segmentsEl = $('[data-segments]');

  function msg(kind, text, caption, extraClass) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--' + kind + (extraClass ? ' ' + extraClass : '');
    if (caption) {
      const cap = document.createElement('span');
      cap.className = 'msg__cap';
      cap.textContent = caption;
      wrap.appendChild(cap);
    }
    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    return wrap;
  }

  function renderSegments(count, current) {
    segmentsEl.replaceChildren();
    for (let i = 0; i < count; i++) {
      const li = document.createElement('li');
      if (i < current) li.className = 'is-done';
      else if (i === current) li.className = 'is-current';
      segmentsEl.appendChild(li);
    }
  }

  function renderChat() {
    show('chat');
    const n = view.session.starterIndex + 1;
    const N = view.starterCount;
    document.title = 'Question ' + n + ' of ' + N + ' — ' + survey.title;
    $('[data-chat-title]').textContent = survey.title + (waveLabel ? ' · ' + waveLabel : '');

    scrollEl.replaceChildren();
    scrollEl.appendChild(msg('q', survey.opening, null, 'msg--opening'));
    for (const t of view.transcript) {
      if (t.kind === 'answer') scrollEl.appendChild(msg('you', t.text, null));
      else if (t.kind === 'starter') scrollEl.appendChild(msg('q', t.text, 'Question ' + (t.starterIndex + 1), 'msg--starter'));
      else scrollEl.appendChild(msg('q', t.text, 'Follow-up', 'msg--probe'));
    }

    const active = view.session.status === 'active' && view.current;
    if (!active) { renderDone(view.session.status); return; }

    renderSegments(N, view.session.starterIndex);
    const prog = $('[data-progress]');
    prog.textContent = 'Question ' + n + ' of ' + N;
    if (view.current.kind === 'probe') {
      const small = document.createElement('small');
      small.textContent = ' · follow-up ' + view.session.probeCount + ' of ' + view.maxProbes;
      prog.appendChild(small);
    }
    setComposer(true);
    textarea.value = '';
    autosize();
    textarea.focus();
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function setComposer(enabled) {
    textarea.disabled = !enabled;
    sendBtn.disabled = !enabled;
    skipBtn.disabled = !enabled;
    stopBtn.disabled = !enabled;
  }

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 192) + 'px';
  }
  textarea.addEventListener('input', autosize);

  function typing(on) {
    const existing = $('.msg--typing', scrollEl);
    if (existing) existing.remove();
    if (on) {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg--q msg--typing';
      const bubble = document.createElement('div');
      bubble.className = 'msg__bubble typing';
      bubble.innerHTML = '<i></i><i></i><i></i>';
      const sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = 'Thinking about a follow-up…';
      wrap.append(bubble, sr);
      scrollEl.appendChild(wrap);
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }

  async function act(kind, payload) {
    if (busy || !view) return;
    busy = true; setError(''); setComposer(false);
    const r = await api('/sessions/' + view.session.id + '/' + kind, { method: 'POST', body: Object.assign({ expectedSeq: view.session.seq }, payload || {}) });
    busy = false;
    typing(false);
    void pollStatus();
    if (r.ok || (r.status === 409 && r.json.view)) { view = r.json.view; renderChat(); return; }
    if (r.status === 401) { renderSignedOut(r.json.login); return; }
    if (r.status === 410) { await load(); return; }
    setError(r.json.message || 'That did not go through. Please try again.');
    setComposer(true);
    textarea.focus();
  }

  composer.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    scrollEl.appendChild(msg('you', text, null, 'msg--pending'));
    typing(true);
    await act('answer', { text });
  });

  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); composer.requestSubmit(); }
  });

  skipBtn.addEventListener('click', () => act('skip'));

  stopBtn.addEventListener('click', () => {
    if (typeof stopDialog.showModal === 'function') stopDialog.showModal();
    else if (window.confirm('Stop the survey now? What you have entered is kept.')) act('stop');
  });
  stopDialog.addEventListener('close', () => { if (stopDialog.returnValue === 'stop') act('stop'); });

  /* ── done ── */
  function renderDone(status) {
    show('done');
    const title = $('[data-done-title]');
    const note = $('[data-done-note]');
    $('[data-closing]').textContent = survey.closing;
    if (status === 'stopped') { title.textContent = 'Survey stopped'; note.textContent = 'You stopped the survey. What you entered before stopping has been kept, as described in the information sheet.'; }
    else if (status === 'expired') { title.textContent = 'This survey wave has closed'; note.textContent = 'The window for this wave ended before the session finished. What you entered has been kept.'; }
    else { title.textContent = 'Thank you'; note.textContent = ''; }
  }

  load().catch((e) => { show('landing'); setError('Something went wrong loading the page. ' + (e && e.message ? e.message : '')); });
})();
