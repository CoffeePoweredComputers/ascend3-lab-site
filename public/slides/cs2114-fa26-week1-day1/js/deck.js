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
     ?embed=1 = passive mode (no keyboard — presenter preview iframes). */
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
  function announce() {
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
  loadSlides();
})();
