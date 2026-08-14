// Tiny confetti burst when a ladder rung is revealed by stepping forward.
// Listens to the existing deck step system (deck:stepchange + .is-current on
// .frag) so it rides the same forward/back navigation rather than adding any
// parallel step tracking. Particles are appended inside the rung, so the deck's
// CSS scale transform applies to them automatically (author in layout pixels).
(function () {
  const reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  const COLORS = ['var(--accent-1)', 'var(--accent-2)', 'var(--accent-3)', '#ffd166', '#ef476f'];
  const COUNT = 16;

  // One-time keyframe + base particle style.
  const style = document.createElement('style');
  style.textContent = `
    .confetti-piece {
      position: absolute; top: 50%; left: 50%;
      width: 10px; height: 14px; border-radius: 2px;
      pointer-events: none; z-index: 50; will-change: transform, opacity;
      animation: confetti-pop 900ms cubic-bezier(.2,.7,.3,1) forwards;
    }
    @keyframes confetti-pop {
      0%   { transform: translate(-50%,-50%) rotate(0deg); opacity: 1; }
      100% { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) rotate(var(--rot)); opacity: 0; }
    }`;
  document.head.appendChild(style);

  function burst(el) {
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.style.position = 'relative';
    for (let i = 0; i < COUNT; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      // index-derived spread (no Math.random needed; deterministic + lively)
      const angle = (i / COUNT) * Math.PI * 2;
      const dist = 60 + (i % 5) * 22;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 40; // bias upward so it "pops off"
      p.style.setProperty('--dx', dx.toFixed(0) + 'px');
      p.style.setProperty('--dy', dy.toFixed(0) + 'px');
      p.style.setProperty('--rot', (angle * 120).toFixed(0) + 'deg');
      p.style.background = COLORS[i % COLORS.length];
      p.addEventListener('animationend', () => p.remove());
      el.appendChild(p);
    }
  }

  let lastSlide = 0, lastStep = -1;
  window.addEventListener('deck:stepchange', () => {
    const st = window.deck && window.deck.state;
    if (!st) return;
    const forward = st.slide > lastSlide || (st.slide === lastSlide && st.step > lastStep);
    const advancedSlide = lastSlide;
    lastSlide = st.slide; lastStep = st.step;
    if (!forward) return;
    const active = document.querySelector('.slide.is-active');
    if (!active) return;
    // Pop from any ladder rung that just became current.
    active.querySelectorAll('.ladder .rung.is-current').forEach(burst);
  });
})();
