/* Researcher / keyholder page: counts, exports, previews, a sessions browser
 * with a read-only transcript viewer, roster, key. Coded data only. */
(function () {
  'use strict';
  const BASE = document.body.dataset.base || '';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const errorEl = $('[data-error]');
  const noticeEl = $('[data-notice]');

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

  function show(name) { $$('[data-screen]').forEach((s) => (s.hidden = s.dataset.screen !== name)); }
  function setError(m) { errorEl.hidden = !m; errorEl.textContent = m || ''; }
  function notice(m) { noticeEl.hidden = !m; noticeEl.textContent = m || ''; if (m) setTimeout(() => notice(''), 6000); }

  async function api(path, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    o.credentials = 'same-origin';
    o.headers = Object.assign({ 'X-Requested-With': 'fetch', 'X-Survey-Page': location.pathname }, o.headers || {});
    if (o.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const res = await fetch(BASE + (path.startsWith('/llm-status') ? '/api' : '/api/admin') + path, o);
    let json = {};
    try { json = await res.json(); } catch (_) { /* */ }
    return { status: res.status, ok: res.ok, json };
  }

  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }); } catch (_) { return iso; } };
  const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return iso; } };
  const fmtDur = (s) => (s == null ? '—' : s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s');
  const fmtEnded = (m) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · ') || '—';

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

  /* ── surveys ── */
  async function load() {
    setError('');
    const r = await api('/surveys');
    if (r.status === 401) { show('signedout'); $('[data-login-link]').href = r.json.login || BASE + '/auth/login?next=' + encodeURIComponent(location.pathname); return; }
    if (!r.ok) { setError(r.json.message || 'Could not load.'); return; }
    $('[data-topnav]').hidden = false;
    $('[data-pid]').textContent = r.json.pid;
    render(r.json.surveys);
    show('list');
    pollStatus();
    if (!load.timer) load.timer = setInterval(pollStatus, 30000);
  }

  function render(surveys) {
    const host = $('[data-surveys]');
    host.replaceChildren();
    if (!surveys.length) {
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = 'You have no role on any survey. Roles are set in the survey definition file.';
      host.appendChild(p);
      return;
    }
    const tpl = $('[data-survey-card]');
    for (const s of surveys) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const f = (k) => $('[data-f="' + k + '"]', node);
      f('title').textContent = s.title;
      f('id').textContent = s.id;
      f('irb').textContent = s.irbProtocol || '';
      f('status').textContent = s.status;
      f('version').textContent = s.version.slice(0, 12);
      f('model').textContent = s.model;
      f('provider').textContent = s.llmProvider;
      f('probing').textContent = s.probing.protocol + ', ≤' + s.probing.maxProbesPerStarter + ' probes/starter, ≤' + s.probing.maxTurnsPerSession + ' turns';
      f('roles').textContent = [s.roles.researcher && 'researcher', s.roles.keyholder && 'keyholder'].filter(Boolean).join(', ') || 'none';
      f('participants').textContent = s.participants;

      const tbody = f('waves');
      for (const w of s.waves) {
        const tr = document.createElement('tr');
        const st = w.stats || {};
        const cells = [
          w.label + ' (' + w.id + ')', fmtDate(w.opensAt) + ' → ' + fmtDate(w.closesAt), w.starters,
          w.counts.active, w.counts.completed, w.counts.stopped, w.counts.expired, w.counts.previews,
          fmtDur(st.medianDurationS), st.probesPerSession == null ? '—' : st.probesPerSession, fmtEnded(st.endedBy),
        ];
        for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
        tbody.appendChild(tr);
      }

      const research = f('researcher');
      const sessions = f('sessions');
      if (!s.roles.researcher) { research.hidden = true; sessions.hidden = true; }
      else {
        const inc = $('[data-include-preview]', node);
        const setLinks = () => $$('[data-export]', node).forEach((a) => (a.href = BASE + '/api/admin/s/' + s.id + '/export/' + a.dataset.export + (inc.checked ? '?includePreview=1' : '')));
        inc.addEventListener('change', setLinks); setLinks();
        const sel = $('[data-preview-wave]', node);
        for (const w of s.waves) { const o = document.createElement('option'); o.value = w.id; o.textContent = w.label; sel.appendChild(o); }
        $('[data-preview]', node).addEventListener('click', async () => {
          const r = await api('/s/' + s.id + '/preview-session', { method: 'POST', body: { waveId: sel.value } });
          if (!r.ok) { setError(r.json.message || 'Could not start a preview.'); return; }
          window.open(r.json.url, '_blank', 'noopener');
          notice('Preview session opened in a new tab.');
        });
        setupSessions(node, s);
      }

      const kh = f('keyholder');
      if (!s.roles.keyholder) kh.hidden = true;
      else {
        f('enrollments').textContent = s.enrollments;
        f('rosterMode').textContent = s.rosterMode;
        f('rosterSize').textContent = s.rosterSize;
        $('[data-keyring]', node).href = BASE + '/api/admin/s/' + s.id + '/keyring.csv';
        kh.addEventListener('toggle', async () => {
          if (!kh.open) return;
          const ro = await api('/s/' + s.id + '/roster');
          if (ro.ok) $('[data-roster]', node).value = ro.json.pids.join('\n');
          const ev = await api('/s/' + s.id + '/key-events');
          const ul = f('events'); ul.replaceChildren();
          if (ev.ok) for (const e of ev.json.events) { const li = document.createElement('li'); li.textContent = fmtWhen(e.at) + ' — ' + e.event + ' by ' + e.actorPid + (e.rowCount != null ? ' (' + e.rowCount + ' rows)' : ''); ul.appendChild(li); }
          if (ev.ok && !ev.json.events.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No key events yet.'; ul.appendChild(li); }
        });
        $('[data-roster-save]', node).addEventListener('click', async () => {
          const pids = $('[data-roster]', node).value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
          const r = await api('/s/' + s.id + '/roster', { method: 'PUT', body: { pids } });
          if (!r.ok) { setError(r.json.message || 'Roster not saved.'); return; }
          notice('Roster saved: ' + r.json.count + ' PIDs.');
          load();
        });
        $('[data-destroy]', node).addEventListener('click', async () => {
          const confirm = $('[data-destroy-confirm]', node).value.trim();
          if (confirm !== s.id) { setError('Type the survey id exactly (' + s.id + ') to confirm.'); return; }
          const r = await api('/s/' + s.id + '/destroy-key', { method: 'POST', body: { confirm } });
          if (!r.ok) { setError(r.json.message || 'Key not destroyed.'); return; }
          notice('Key destroyed: ' + r.json.enrollments + ' enrollment rows and ' + r.json.rosters + ' roster rows removed.');
          load();
        });
      }
      host.appendChild(node);
    }
  }

  /* ── sessions browser ── */
  function setupSessions(node, s) {
    const waveSel = $('[data-filter="wave"]', node);
    for (const w of s.waves) { const o = document.createElement('option'); o.value = w.id; o.textContent = w.label; waveSel.appendChild(o); }
    const statusSel = $('[data-filter="status"]', node);
    const previewCb = $('[data-filter="preview"]', node);
    const body = $('[data-sessions-body]', node);
    const count = $('[data-sessions-count]', node);
    const label = $('[data-page-label]', node);
    const prev = $('[data-page="prev"]', node);
    const next = $('[data-page="next"]', node);
    let page = 1;

    async function loadPage() {
      const q = new URLSearchParams();
      if (waveSel.value) q.set('wave', waveSel.value);
      if (statusSel.value) q.set('status', statusSel.value);
      if (previewCb.checked) q.set('includePreview', '1');
      q.set('page', String(page));
      const r = await api('/s/' + s.id + '/sessions?' + q.toString());
      if (!r.ok) { setError(r.json.message || 'Could not load sessions.'); return; }
      body.replaceChildren();
      for (const row of r.json.rows) {
        const tr = document.createElement('tr');
        tr.dataset.sid = row.session_id;
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        const cells = [
          [row.participant_code || (row.is_preview ? 'preview' : '—'), 'mono'],
          [row.wave_id],
          [row.status, 'status'],
          [fmtWhen(row.started_at)],
          [fmtDur(row.duration_s)],
          [row.starters_answered],
          [row.probes_asked],
          [fmtEnded(row.ended_by)],
        ];
        for (const [val, kind] of cells) {
          const td = document.createElement('td');
          if (kind === 'status') { const t = document.createElement('span'); t.className = 'tag tag--' + val; t.textContent = val; td.appendChild(t); }
          else { td.textContent = val; if (kind === 'mono') td.className = 'mono'; }
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      if (!r.json.rows.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 8; td.className = 'muted'; td.textContent = 'No sessions match.'; tr.appendChild(td); body.appendChild(tr); }
      const pages = Math.max(1, Math.ceil(r.json.total / r.json.pageSize));
      count.textContent = r.json.total + (r.json.total === 1 ? ' session' : ' sessions');
      label.textContent = 'page ' + r.json.page + ' of ' + pages;
      prev.disabled = r.json.page <= 1;
      next.disabled = r.json.page >= pages;
    }
    [waveSel, statusSel, previewCb].forEach((el) => el.addEventListener('change', () => { page = 1; loadPage(); }));
    prev.addEventListener('click', () => { if (page > 1) { page--; loadPage(); } });
    next.addEventListener('click', () => { page++; loadPage(); });
    const open = (tr) => { if (tr && tr.dataset.sid) openTranscript(s, tr.dataset.sid); };
    body.addEventListener('click', (ev) => open(ev.target.closest('tr')));
    body.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev.target.closest('tr')); } });
    loadPage();
  }

  /* ── transcript viewer ── */
  const dlg = $('[data-transcript-dialog]');
  const tBody = $('[data-t-body]', dlg);
  const tDetails = $('[data-t-details]', dlg);
  let current = null; // { survey, detail }

  $('[data-t-close]', dlg).addEventListener('click', () => dlg.close());
  tDetails.addEventListener('change', () => { if (current) renderTranscript(current.survey, current.detail); });

  async function openTranscript(s, sid) {
    setError('');
    const r = await api('/s/' + s.id + '/sessions/' + encodeURIComponent(sid));
    if (!r.ok) { setError(r.json.message || 'Could not load the transcript.'); return; }
    current = { survey: s, detail: r.json };
    renderTranscript(s, r.json);
    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

  function msg(kind, text, caption, extraClass) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--' + kind + (extraClass ? ' ' + extraClass : '');
    if (caption) { const cap = document.createElement('span'); cap.className = 'msg__cap'; cap.textContent = caption; wrap.appendChild(cap); }
    const bubble = document.createElement('div'); bubble.className = 'msg__bubble'; bubble.textContent = text == null ? '' : text;
    wrap.appendChild(bubble);
    return wrap;
  }
  function meta(wrap, text) { const m = document.createElement('div'); m.className = 'msg__meta'; m.textContent = text; wrap.appendChild(m); }
  function divider(text, isError) { const d = document.createElement('div'); d.className = 'divider' + (isError ? ' divider--error' : ''); d.textContent = text; return d; }

  function renderTranscript(s, d) {
    const ses = d.session;
    $('[data-t-eyebrow]', dlg).textContent = (ses.is_preview ? 'Preview session' : 'Session') + ' · ' + s.title;
    $('[data-t-title]', dlg).textContent = (ses.participant_code || 'preview') + ' · ' + ses.wave_id + ' · ' + ses.status;
    $('[data-t-meta]', dlg).textContent = 'started ' + fmtWhen(ses.started_at) + (ses.ended_at ? ' · ended ' + fmtWhen(ses.ended_at) : '') + ' · model ' + ses.model + ' · config ' + ses.config_version.slice(0, 12);
    $('[data-t-download]', dlg).href = BASE + '/api/admin/s/' + s.id + '/sessions/' + ses.session_id + '?download=1';
    const details = tDetails.checked;
    tBody.replaceChildren();
    for (const t of d.turns) {
      if (t.kind === 'starter') tBody.appendChild(msg('q', t.text, 'Question ' + (t.starter_index + 1) + (t.starter_id ? ' · ' + t.starter_id : ''), 'msg--starter'));
      else if (t.kind === 'probe') {
        const w = msg('q', t.text, 'Follow-up ' + t.probe_index, 'msg--probe');
        if (details) {
          const bits = [t.probe_type || 'UNLABELLED'];
          if (t.trigger) bits.push('trigger: ' + t.trigger);
          if (t.llm_latency_ms != null) bits.push((t.llm_latency_ms / 1000).toFixed(1) + ' s');
          if (t.llm_completion_tokens != null) bits.push(t.llm_completion_tokens + ' tok');
          const flags = Object.keys(t.flags || {});
          if (flags.length) bits.push('flags: ' + flags.join(', '));
          meta(w, bits.join(' · '));
        }
        tBody.appendChild(w);
      } else if (t.kind === 'answer') tBody.appendChild(msg('you', t.text, null));
      else if (t.kind === 'advance') {
        const bad = t.trigger === 'llm_error' || t.trigger === 'parse_error';
        let text = 'ended: ' + (t.trigger || '?');
        if (details && bad && t.llm_error) text += ' — ' + t.llm_error.slice(0, 120);
        else if (details && t.llm_latency_ms != null) text += ' · ' + (t.llm_latency_ms / 1000).toFixed(1) + ' s';
        tBody.appendChild(divider(text, bad));
      } else if (t.kind === 'stop') tBody.appendChild(divider('stopped by participant', false));
    }
    if (!d.turns.length) tBody.appendChild(divider('no turns recorded', false));
  }

  load().catch((e) => setError('Something went wrong: ' + (e && e.message ? e.message : e)));
})();
