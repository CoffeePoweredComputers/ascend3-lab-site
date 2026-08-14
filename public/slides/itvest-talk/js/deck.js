// Slide and fragment controller.
// Hash format: #N.K where N = slide index (1-based), K = step within slide (0..maxStep).
(function () {
  const state = { slide: 1, step: 0, slides: [] };

  function indexSlides() {
    const nodes = document.querySelectorAll('.slide');
    state.slides = Array.from(nodes).map((el, i) => {
      el.dataset.idx = String(i + 1);
      const frags = Array.from(el.querySelectorAll('.frag'));
      const stepsSet = new Set();
      frags.forEach(f => {
        const s = parseInt(f.dataset.step || '0', 10);
        if (!Number.isNaN(s) && s > 0) stepsSet.add(s);
      });
      const maxStep = stepsSet.size ? Math.max(...stepsSet) : 0;
      return { el, frags, maxStep };
    });
  }

  function applyState() {
    const idx = Math.max(1, Math.min(state.slide, state.slides.length));
    state.slide = idx;
    const cur = state.slides[idx - 1];
    state.step = Math.max(0, Math.min(state.step, cur.maxStep));

    state.slides.forEach((s, i) => {
      s.el.classList.toggle('is-active', i + 1 === idx);
    });

    cur.frags.forEach(f => {
      const s = parseInt(f.dataset.step || '0', 10);
      f.classList.remove('is-pending', 'is-current', 'is-past');
      if (s > state.step) f.classList.add('is-pending');
      else if (s === state.step) f.classList.add('is-current');
      else f.classList.add('is-past');
    });

    // Update slide number badge
    const numEl = cur.el.querySelector('.slide__number');
    if (numEl && !numEl.dataset.custom) {
      numEl.textContent = `${idx} / ${state.slides.length}`;
    }

    // Sync hash
    const hash = `#${idx}.${state.step}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);

    // Recompute arrows after layout
    window.dispatchEvent(new Event('deck:stepchange'));
  }

  function parseHash() {
    const m = (location.hash || '').match(/^#(\d+)(?:\.(\d+))?$/);
    if (m) {
      state.slide = parseInt(m[1], 10) || 1;
      state.step = parseInt(m[2] || '0', 10);
    }
  }

  function next() {
    const cur = state.slides[state.slide - 1];
    if (state.step < cur.maxStep) state.step++;
    else if (state.slide < state.slides.length) { state.slide++; state.step = 0; }
    applyState();
  }
  function prev() {
    if (state.step > 0) state.step--;
    else if (state.slide > 1) {
      state.slide--;
      state.step = state.slides[state.slide - 1].maxStep;
    }
    applyState();
  }
  function nextSlide() {
    if (state.slide < state.slides.length) { state.slide++; state.step = 0; applyState(); }
  }
  function prevSlide() {
    if (state.slide > 1) { state.slide--; state.step = 0; applyState(); }
  }
  function first() { state.slide = 1; state.step = 0; applyState(); }
  function last() {
    state.slide = state.slides.length;
    state.step = state.slides[state.slide - 1].maxStep;
    applyState();
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      // USB clickers (Logitech / Kensington / etc.) send PageDown / PageUp
      // for forward / back. Treat them like ArrowRight / ArrowLeft so the
      // build steps within a slide play through correctly. Some send Enter.
      case 'ArrowRight': case ' ': case 'n':
      case 'PageDown': case 'Enter':               e.preventDefault(); next(); break;
      case 'ArrowLeft':  case 'p':
      case 'PageUp': case 'Backspace':             e.preventDefault(); prev(); break;
      // Some remotes (and the laser-pointer button on some Logitechs) send
      // "." for blackout. We don't have a blackout; just no-op gracefully.
      case '.': case 'b': case 'B':                e.preventDefault(); break;
      // Whole-slide skips: still available via ArrowDown / ArrowUp on the
      // keyboard for the speaker driving the deck directly.
      case 'ArrowDown':                            e.preventDefault(); nextSlide(); break;
      case 'ArrowUp':                              e.preventDefault(); prevSlide(); break;
      case 'Home':                                 e.preventDefault(); first(); break;
      case 'End':                                  e.preventDefault(); last(); break;
      case 'f': case 'F':                          e.preventDefault(); toggleFullscreen(); break;
    }
  });

  // Mouse-as-clicker fallback — only active in fullscreen so that you can
  // still right-click to inspect during development.
  //  - Left click  → advance one step
  //  - Right click → previous step (suppress the context menu)
  //  - Side buttons (forward/back, mouse buttons 3/4) → next / prev
  document.addEventListener('click', (e) => {
    if (!document.fullscreenElement) return;
    const t = e.target;
    if (t.closest('a, button, input, textarea, [contenteditable]')) return;
    e.preventDefault();
    next();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!document.fullscreenElement) return;
    const t = e.target;
    if (t.closest('a, button, input, textarea, [contenteditable]')) return;
    e.preventDefault();
    prev();
  });
  document.addEventListener('mouseup', (e) => {
    // Mouse buttons: 0=left, 1=middle, 2=right, 3=back (X1), 4=forward (X2).
    // Left/right handled above; back/forward are the side buttons most
    // ergonomic wireless mice have.
    if (e.button === 3) { e.preventDefault(); prev(); }
    else if (e.button === 4) { e.preventDefault(); next(); }
  });

  window.addEventListener('hashchange', () => { parseHash(); applyState(); });

  // Viewport scaling — fit 1920x1080 deck into viewport with explicit centering.
  function fitStage() {
    const deck = document.querySelector('.deck');
    if (!deck) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min(w / 1920, h / 1080);
    const tx = (w - 1920 * scale) / 2;
    const ty = (h - 1080 * scale) / 2;
    deck.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  window.addEventListener('resize', fitStage);
  // Re-fit on font load (text metrics change → layout changes → arrows need recompute)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { fitStage(); window.dispatchEvent(new Event('deck:stepchange')); });
  }
  // Observe body resize as a fallback (headless chromium sometimes resizes after first paint)
  if (window.ResizeObserver) {
    new ResizeObserver(fitStage).observe(document.body);
  }

  // Boot
  window.addEventListener('slides:loaded', () => {
    indexSlides();
    parseHash();
    applyState();
    fitStage();
    // Belt-and-braces: re-fit a few times to catch late layout shifts
    requestAnimationFrame(fitStage);
    setTimeout(fitStage, 100);
    setTimeout(fitStage, 500);
    setTimeout(() => window.dispatchEvent(new Event('deck:stepchange')), 600);
  });

  // Expose for debugging
  window.deck = { next, prev, nextSlide, prevSlide, first, last, state };
})();
