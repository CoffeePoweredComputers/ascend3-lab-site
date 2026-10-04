// The study app's record beside a session's video. Places the timeline's
// marks, moves its playhead with the video, seeks where it is clicked, and
// shows the specification as it stood. A state is asked of the server only
// when playback leaves the stretch the last one holds for. With no video, a
// click on the timeline moves the playhead, the panel and the transcript.
(function () {
  const strip = document.querySelector('[data-timeline]');
  if (!strip) return;
  const root = document.querySelector('[data-session]');
  const video = document.querySelector('[data-player]');
  const duration = Number(strip.dataset.duration) || 1;
  const tracks = strip.querySelector('[data-tracks]');
  const head = strip.querySelector('[data-playhead]');
  const pct = (ms) => `${Math.min(100, Math.max(0, (ms / duration) * 100))}%`;

  strip.querySelectorAll('[data-at]').forEach((el) => {
    el.style.left = pct(Number(el.dataset.at));
    if (el.dataset.to !== undefined) el.style.width = pct(Number(el.dataset.to) - Number(el.dataset.at));
  });

  function clock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  // The specification panel.
  const panel = document.querySelector('[data-spec]');
  const body = panel.querySelector('[data-spec-body]');
  const saved = panel.querySelector('[data-spec-saved]');
  const sinceButton = panel.querySelector('[data-spec-since]');
  let since = 'save';
  let now = 0;
  let held = null;  // {from, until, since} of the state on screen
  let asking = false;
  let again = false;

  if (window.matchMedia('(max-width: 1199px)').matches) panel.open = false;  // stacked: the video and transcript first

  function draw(state) {
    body.replaceChildren();
    if (state.hidden) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Not in the data.';
      body.append(p);
      saved.textContent = '';
      return;
    }
    state.fields.forEach((f) => {
      const h = document.createElement('h3');
      h.textContent = f.name;
      const list = document.createElement('ol');
      list.className = 'spec__lines';
      if (!f.lines.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = '—';
        list.append(li);
      }
      f.lines.forEach(([mark, text]) => {
        const li = document.createElement('li');
        if (mark) li.className = `is-${mark}`;
        li.textContent = text || ' ';
        list.append(li);
      });
      body.append(h, list);
    });
    saved.textContent = state.saved === null ? 'Nothing saved yet' : `Saved ${clock(Math.max(0, state.saved))}`;
  }

  function fill() {
    if (!panel.open) return;
    if (held && held.since === since && (held.from === null || now >= held.from) && (held.until === null || now < held.until)) return;
    if (asking) { again = true; return; }
    asking = true;
    const asked = { at: now, since };
    fetch(`${panel.dataset.stateUrl}?at=${Math.round(asked.at)}&since=${asked.since}`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((state) => { held = { from: state.from, until: state.until, since: asked.since }; draw(state); })
      .catch(() => {
        saved.textContent = 'Not loaded.';
        held = { from: asked.at, until: asked.at + 5000, since: asked.since };  // try again a little later, not on every tick
      })
      .finally(() => {
        asking = false;
        if (again) { again = false; fill(); }
      });
  }

  function show(ms) {
    now = ms;
    head.style.left = pct(ms);
    fill();
  }

  panel.addEventListener('toggle', () => { held = null; fill(); });
  sinceButton.addEventListener('click', () => {
    const on = sinceButton.getAttribute('aria-pressed') !== 'true';
    sinceButton.setAttribute('aria-pressed', String(on));
    since = on ? 'scenario' : 'save';
    fill();
  });

  tracks.addEventListener('click', (event) => {
    const box = tracks.getBoundingClientRect();
    const ms = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration;
    if (video) {
      video.currentTime = ms / 1000;
    } else {
      show(ms);
      root.dispatchEvent(new CustomEvent('session-at', { detail: ms }));
    }
  });

  if (video) {
    const follow = () => show(video.currentTime * 1000);
    video.addEventListener('timeupdate', follow);
    video.addEventListener('seeked', follow);
    video.addEventListener('loadedmetadata', follow);
  }
  show(video ? video.currentTime * 1000 : 0);
})();
