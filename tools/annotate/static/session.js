// A whole session's page. Marks the line being spoken and keeps it in view
// inside the transcript (it never scrolls the page), starts the video where
// this person left it, and saves jots on lines without leaving the page.
// player.js drives the video's buttons; deck.js gives buttons their keys.
(function () {
  const root = document.querySelector('[data-session]');
  if (!root) return;
  const video = document.querySelector('[data-player]');
  const list = root.querySelector('[data-lines]');
  const lines = Array.from(list.querySelectorAll('li[data-t]'));
  const starts = lines.map((li) => Number(li.dataset.t));
  const followButton = root.querySelector('[data-follow]');

  // Following: the line spoken is the last one whose start has passed. End
  // times are not to be trusted, so they are not used.
  let follow = true;
  let now = null;
  let expected = null;  // the scrollTop this script last set; any other is the reader's

  function keepInView(li) {
    list.scrollTop = Math.max(0, li.offsetTop - list.clientHeight / 3);
    expected = list.scrollTop;
  }

  function setFollow(on) {
    follow = on;
    if (followButton) followButton.setAttribute('aria-pressed', String(on));
    if (on && now) keepInView(now);
  }

  function mark(ms) {
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= ms) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const li = found < 0 ? null : lines[found];
    if (li === now) return;
    if (now) now.classList.remove('is-now');
    now = li;
    if (!li) return;
    li.classList.add('is-now');
    if (follow) keepInView(li);
  }

  list.addEventListener('scroll', () => {
    if (expected !== null && Math.abs(list.scrollTop - expected) <= 2) return;
    expected = null;
    if (follow) setFollow(false);
  });

  // With no video, telemetry.js says where its timeline was clicked.
  root.addEventListener('session-at', (event) => mark(event.detail));

  if (video) {
    followButton.hidden = false;
    followButton.addEventListener('click', () => setFollow(!follow));

    // Start where the reader left this session, or where a link asked to.
    const key = `annotate-at-${root.dataset.resume}`;
    const params = new URLSearchParams(location.search);
    let start = 0;
    if (params.has('at')) {
      start = Number(params.get('at')) / 1000 || 0;
      params.delete('at');
      try { history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash); } catch (e) { /* not allowed */ }
    } else {
      try { start = Number(localStorage.getItem(key)) || 0; } catch (e) { /* storage blocked */ }
    }
    const jump = () => { if (start) video.currentTime = start; };
    if (video.readyState >= 1) jump(); else video.addEventListener('loadedmetadata', jump, { once: true });
    mark(start * 1000);

    let kept = start;
    const remember = () => {
      kept = video.currentTime;
      try { localStorage.setItem(key, String(Math.floor(kept))); } catch (e) { /* storage blocked */ }
    };
    video.addEventListener('timeupdate', () => {
      mark(video.currentTime * 1000);
      if (Math.abs(video.currentTime - kept) >= 5) remember();
    });
    video.addEventListener('seeked', () => mark(video.currentTime * 1000));
    video.addEventListener('pause', remember);
    window.addEventListener('pagehide', remember);
  }

  // Jots. One editor, moved under the line being jotted on.
  const form = document.querySelector('[data-jot-form]');
  if (!form) return;
  const box = form.querySelector('textarea');
  const error = form.querySelector('[data-jot-error]');
  const jotNow = root.querySelector('[data-jot-now]');
  let editing = null;
  let wasFollowing = true;
  root.querySelectorAll('[data-jot]').forEach((button) => { button.hidden = false; });
  if (jotNow) jotNow.hidden = false;

  const saved = (li) => li.querySelector('[data-jot-saved]');

  function close() {
    if (!editing) return;
    const note = saved(editing);
    if (note) note.hidden = false;
    form.hidden = true;
    editing = null;
    setFollow(wasFollowing);
  }

  function open(li) {
    if (!li || li.dataset.seq === undefined) return;  // a muted line takes no jot
    if (editing === li) { box.focus(); return; }
    close();
    wasFollowing = follow;
    setFollow(false);
    if (video) video.pause();
    editing = li;
    const note = saved(li);
    box.value = note ? note.textContent : '';
    error.textContent = '';
    if (note) note.hidden = true;
    li.appendChild(form);
    form.hidden = false;
    box.focus();
  }

  list.addEventListener('click', (event) => {
    const target = event.target.closest('[data-jot], [data-jot-saved]');
    if (target) open(target.closest('li'));
  });
  if (jotNow) jotNow.addEventListener('click', () => open(now));
  form.querySelector('[data-jot-cancel]').addEventListener('click', close);

  // Before deck.js sees them: Escape closes the editor rather than leaving
  // the page, and Ctrl+Enter saves.
  window.addEventListener('keydown', (event) => {
    if (!editing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && document.activeElement === box) {
      event.preventDefault(); event.stopPropagation(); form.requestSubmit();
    }
  }, true);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const li = editing;
    if (!li) return;
    error.textContent = 'Saving…';
    fetch(root.dataset.jotUrl + li.dataset.seq, { method: 'POST', body: new FormData(form), credentials: 'same-origin' })
      .then((response) => response.json().catch(() => ({ error: `Not saved (${response.status}).` })))
      .then((answer) => {
        if (answer.error) { error.textContent = answer.error; return; }
        let note = saved(li);
        if (answer.body) {
          if (!note) {
            note = document.createElement('p');
            note.className = 'line__note pre';
            note.dataset.jotSaved = '';
            form.before(note);
          }
          note.textContent = answer.body;
        } else if (note) {
          note.remove();
        }
        if (editing === li) close();
      })
      .catch(() => { error.textContent = 'Not saved: no connection.'; });
  });
})();
