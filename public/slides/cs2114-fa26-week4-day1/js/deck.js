/* Deck runtime — zero-dependency fixed-canvas slide engine.
   Loads every window.SLIDE_MANIFEST entry into .deck (children stay aligned
   with manifest order), scales the fixed canvas to the viewport, and drives
   hash navigation (#N and #N.K) plus the .frag[data-step] step engine.

   API contract (Slide Studio relies on every point):
   - window.deck.state = { slide, step, slides: [{ maxStep }] }   (slide is 1-based)
   - "slides:loaded" fires on window once after all sections are in; receiving
     it back (the studio swaps slide DOM in place) re-indexes and re-applies.
   - "deck:stepchange" fires on window on every move, with detail
     { slide, step, prevHash, nextHash, slideCount, stepCount }.
   - keys: arrows / space / PageUp / PageDown navigate, F = fullscreen;
     ?embed=1 = passive mode (no keyboard — presenter preview iframes).
   - accessibility: each slide may carry ONE
     <p class="sr-only slide__desc"> — the long description of what the slide
     shows and how it builds, read in place by a screen reader and wired as
     aria-describedby onto every role="img" figure in that slide. Authored per
     slide (Slide Studio's Describe tab writes them); the runtime never
     generates text. A polite live region additionally reports what MOVED
     ("Slide 3 of 17: …", the newly revealed text, or "Step 2 of 5."), which is
     a status message — never the content. Off in embed mode.
   - motion: `m` (or the focus-revealed "Pause background motion" button)
     toggles .no-motion on <html>, which stops every animation and transition
     in the deck — the WCAG 2.2.2 mechanism for ambient loops. Remembered per
     browser; the OS reduced-motion preference is honoured separately in CSS. */
(function () {
  'use strict';

  const root = document.querySelector('.deck');
  if (!root) return;
  const EMBED = /[?&]embed=1(?:&|$)/.test(location.search);

  const state = { slide: 1, step: 0, slides: [] };
  window.deck = { state, next, prev, go };

  // ---------------------------------------------------------------- fit
  // Scale the fixed canvas to the viewport via transform (never resize it).
  // The studio overlay re-asserts its own middle-column fit over this one.
  function fit() {
    const w = root.offsetWidth || 1920, h = root.offsetHeight || 1080;
    const s = Math.min(window.innerWidth / w, window.innerHeight / h) || 1;
    const tx = (window.innerWidth - w * s) / 2, ty = (window.innerHeight - h * s) / 2;
    root.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);

  // ---------------------------------------------------------------- state
  const maxStepOf = (n) => (state.slides[n - 1] || { maxStep: 0 }).maxStep;
  const hashFor = (slide, step) => (step > 0 ? '#' + slide + '.' + step : '#' + slide);

  // Per-slide maxStep = highest data-step in the section (steps are authored
  // dense from 1). Also fills empty .slide__number placeholders.
  function reindex() {
    const total = root.children.length;
    state.slides = [...root.children].map((sec, i) => {
      let max = 0;
      sec.querySelectorAll('[data-step]').forEach((e) => {
        const n = parseInt(e.getAttribute('data-step'), 10);
        if (!isNaN(n) && n > max) max = n;
      });
      const num = sec.querySelector('.slide__number');
      if (num && !num.textContent.trim()) num.textContent = (i + 1) + ' / ' + total;
      return { maxStep: max };
    });
    wireDescriptions();
  }

  // Parse location.hash into state (clamped) and apply it to the DOM.
  function readHash() {
    const m = (location.hash || '').match(/^#(\d+)(?:\.(\d+))?/);
    const count = Math.max(1, state.slides.length);
    state.slide = Math.min(Math.max(m ? parseInt(m[1], 10) || 1 : 1, 1), count);
    const raw = m && m[2] != null ? parseInt(m[2], 10) || 0 : 0;
    state.step = Math.min(Math.max(raw, 0), maxStepOf(state.slide));
    apply();
  }

  // Activate the current slide; classify its .frag elements against the step
  // (same semantics as the studio's previews: v>k pending, v==k current, else past).
  function apply() {
    const secs = root.children;
    for (let i = 0; i < secs.length; i++) secs[i].classList.toggle('is-active', i === state.slide - 1);
    const active = secs[state.slide - 1];
    if (!active) return;
    active.querySelectorAll('.frag').forEach((f) => {
      const v = parseInt(f.getAttribute('data-step') || '0', 10) || 0;
      f.classList.remove('is-pending', 'is-current', 'is-past');
      f.classList.add(v > state.step ? 'is-pending' : v === state.step ? 'is-current' : 'is-past');
    });
  }

  // ---------------------------------------------------------------- moves
  // prev/next hashes are computed here because only the runtime knows step
  // counts (the presenter view depends on them). null = no further move.
  function nextHash() {
    if (state.step < maxStepOf(state.slide)) return hashFor(state.slide, state.step + 1);
    if (state.slide < state.slides.length) return hashFor(state.slide + 1, 0);
    return null;
  }
  function prevHash() {
    if (state.step > 0) return hashFor(state.slide, state.step - 1);
    if (state.slide > 1) return hashFor(state.slide - 1, maxStepOf(state.slide - 1));
    return null;
  }
  // ---------------------------------------------------------------- a11y
  // Long descriptions. A slide's .slide__desc is its WCAG 1.1.1 text
  // alternative: it sits in the page right after the heading, so a screen
  // reader's reading cursor finds it and can re-read it — unlike a live-region
  // announcement, which is spoken once and gone. The runtime only wires it up,
  // pointing every role="img" figure in the slide at it via aria-describedby
  // (the figure keeps its own short aria-label as its NAME). Idempotent: it
  // runs on every reindex, and skips figures that already have a description.
  function wireDescriptions() {
    [...root.children].forEach((sec, i) => {
      const d = sec.querySelector('.slide__desc');
      if (!d) return;
      if (!d.id) d.id = 'desc-' + (sec.id || 'slide-' + (i + 1));
      sec.querySelectorAll('[role="img"]:not([aria-describedby])')
        .forEach((fig) => fig.setAttribute('aria-describedby', d.id));
    });
  }

  // Status messages (WCAG 4.1.3). Stepping a deck is silent to a screen
  // reader: the DOM changes but focus does not move. This polite, atomic
  // region says what MOVED — the slide you landed on, or the text that just
  // appeared, or a bare step count when the step is purely visual. It is
  // deliberately not the content (that is .slide__desc, above): an
  // announcement no one can re-read is the wrong place for anything a student
  // has to study. Muted in embed mode — presenter preview iframes must never
  // speak — and debounced, so holding the arrow key does not queue 20 lines.
  let live = null, spoken = { slide: -1, step: -1 }, speakTimer = 0;
  function liveRegion() {
    if (live) return live;
    live = document.createElement('div');
    live.className = 'sr-only deck__live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    document.body.appendChild(live);
    return live;
  }
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  function status() {
    if (EMBED) return;
    if (spoken.slide === state.slide && spoken.step === state.step) return;   // studio re-announce
    const sec = root.children[state.slide - 1];
    if (!sec) return;
    let msg;
    if (spoken.slide !== state.slide) {
      const head = sec.querySelector('h1, h2, h3');
      msg = 'Slide ' + state.slide + ' of ' + state.slides.length +
        (head ? ': ' + clean(head.textContent) : '') + '.';
    } else {
      // outermost fragments only — a nested .frag's text is already in its parent's
      const fresh = [...sec.querySelectorAll('.frag.is-current')]
        .filter((f) => f.parentElement.closest('.frag.is-current') === null);
      msg = clean(fresh.map((f) => f.textContent).join(' ')) ||
        ('Step ' + state.step + ' of ' + maxStepOf(state.slide) + '.');
    }
    spoken = { slide: state.slide, step: state.step };
    const region = liveRegion();
    clearTimeout(speakTimer);
    region.textContent = '';                       // clear first so a repeat re-announces
    speakTimer = setTimeout(() => { region.textContent = msg; }, 60);
  }

  // Motion toggle (WCAG 2.2.2). Ambient background loops — drifting mist,
  // breathing gradients — start automatically and run longer than five
  // seconds, so a deck that has any needs a way to stop them. `m` toggles
  // .no-motion on <html> (CSS kills all animation and transition under it) and
  // the choice is remembered. The control is a real button rather than a
  // key-only affordance, revealed on keyboard focus like a skip link, so it is
  // discoverable without putting a widget on a designed slide. The OS
  // reduced-motion preference is handled separately, in CSS, and is not a
  // substitute: it is not a mechanism the page provides.
  const MOTION_KEY = 'deck:no-motion';
  let motionBtn = null;
  function setMotion(off, persist) {
    document.documentElement.classList.toggle('no-motion', off);
    if (motionBtn) {
      motionBtn.textContent = off ? 'Resume background motion' : 'Pause background motion';
      motionBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
    }
    if (persist) { try { localStorage.setItem(MOTION_KEY, off ? '1' : '0'); } catch (e) { /* private mode */ } }
  }
  const motionOff = () => document.documentElement.classList.contains('no-motion');
  function initMotion() {
    let stored = null;
    try { stored = localStorage.getItem(MOTION_KEY); } catch (e) { /* private mode */ }
    if (EMBED) return setMotion(stored === '1', false);      // no control in preview iframes
    motionBtn = document.createElement('button');
    motionBtn.type = 'button';
    motionBtn.className = 'deck__motion';
    motionBtn.addEventListener('click', () => setMotion(!motionOff(), true));
    document.body.insertBefore(motionBtn, document.body.firstChild);   // first in tab order
    setMotion(stored === '1', false);
  }

  function announce() {
    status();
    window.dispatchEvent(new CustomEvent('deck:stepchange', {
      detail: {
        slide: state.slide,
        step: state.step,
        prevHash: prevHash(),
        nextHash: nextHash(),
        slideCount: state.slides.length,
        stepCount: maxStepOf(state.slide),
      },
    }));
  }

  function go(slide, step) {
    const target = hashFor(slide, step || 0);
    if (location.hash === target) { readHash(); announce(); return; }
    location.hash = target;                        // hashchange applies + announces
  }
  function next() { const h = nextHash(); if (h) location.hash = h; }
  function prev() { const h = prevHash(); if (h) location.hash = h; }

  window.addEventListener('hashchange', () => { readHash(); announce(); });

  // ---------------------------------------------------------------- keys
  if (!EMBED) {
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); prev(); }
      else if (e.key === 'Home') { e.preventDefault(); go(1, 0); }
      else if (e.key === 'End') { e.preventDefault(); go(state.slides.length || 1, maxStepOf(state.slides.length)); }
      else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); setMotion(!motionOff(), true); }
      else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      }
    });
  }

  // ---------------------------------------------------------------- loader
  // <script> tags arriving via innerHTML/importNode are inert; re-create them
  // so slide-local scripts run (the step-animation authoring flow relies on it).
  function activateScripts(scope) {
    scope.querySelectorAll('script').forEach((old) => {
      const s = document.createElement('script');
      for (const a of old.attributes) s.setAttribute(a.name, a.value);
      s.textContent = old.textContent;
      old.replaceWith(s);
    });
  }

  let selfEvent = false;
  function loadSlides() {
    const manifest = window.SLIDE_MANIFEST || [];
    Promise.all(manifest.map((f) =>
      fetch('slides/' + f)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .catch(() => '<section class="slide"><h2>Missing slide: ' + f + '</h2></section>')
    )).then((htmls) => {
      for (const html of htmls) {                  // one <section> per entry, in order
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let sec = doc.querySelector('section');
        if (!sec) {                                // tolerate fragments without a <section> root
          sec = doc.createElement('section');
          sec.className = 'slide';
          while (doc.body.firstChild) sec.appendChild(doc.body.firstChild);
        }
        const node = document.importNode(sec, true);
        root.appendChild(node);
        activateScripts(node);
      }
      reindex();
      readHash();
      fit();
      selfEvent = true;
      window.dispatchEvent(new Event('slides:loaded'));   // dispatched exactly once
      selfEvent = false;
      announce();
    });
  }

  // The studio dispatches slides:loaded after swapping a slide's DOM in place —
  // re-index step counts and re-apply the current position.
  window.addEventListener('slides:loaded', () => {
    if (selfEvent) return;
    reindex();
    readHash();
    announce();
  });

  fit();
  initMotion();
  loadSlides();
})();
