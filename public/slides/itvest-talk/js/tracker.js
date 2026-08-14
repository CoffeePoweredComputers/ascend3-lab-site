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

  // section name → the manifest stem (filename without .html) that opens it
  const SECTION_STARTS = [
    ['Bottleneck',     '03-what-we-assess'],
    ['Question types', '05c-cgbg-animation'],
    ['Fork',           '13b-act3'],
    ['Languages',      '19b-multilingual'],
    ['Drawings',       '11b-visual-prompting-A'],
    ['Platform',       '09c-non-cgbg'],
  ];

  // Front and back matter sit outside the arc and carry no band: the cover
  // and the context slide fall before the first opener (excluded
  // automatically); the close is exempted here.
  const NO_BAND = ['24-research-questions-18', '25-acknowledgments', '26-thank-you'];

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
    let curSec = -1, curTick = -1;
    sections.forEach(function (s, i) {
      const j = s[1].indexOf(stem);
      if (j >= 0) { curSec = i; curTick = j; }
    });
    if (curSec < 0) return null;   // front/back matter gets no band

    const weights = sections.map(function (s) { return s[1].length + GAP_W; });
    const px = (R - L) / weights.reduce(function (a, b) { return a + b; }, 0);

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' }, 'sec-track');

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
    svg.appendChild(defs);

    // the road ahead: dotted, ending in the deck's gradient arrowhead
    svg.appendChild(el('line',
      { x1: L, y1: LINE_Y, x2: R, y2: LINE_Y, 'marker-end': 'url(#arrowhead)' }, 'tr-base'));

    // geometry pass: stop/tick/name positions, and where "now" is
    let x = L, curX = L;
    const ticks = [], stops = [], names = [];
    sections.forEach(function (sec, i) {
      const name = sec[0], stems = sec[1];
      const state = i < curSec ? 'is-past' : i === curSec ? 'is-here' : 'is-future';
      const t = el('text', { x: x, y: NAME_Y }, 'tr-name ' + state);
      t.textContent = name.toUpperCase();
      names.push(t);
      stops.push(el('circle', { cx: x, cy: LINE_Y, r: 6.5 }, 'tr-stop ' + state));
      stems.forEach(function (s2, j) {
        const tx = x + (j + 0.5) * px;
        if (i === curSec && j === curTick) curX = tx;
        else if (i > curSec || (i === curSec && j > curTick)) {
          ticks.push(el('circle', { cx: tx, cy: LINE_Y, r: 3 }, 'tr-tick'));
        }
        // passed ticks vanish under the fill line — the trail absorbs them
      });
      x += (stems.length + GAP_W) * px;
    });

    // the traveled stretch: solid gradient over the dotted base
    svg.appendChild(el('line',
      { x1: L, y1: LINE_Y, x2: curX, y2: LINE_Y, stroke: 'url(#' + gradId + ')' }, 'tr-fill'));

    ticks.forEach(function (n) { svg.appendChild(n); });
    stops.forEach(function (n) { svg.appendChild(n); });
    names.forEach(function (n) { svg.appendChild(n); });

    const now = el('g', { transform: 'translate(' + curX + ' ' + LINE_Y + ')' }, 'tr-now');
    now.appendChild(el('circle', { r: 9 }, 'tr-now-halo'));
    now.appendChild(el('circle', { r: 5 }, 'tr-now-core'));
    svg.appendChild(now);

    return svg;
  }

  function inject() {
    const manifest = window.SLIDE_MANIFEST || [];
    const stems = manifest.map(function (f) { return f.replace(/\.html$/, ''); });
    const sections = buildSections(stems);
    const slides = document.querySelectorAll('.deck > section.slide');
    slides.forEach(function (sec, i) {
      sec.querySelectorAll('.sec-track').forEach(function (t) { t.remove(); });
      if (i >= stems.length) return;
      const track = buildTrack(sections, stems[i], i);
      if (track) sec.appendChild(track);
    });
  }

  // runs on initial load and again whenever the studio swaps slide DOM
  window.addEventListener('slides:loaded', inject);
})();
