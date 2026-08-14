// Arrow geometry for the bipartite map.
//
// COORDINATE-SPACE DISCIPLINE — read this before touching anything below.
// The deck is scaled to fit the viewport via `transform: scale()` on `.deck`.
// `getBoundingClientRect()` returns POST-transform (viewport) pixels.
// The SVG's `viewBox` is sized to the SVG's own offsetWidth/offsetHeight,
// which are PRE-transform (layout) pixels. Mixing the two produces arrows
// that drift away from their tile endpoints whenever the deck is zoomed.
//
// Fix: every coordinate we compute is in PRE-transform (layout) space, by
// dividing client rects by the current deck scale.
//
// MULTI-SOURCE SKILLS:
// When several active arrows land on the same skill tile, we spread their
// endpoints vertically so each arrow has its own landing y-position. A
// matching "stain" element is rendered inside the skill tile at the same
// y-offset, so the colored arrow visually drips into the tile in its own
// color. A "× N" count badge is added when N >= 2.
(function () {
  const STAIN_SPREAD_PX = 14;   // vertical gap between landing points
  const STAIN_HEIGHT_PX = 6;    // height of each stain element

  function deckScale() {
    const deck = document.querySelector('.deck');
    if (!deck) return 1;
    const t = deck.style.transform || '';
    const m = t.match(/scale\(([0-9.]+)\)/);
    return m ? parseFloat(m[1]) || 1 : 1;
  }

  // Group currently-active arrows by their target skill, sorted by source
  // vertical position so colors map to landing-points top-to-bottom.
  // Returns Map<skillId, Array<pathEl>>.
  function groupActiveBySkill(slideEl) {
    const out = new Map();
    slideEl.querySelectorAll('.bipartite__svg .arrow-path.is-active').forEach(p => {
      const to = p.dataset.to;
      if (!to) return;
      if (!out.has(to)) out.set(to, []);
      out.get(to).push(p);
    });
    out.forEach((arr) => {
      arr.sort((a, b) => {
        const af = slideEl.querySelector(`.bipartite__col--acts [data-id="${a.dataset.from}"]`);
        const bf = slideEl.querySelector(`.bipartite__col--acts [data-id="${b.dataset.from}"]`);
        if (!af || !bf) return 0;
        return af.getBoundingClientRect().top - bf.getBoundingClientRect().top;
      });
    });
    return out;
  }

  // Spread offset for a given path among its skill's active siblings.
  // 1 source: 0. N sources: (i - (N-1)/2) * SPREAD, so they straddle the center.
  function spreadOffset(group, path) {
    const i = group.indexOf(path);
    const n = group.length;
    if (i < 0 || n <= 1) return 0;
    return (i - (n - 1) / 2) * STAIN_SPREAD_PX;
  }

  function layoutArrows(slideEl) {
    if (!slideEl) return;
    const svg = slideEl.querySelector('.bipartite__svg');
    if (!svg) return;
    const paths = svg.querySelectorAll('.arrow-path');

    const w = svg.offsetWidth || svg.clientWidth;
    const h = svg.offsetHeight || svg.clientHeight;
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const s = deckScale() || 1;
    const svgR = svg.getBoundingClientRect();
    const groups = groupActiveBySkill(slideEl);

    paths.forEach(p => {
      const from = p.dataset.from;
      const to = p.dataset.to;
      if (!from || !to) return;
      const a = slideEl.querySelector(`[data-id="${from}"]`);
      const b = slideEl.querySelector(`[data-id="${to}"]`);
      if (!a || !b) return;

      const aR = a.getBoundingClientRect();
      const bR = b.getBoundingClientRect();

      const x1 = (aR.right - svgR.left) / s;
      const y1 = ((aR.top + aR.bottom) / 2 - svgR.top) / s;
      const x2 = (bR.left  - svgR.left) / s;
      // Spread y2 when this path shares its target with siblings.
      const group = (p.classList.contains('is-active') && groups.get(to)) || null;
      const yOff = group ? spreadOffset(group, p) : 0;
      const y2 = ((bR.top + bR.bottom) / 2 - svgR.top) / s + yOff;
      const cx = (x1 + x2) / 2;
      p.setAttribute('d', `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
    });
  }

  function applyArrowSteps(slideEl, step) {
    if (!slideEl) return;
    const svg = slideEl.querySelector('.bipartite__svg');
    if (!svg) return;
    const paths = svg.querySelectorAll('.arrow-path[data-step]');
    const mode = svg.dataset.arrowMode || 'walk';
    paths.forEach(p => {
      const s = parseInt(p.dataset.step, 10);
      if (Number.isNaN(s) || s <= 0) return;
      const active = (mode === 'sticky') ? (s <= step) : (s === step);
      p.classList.toggle('is-active', active);
    });

    const skillsCol = slideEl.querySelector('.bipartite__col--skills');
    if (!skillsCol) return;

    // Clear all skill state — remove activation, --act tint, and any
    // previously-rendered stain/count markers.
    skillsCol.querySelectorAll('.tile, .skill-tile').forEach(t => {
      t.classList.remove('is-skill-active');
      t.style.removeProperty('--act');
      t.querySelectorAll('.skill-tile__stain, .src-count').forEach(n => n.remove());
    });

    // Build the active-skill source map and paint stains + count badge.
    const groups = groupActiveBySkill(slideEl);
    groups.forEach((sources, toId) => {
      const skill = skillsCol.querySelector(`[data-id="${toId}"]`);
      if (!skill) return;
      skill.classList.add('is-skill-active');
      const n = sources.length;

      // --act tint kept for legacy single-source visual cues (icon glow,
      // border): when multi-source, this ends up being the last source's
      // color, which is fine — the stains carry the full breakdown.
      sources.forEach((p) => {
        const src = slideEl.querySelector(`.bipartite__col--acts [data-id="${p.dataset.from}"]`);
        const act = src && src.dataset.act;
        if (act) skill.style.setProperty('--act', `var(--act-${act})`);
      });

      // One colored stain per source, positioned at the matching arrow
      // landing y-offset so the arrow visually continues into the tile.
      sources.forEach((p) => {
        const src = slideEl.querySelector(`.bipartite__col--acts [data-id="${p.dataset.from}"]`);
        const act = src && src.dataset.act;
        if (!act) return;
        const yOff = spreadOffset(sources, p);
        const stain = document.createElement('div');
        stain.className = 'skill-tile__stain';
        stain.dataset.act = act;
        stain.style.top = `calc(50% + ${yOff}px - ${STAIN_HEIGHT_PX / 2}px)`;
        skill.appendChild(stain);
      });

      // × N count badge for any skill with 2+ sources.
      if (n >= 2) {
        const badge = document.createElement('span');
        badge.className = 'src-count';
        badge.textContent = `×${n}`;
        skill.appendChild(badge);
      }
    });
  }

  let rafId = 0;
  let stopAt = 0;
  function animateLayoutFor(durationMs) {
    stopAt = Math.max(stopAt, performance.now() + durationMs);
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      const slideEl = document.querySelector('.slide.is-active');
      if (slideEl) layoutArrows(slideEl);
      if (performance.now() < stopAt) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function refresh() {
    const slideEl = document.querySelector('.slide.is-active');
    if (!slideEl) return;
    // applyArrowSteps must run before layoutArrows so is-active reflects
    // the new step; the geometry pass then spreads endpoints correctly.
    const step = (window.deck && window.deck.state) ? window.deck.state.step : 0;
    applyArrowSteps(slideEl, step);
    layoutArrows(slideEl);
    animateLayoutFor(600);
  }

  window.addEventListener('slides:loaded', refresh);
  window.addEventListener('deck:stepchange', refresh);
  window.addEventListener('resize', refresh);
})();
