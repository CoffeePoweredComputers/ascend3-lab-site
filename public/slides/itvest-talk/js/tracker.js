/* Section tracker — the metro-line take (v2). v1 was a gray label strip;
   this draws the talk as a ROUTE in the deck's own iconography: the road
   ahead is a dotted line ending in the pipeline arrowhead (both straight off
   23a-india-route / the svg-defs), the stretch already traveled is solid in
   the title gradient, section stops are beads in the India-map pin recipe,
   and the current slide is a breathing accent marker. Names sit above the
   line in mono caps; the current section's is lit and slightly larger.

   Membership is DERIVED from the manifest in index.html. Each section is
   named by the slide that OPENS it; every slide from there up to the next
   opener belongs to it. So adding a slide to the manifest gives it a tick
   automatically — the manifest stays the single source of deck order.
   Only touch SECTION_STARTS when a slide begins a genuinely new section.

   Geometry is computed in absolute px: the stage is a fixed 1920-wide canvas
   (scaled as a unit), so SVG coordinates are exact and nothing can reflow. */
(function () {
  'use strict';

  // section name → the manifest stem (filename without .html) that opens it.
  // Every slide after the cover belongs to a section: the band runs the whole
  // talk. Only the cover sits outside (it carries the boot preview instead).
  const SECTION_STARTS = [
    ['Intro',          '02-about-lab'],
    ['New Skills',     '03-what-we-assess'],
    ['Question types', '05c-cgbg-animation'],
    ['The turn',       '13b-act3'],
    ['Languages',      '19c-transprogramming'],
    ['Drawings',       '11b-visual-prompting-A'],
    ['Platform',       '09c-non-cgbg'],
    ['Close',          '24-research-questions-18'],
  ];

  // Escape hatch for slides that should carry no band at all. Empty since
  // 2026-08-14 — the band now runs through the close.
  const NO_BAND = [];

  const NS = 'http://www.w3.org/2000/svg';
  const W = 1920, H = 60;
  const L = 96, R = W - 96;        // rails match the slides' side padding
  const LINE_Y = 40, NAME_Y = 24;
  const GAP_W = 1.5;               // inter-section air, in slide-widths — keeps
                                   // short sections' names off their neighbors

  // Walk the manifest once, slotting each stem under the section it falls in.
  // Returns [[name, [stem, ...]], ...] in deck order.
  function buildSections(stems) {
    const opens = new Map(SECTION_STARTS.map(function (s) { return [s[1], s[0]]; }));
    const sections = [];
    let current = null;
    for (const stem of stems) {
      if (opens.has(stem)) {
        current = [opens.get(stem), []];
        sections.push(current);
      }
      if (current && NO_BAND.indexOf(stem) === -1) current[1].push(stem);
    }
    return sections;
  }

  function el(name, attrs, cls) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (cls) n.setAttribute('class', cls);
    return n;
  }

  function buildTrack(sections, stem, uid) {
    // Front matter carries a PREVIEW of the whole route — every stop future,
    // no traveled trail, no now-marker. The cover's variant ('__boot__') also
    // wraps each slide tick with a spinner so 01-title.html can animate the
    // dots "loading" one by one; later front matter ('__preview__') shows the
    // same route statically.
    const boot = stem === '__boot__';
    const preview = boot || stem === '__preview__';
    let curSec = -1, curTick = -1;
    sections.forEach(function (s, i) {
      const j = s[1].indexOf(stem);
      if (j >= 0) { curSec = i; curTick = j; }
    });
    if (curSec < 0 && !preview) return null;   // back matter gets no band

    const weights = sections.map(function (s) { return s[1].length + GAP_W; });
    const px = (R - L) / weights.reduce(function (a, b) { return a + b; }, 0);

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' },
      'sec-track' + (boot ? ' sec-track--boot' : ''));

    // The fill's gradient must be userSpaceOnUse: a horizontal <line> has a
    // zero-height bounding box, and objectBoundingBox gradients (like the
    // global #grad-accent) legally render as NOTHING on it. Spanning the full
    // track also means the traveled stretch reveals the gradient
    // progressively — indigo early in the talk, pink by the end. One gradient
    // per band, unique id, since every slide carries its own copy.
    const gradId = 'tr-grad-' + uid;
    const defs = el('defs', {});
    const grad = el('linearGradient',
      { id: gradId, gradientUnits: 'userSpaceOnUse', x1: L, y1: 0, x2: R, y2: 0 });
    grad.appendChild(el('stop', { offset: '0%', 'stop-color': '#6366f1' }));
    grad.appendChild(el('stop', { offset: '100%', 'stop-color': '#ec4899' }));
    defs.appendChild(grad);

    // the track's own arrowhead: half the global #arrowhead's size and gray,
    // so the road ends quietly instead of in the accent gradient
    const arrowId = 'tr-arrow-' + uid;
    const marker = el('marker', {
      id: arrowId, viewBox: '0 0 10 10',
      markerWidth: 5, markerHeight: 5, refX: 8, refY: 5, orient: 'auto'
    });
    marker.appendChild(el('path', { d: 'M0,0 L8,5 L0,10 z' }, 'tr-arrow'));
    defs.appendChild(marker);
    svg.appendChild(defs);

    // the road ahead: dotted, ending in the small gray arrowhead
    svg.appendChild(el('line',
      { x1: L, y1: LINE_Y, x2: R, y2: LINE_Y, 'marker-end': 'url(#' + arrowId + ')' }, 'tr-base'));

    // geometry pass: stop/tick/name positions, and where "now" is
    let x = L, curX = L;
    const ticks = [], stops = [], names = [];
    sections.forEach(function (sec, i) {
      const name = sec[0], stems = sec[1];
      const state = i < curSec ? 'is-past' : i === curSec ? 'is-here' : 'is-future';
      const t = el('text', { x: x, y: NAME_Y }, 'tr-name ' + state);
      t.textContent = name.toUpperCase();
      const stop = el('circle', { cx: x, cy: LINE_Y, r: 6.5 }, 'tr-stop ' + state);
      if (boot) {
        // --tt = how far along the line this element sits (0..1). The title
        // slide's CSS turns it into an animation delay, so everything fires
        // exactly as the growing breadcrumb trail passes it (01-title.html).
        const tt = ((x - L) / (R - L)).toFixed(4);
        t.style.setProperty('--tt', tt);
        stop.style.setProperty('--tt', tt);
      }
      names.push(t);
      stops.push(stop);
      stems.forEach(function (s2, j) {
        const tx = x + (j + 0.5) * px;
        if (i === curSec && j === curTick) curX = tx;
        else if (i > curSec || (i === curSec && j > curTick)) {
          if (boot) {
            // each slide dot "loads": a spinner arc while the trail runs on,
            // then a ring burst + the tick popping in when it resolves
            const g = el('g', { transform: 'translate(' + tx + ' ' + LINE_Y + ')' }, 'tr-boot');
            g.style.setProperty('--tt', ((tx - L) / (R - L)).toFixed(4));
            g.appendChild(el('circle', { r: 9 }, 'tr-boot-burst'));
            g.appendChild(el('circle', { r: 9 }, 'tr-boot-spin'));
            g.appendChild(el('circle', { r: 4.5 }, 'tr-tick'));
            ticks.push(g);
          } else {
            ticks.push(el('circle', { cx: tx, cy: LINE_Y, r: 4.5 }, 'tr-tick'));
          }
        }
        // passed ticks vanish under the fill line — the trail absorbs them
      });
      x += (stems.length + GAP_W) * px;
    });

    // the traveled stretch: solid gradient over the dotted base. Previews
    // have no history — no trail, no now-marker.
    if (!preview) {
      svg.appendChild(el('line',
        { x1: L, y1: LINE_Y, x2: curX, y2: LINE_Y, stroke: 'url(#' + gradId + ')' }, 'tr-fill'));
    }

    ticks.forEach(function (n) { svg.appendChild(n); });
    stops.forEach(function (n) { svg.appendChild(n); });
    names.forEach(function (n) { svg.appendChild(n); });

    if (!preview) {
      const now = el('g', { transform: 'translate(' + curX + ' ' + LINE_Y + ')' }, 'tr-now');
      now.appendChild(el('circle', { r: 9 }, 'tr-now-halo'));
      now.appendChild(el('circle', { r: 5 }, 'tr-now-core'));
      svg.appendChild(now);
    }

    // The VERY LAST slide: the trail takes off. A banner of gradient strands
    // sweeps from the final slide's own "now" dot (curX), through the arrow,
    // and off the canvas, sparkles in the takeoff zone. Each strand's three
    // sway phases are generated here and handed to deck.css as --r0/--r1/--r2;
    // the shared tr-strand-sway keyframes swap between them per element.
    const lastSec = sections.length - 1;
    const isFinal = !preview && curSec === lastSec &&
      curTick === sections[lastSec][1].length - 1;
    if (isFinal) {
      const gId = 'tr-fly-grad-' + uid;
      const fly = el('linearGradient',
        { id: gId, gradientUnits: 'userSpaceOnUse', x1: curX, y1: 0, x2: 1930, y2: 0 });
      fly.appendChild(el('stop', { offset: '0%', 'stop-color': '#ec4899' }));
      fly.appendChild(el('stop', { offset: '55%', 'stop-color': '#a78bfa' }));
      fly.appendChild(el('stop', { offset: '100%', 'stop-color': '#6366f1', 'stop-opacity': 0 }));
      defs.appendChild(fly);

      // strand centerline: dead straight on the line from the now-dot to the
      // arrow (bundled, covering the dotted base), THEN fanning out — dy is
      // the strand's spread at exit (up and down); k = sway phase (0..2)
      // wobbles only the fanned tail so the bundle never leaves the line.
      const strand = function (dy, k) {
        const wB = [0, -6, 5][k], wC = [0, 5, -7][k];
        const p2y = 40 + dy * 0.45 + wB;
        const p3y = 40 + dy + wC;
        return 'M ' + curX + ' 40' +
          ' C ' + (curX + 50) + ' 40, 1801 40, 1826 40' +
          ' S 1866 ' + p2y + ', 1878 ' + p2y +
          ' S 1916 ' + p3y + ', 1930 ' + p3y;
      };
      [[4.5, 0.95, 14], [3.4, 0.8, -18], [2.8, 0.7, 46], [2.2, 0.55, -50]].forEach(function (cfg, si) {
        const p = el('path', {
          d: strand(cfg[2], 0), pathLength: 1,
          stroke: 'url(#' + gId + ')', 'stroke-width': cfg[0], opacity: cfg[1]
        }, 'tr-strand');
        p.style.setProperty('--r0', 'path("' + strand(cfg[2], 0) + '")');
        p.style.setProperty('--r1', 'path("' + strand(cfg[2], 1) + '")');
        p.style.setProperty('--r2', 'path("' + strand(cfg[2], 2) + '")');
        p.style.setProperty('--fd', si);
        svg.appendChild(p);
      });

      // sparkles: fixed positions in the takeoff zone, twinkling on a stagger.
      // The star is wrapped in a positioning <g> because CSS scale/rotate on
      // the path itself would clobber an attribute transform.
      const SPARKS = [
        [1700, 26, 4], [1762, 52, 3], [1808, 14, 5], [1846, 44, 3.5],
        [1868, 2, 4.5], [1894, 26, 3], [1910, -8, 5]
      ];
      const inks = ['var(--accent-2)', 'var(--accent-1)', 'var(--warn)'];
      SPARKS.forEach(function (sp, si) {
        const s = sp[2], k = s * 0.28;
        const wrap = el('g', { transform: 'translate(' + sp[0] + ' ' + sp[1] + ')' });
        const star = el('path', {
          d: 'M 0 ' + (-s) + ' L ' + k + ' ' + (-k) + ' L ' + s + ' 0 L ' + k + ' ' + k +
             ' L 0 ' + s + ' L ' + (-k) + ' ' + k + ' L ' + (-s) + ' 0 L ' + (-k) + ' ' + (-k) + ' Z'
        }, 'tr-spark');
        star.style.fill = inks[si % 3];
        star.style.setProperty('--si', si);
        wrap.appendChild(star);
        svg.appendChild(wrap);
      });

      // the strands grow out of the now-marker — keep its beacon on top
      const nowEl = svg.querySelector('.tr-now');
      if (nowEl) svg.appendChild(nowEl);
    }

    return svg;
  }

  function inject() {
    const manifest = window.SLIDE_MANIFEST || [];
    const stems = manifest.map(function (f) { return f.replace(/\.html$/, ''); });
    const sections = buildSections(stems);
    const slides = document.querySelectorAll('.deck > section.slide');
    // everything before the first section opener is front matter: the cover
    // (index 0) gets the animated boot preview, the rest a static one
    const firstOpen = stems.findIndex(function (s) {
      return SECTION_STARTS.some(function (p) { return p[1] === s; });
    });
    slides.forEach(function (sec, i) {
      sec.querySelectorAll('.sec-track').forEach(function (t) { t.remove(); });
      if (i >= stems.length) return;
      const variant = i === 0 ? '__boot__'
        : (firstOpen > 0 && i < firstOpen ? '__preview__' : stems[i]);
      const track = buildTrack(sections, variant, i);
      if (track) sec.appendChild(track);
    });
  }

  // runs on initial load and again whenever the studio swaps slide DOM
  window.addEventListener('slides:loaded', inject);
})();
