/* Researcher page: create a survey, hand out its link, read the responses as
 * a grid — one row per participant, one column per question and follow-up.
 * Coded data only: no PID reaches this page except through the keyholder's
 * logged key download. Plain browser JS, no bundler, no third-party requests. */
(function () {
  'use strict';
  const BASE = document.body.dataset.base || '';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const errorEl = $('[data-error]');
  const noticeEl = $('[data-notice]');
  const DASH = '–';

  /* ── theme ── */
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

  /* ── small helpers ── */
  function show(name) { $$('[data-screen]').forEach((s) => (s.hidden = s.dataset.screen !== name)); }
  function setError(m) { errorEl.hidden = !m; errorEl.textContent = m || ''; }
  let noticeTimer = null;
  function notice(m, ms) {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    noticeEl.hidden = !m; noticeEl.textContent = m || '';
    if (m) noticeTimer = setTimeout(() => notice(''), ms || 6000);
  }
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const pad = (n) => String(n).padStart(2, '0');
  const isoDatePlus = (days) => { const t = new Date(Date.now() + days * 86400000); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); };
  const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return iso; } };

  async function api(path, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    o.credentials = 'same-origin';
    o.headers = Object.assign({ 'X-Requested-With': 'fetch', 'X-Survey-Page': location.pathname }, o.headers || {});
    if (o.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const res = await fetch(BASE + (path.startsWith('/llm-status') ? '/api' : '/api/admin') + path, o);
    let json = {};
    try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, ok: res.ok, json };
  }

  async function copyText(input, okMsg) {
    input.focus(); input.select();
    try { await navigator.clipboard.writeText(input.value); notice(okMsg); }
    catch (_) { notice('Select the link and copy it with Ctrl/Cmd+C.'); }
  }

  /* ── model status light (detailed) ── */
  const statusEl = $('[data-llm-status]');
  const STATE_WORD = { ok: 'connected', degraded: 'slow or failing', down: 'unavailable', unknown: 'checking' };
  function paintStatus(st) {
    if (!statusEl) return;
    const state = st && STATE_WORD[st.state] ? st.state : 'unknown';
    const mock = !!(st && st.provider === 'mock');
    statusEl.className = 'status is-' + state + (mock ? ' is-mock' : '');
    const parts = [];
    if (st) {
      parts.push(st.provider === 'arc' ? 'ARC' : st.provider === 'mock' ? 'Mock model' : st.provider);
      if (st.model) parts.push(st.model);
      parts.push(STATE_WORD[state]);
      if (st.lastCall && st.lastCall.ms != null) parts.push((st.lastCall.ms / 1000).toFixed(1) + ' s');
    } else parts.push('checking');
    $('.status__label', statusEl).textContent = parts.join(' · ');
    const tips = [];
    if (st && st.probe && st.probe.at) tips.push('last check ' + fmtWhen(st.probe.at) + (st.probe.error ? ' — ' + st.probe.error : ' — ok'));
    if (st && st.lastCall && st.lastCall.at) tips.push('last call ' + fmtWhen(st.lastCall.at) + (st.lastCall.ok ? ' — ok' : ' — ' + (st.lastCall.error || 'failed')));
    statusEl.title = tips.join('\n');
  }
  async function pollStatus() {
    try { const r = await api('/llm-status'); if (r.ok) paintStatus(r.json); } catch (_) { /* next tick */ }
  }

  /* ── survey list ── */
  async function load() {
    setError('');
    const r = await api('/surveys');
    if (r.status === 401) { show('signedout'); $('[data-login-link]').href = r.json.login || BASE + '/auth/login?next=' + encodeURIComponent(location.pathname); return; }
    if (!r.ok) { setError(r.json.message || 'Could not load.'); return; }
    $('[data-topnav]').hidden = false;
    $('[data-pid]').textContent = r.json.pid;
    $('[data-new]').hidden = !r.json.canCreate;
    render(r.json.surveys || []);
    show('list');
    pollStatus();
    if (!load.timer) load.timer = setInterval(pollStatus, 30000);
  }

  /** The wave a researcher most likely wants to look at: the last one already open, else the first. */
  function defaultWave(waves) {
    const now = Date.now();
    let pick = waves[0];
    for (const w of waves) if (Date.parse(w.opensAt) <= now) pick = w;
    return pick ? pick.id : '';
  }

  function render(surveys) {
    const host = $('[data-surveys]');
    host.replaceChildren();
    if (!surveys.length) {
      host.appendChild(el('p', 'muted', 'You have no role on any survey yet.'));
      return;
    }
    const tpl = $('[data-survey-card]');
    for (const s of surveys) host.appendChild(card(tpl, s));
  }

  function card(tpl, s) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const f = (k) => $('[data-f="' + k + '"]', node);

    f('title').textContent = s.title;
    f('id').textContent = s.id;
    const status = f('status');
    status.textContent = s.status;
    status.className = 'tag tag--' + s.status;
    const source = [s.source === 'db' ? 'created on this page' : 'defined in surveys/' + s.id + '.json'];
    if (s.irbProtocol) source.push(s.irbProtocol);
    source.push('model ' + s.model);
    source.push((s.responses == null ? 0 : s.responses) + (s.responses === 1 ? ' response' : ' responses'));
    f('source').textContent = source.join(' · ');

    const linkEl = $('[data-link]', node);
    linkEl.value = s.participantUrl || '';
    $('[data-link-copy]', node).addEventListener('click', () => copyText(linkEl, 'Participant link copied.'));

    const results = f('results');
    if (!s.roles.researcher) results.hidden = true;
    else setupResults(node, s);

    const kh = f('keyholder');
    if (!s.roles.keyholder) kh.hidden = true;
    else setupKeyholder(node, s);

    return node;
  }

  /* ── results grid ── */
  function setupResults(node, s) {
    const waveSel = $('[data-wave]', node);
    for (const w of s.waves) { const o = el('option', null, w.label); o.value = w.id; waveSel.appendChild(o); }
    waveSel.value = defaultWave(s.waves);
    $('[data-wave-wrap]', node).hidden = s.waves.length <= 1;
    const inc = $('[data-include-preview]', node);
    const countEl = $('[data-grid-count]', node);

    function params(withWave) {
      const q = new URLSearchParams();
      if (withWave && waveSel.value) q.set('wave', waveSel.value);
      if (inc.checked) q.set('includePreview', '1');
      const str = q.toString();
      return str ? '?' + str : '';
    }
    function setLinks() {
      $('[data-export="results.csv"]', node).href = BASE + '/api/admin/s/' + s.id + '/export/results.csv' + params(true);
      $('[data-export="transcripts.jsonl"]', node).href = BASE + '/api/admin/s/' + s.id + '/export/transcripts.jsonl' + params(false);
    }
    async function loadResults() {
      setLinks();
      countEl.textContent = 'Loading responses…';
      const r = await api('/s/' + s.id + '/results' + params(true));
      if (!r.ok) { setError(r.json.message || 'Could not load responses.'); countEl.textContent = ''; return; }
      renderGrid(node, r.json);
      const n = r.json.rows.length;
      countEl.textContent = n + (n === 1 ? ' response' : ' responses') + (s.waves.length > 1 && r.json.wave && r.json.wave.label ? ' in ' + r.json.wave.label : '');
    }
    waveSel.addEventListener('change', loadResults);
    inc.addEventListener('change', loadResults);
    loadResults();

    $('[data-preview]', node).addEventListener('click', async () => {
      const r = await api('/s/' + s.id + '/preview-session', { method: 'POST', body: waveSel.value ? { waveId: waveSel.value } : {} });
      if (!r.ok) { setError(r.json.message || 'Could not start a preview.'); return; }
      window.open(r.json.url, '_blank', 'noopener');
      notice('Preview session opened in a new tab. It is excluded from results unless "include previews" is ticked.');
    });

    // Guest invite link — only for surveys whose definition opts in (pilots).
    if (s.guestAccess) {
      const box = $('[data-f="invite"]', node);
      const urlEl = $('[data-invite-url]', node);
      const copyEl = $('[data-invite-copy]', node);
      box.hidden = false;
      $('[data-invite]', node).addEventListener('click', async () => {
        const days = Number($('[data-invite-days]', node).value);
        const r = await api('/s/' + s.id + '/invite', { method: 'POST', body: { days: days } });
        if (!r.ok) { setError(r.json.message || 'Could not create an invite link.'); return; }
        urlEl.value = r.json.url;
        urlEl.hidden = false;
        copyEl.hidden = false;
        $('[data-invite-expires]', node).textContent = 'expires ' + fmtWhen(r.json.expiresAt);
        urlEl.focus(); urlEl.select();
      });
      copyEl.addEventListener('click', () => copyText(urlEl, 'Invite link copied — send it to as many testers as you like.'));
    }
  }

  function renderGrid(node, data) {
    const thead = $('[data-grid-head]', node);
    const tbody = $('[data-grid-body]', node);
    const columns = data.columns || [];
    const rows = data.rows || [];
    thead.replaceChildren();
    tbody.replaceChildren();

    const hr = el('tr');
    for (const h of ['Code', 'Status', 'Started']) hr.appendChild(el('th', null, h));
    for (const c of columns) {
      const th = el('th', 'cellhead');
      th.appendChild(el('span', 'grid__label', c.label));
      if (c.kind === 'starter' && c.text) {
        th.appendChild(el('span', 'grid__q', trunc(c.text, 60)));
        th.title = c.text;
      }
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    for (const row of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', row.participant_code || (row.is_preview ? 'preview' : DASH)));
      const st = el('td');
      st.appendChild(el('span', 'tag tag--' + row.status, row.status));
      tr.appendChild(st);
      tr.appendChild(el('td', 'when', fmtWhen(row.started_at)));
      const cells = row.cells || {};
      for (const c of columns) {
        const cell = cells[c.key];
        const td = el('td', 'cell');
        const box = el('div', 'cell__box');
        if (cell && c.kind === 'probe' && cell.question) box.appendChild(el('div', 'cell__probe', cell.question));
        const answer = cell && cell.answer != null && cell.answer !== '' ? cell.answer : null;
        box.appendChild(el('div', answer == null ? 'muted' : null, answer == null ? DASH : answer));
        td.appendChild(box);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'No responses yet.');
      td.colSpan = 3 + columns.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  /* ── keyholder: identity key, close, destroy ── */
  function setupKeyholder(node, s) {
    const f = (k) => $('[data-f="' + k + '"]', node);
    f('enrollments').textContent = s.enrollments == null ? DASH : s.enrollments;
    $('[data-keyring]', node).href = BASE + '/api/admin/s/' + s.id + '/keyring.csv';

    // Roster: only surveys whose definition sets eligibility.roster (the IRB study; never a created survey).
    if (s.rosterMode && s.rosterMode !== 'none') {
      const wrap = $('[data-roster-wrap]', node);
      const ta = $('[data-roster]', node);
      const countEl = $('[data-roster-count]', node);
      const showCount = (n) => { countEl.textContent = n + ' on the roster · mode ' + s.rosterMode; };
      wrap.hidden = false;
      showCount(s.rosterSize == null ? 0 : s.rosterSize);
      const kh = f('keyholder');
      kh.addEventListener('toggle', async () => {
        if (!kh.open || ta.dataset.loaded) return;
        const r = await api('/s/' + s.id + '/roster');
        if (r.ok) { ta.value = r.json.pids.join('\n'); ta.dataset.loaded = '1'; }
      });
      $('[data-roster-save]', node).addEventListener('click', async () => {
        const pids = ta.value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
        const r = await api('/s/' + s.id + '/roster', { method: 'PUT', body: { pids } });
        if (!r.ok) { setError(r.json.message || 'Roster not saved.'); return; }
        notice('Roster saved: ' + r.json.count + ' PIDs.');
        showCount(r.json.count);
      });
    }

    const closeBtn = $('[data-close]', node);
    const closeNote = $('[data-close-note]', node);
    if (s.status === 'closed') { closeBtn.hidden = true; }
    else if (s.source !== 'db') { closeBtn.hidden = true; closeNote.hidden = false; }
    else {
      let armed = null;
      closeBtn.addEventListener('click', async () => {
        if (!armed) {
          closeBtn.textContent = 'Click again to close';
          armed = setTimeout(() => { armed = null; closeBtn.textContent = 'Close survey'; }, 6000);
          return;
        }
        clearTimeout(armed); armed = null;
        closeBtn.disabled = true;
        const r = await api('/s/' + s.id, { method: 'PATCH', body: { status: 'closed' } });
        closeBtn.disabled = false;
        closeBtn.textContent = 'Close survey';
        if (!r.ok) { setError(r.json.message || 'Could not close the survey.'); return; }
        notice('Survey closed. No new sessions can start.');
        load();
      });
    }

    const zone = $('[data-destroy-zone]', node);
    const zoneNote = $('[data-destroy-note]', node);
    if (s.status !== 'closed') { zone.hidden = true; zoneNote.hidden = false; return; }
    zone.hidden = false; zoneNote.hidden = true;
    $('[data-destroy]', node).addEventListener('click', async () => {
      const confirm = $('[data-destroy-confirm]', node).value.trim();
      if (confirm !== s.id) { setError('Type the survey id exactly (' + s.id + ') to confirm.'); return; }
      const r = await api('/s/' + s.id + '/destroy-key', { method: 'POST', body: { confirm } });
      if (!r.ok) { setError(r.json.message || 'Key not destroyed.'); return; }
      notice('Key destroyed: ' + r.json.enrollments + ' enrollment rows and ' + r.json.rosters + ' roster rows removed.');
      load();
    });
  }

  /* ── new survey ── */
  const dlg = $('[data-new-dialog]');
  const form = $('[data-new-form]', dlg);
  const dlgErr = $('[data-new-error]', dlg);
  const fld = (name) => form.elements.namedItem(name);
  let defaults = null;

  function showDlgErr(m) { dlgErr.hidden = !m; dlgErr.textContent = m || ''; if (m) dlgErr.scrollIntoView({ block: 'nearest' }); }
  function fillDefaults(d) {
    fld('consentMarkdown').value = d.consentMarkdown || '';
    fld('agreeLabel').value = d.agreeLabel || '';
    fld('opening').value = d.opening || '';
    fld('closing').value = d.closing || '';
    fld('systemPrompt').value = d.systemPrompt || '';
    if (d.maxProbes != null) fld('maxProbes').value = String(d.maxProbes);
  }
  async function openNew() {
    setError('');
    showDlgErr('');
    form.reset();
    fld('closesAt').value = isoDatePlus(90);
    if (!defaults) {
      const r = await api('/surveys/defaults');
      if (!r.ok) { setError(r.json.message || 'Could not load the survey defaults.'); return; }
      defaults = r.json;
    }
    fillDefaults(defaults);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    fld('title').focus();
  }
  $('[data-new]').addEventListener('click', openNew);
  $('[data-new-cancel]', dlg).addEventListener('click', () => dlg.close());

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showDlgErr('');
    const title = fld('title').value.trim();
    const questions = fld('questions').value.split(/\r?\n/).map((q) => q.trim()).filter(Boolean);
    if (!title) { showDlgErr('Give the survey a title.'); fld('title').focus(); return; }
    if (!questions.length) { showDlgErr('Enter at least one question, one per line.'); fld('questions').focus(); return; }
    const body = { title, questions, maxProbes: Number(fld('maxProbes').value) };
    for (const name of ['closesAt', 'consentMarkdown', 'agreeLabel', 'opening', 'closing', 'systemPrompt']) {
      const v = fld(name).value.trim();
      if (v) body[name] = v;
    }
    const btn = $('[data-new-submit]', dlg);
    btn.disabled = true;
    const r = await api('/surveys', { method: 'POST', body });
    btn.disabled = false;
    if (!r.ok) { showDlgErr(r.json.message || 'Could not create the survey.'); return; }
    dlg.close();
    notice('Survey created. Participant link: ' + r.json.url, 20000);
    load();
  });

  load().catch((e) => setError('Something went wrong: ' + (e && e.message ? e.message : e)));
})();
