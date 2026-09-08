/* code-walk.js — the "codewalk" walkthrough engine: auto-wired memory diagrams
   plus a gliding program-counter bar, layered on the deck's .frag step system.

   AUTHORING A WALKTHROUGH SLIDE (no measured geometry, ever):

     <div class="editor">
       <p class="editor__bar">…</p>
       <div class="editor__pc"></div>                 ← the gliding line highlight
       <ol class="editor__code">
         <li class="walkline frag" data-step="1">…    ← is-current = program counter
       </ol>
     </div>
     <div class="codewalk">
       <div class="codewalk__heap">
         <p class="heap-name frag" data-step="1" data-wire="1:acme 5:beta"
            style="grid-row: 1">e1</p>               ← timeline: "step N: point at obj"
         <div class="heap-obj frag" data-step="1" data-obj="acme" style="grid-row: 1">
           <p class="heap-obj__type">Employee</p>
           <div class="heap-obj__field">
             <p class="heap-val heap-val--old frag" data-step="3">id = 0</p>
             <p class="heap-val frag" data-step="3">id = 123</p>
           </div>
           <div class="heap-obj__gone frag" data-step="5">unreachable</div>
         </div>
         <svg class="heap-wires" aria-hidden="true"></svg>   ← arrows render here
       </div>
       <div class="codewalk__caps">
         <p class="walkcap frag" data-step="1">…</p>  ← one voiceover line per step
       </div>
     </div>

   The engine draws every arrow from live layout: rows come from the grid, so
   moving or restyling boxes never breaks a wire. data-wire steps replace each
   other — step 0 means "wired from the start" (recap slides). A name whose
   target changes SWINGS its arrow to the new object; a name whose timeline has
   no entry yet draws on (head riding the tip) or retracts when stepping back.

   Field mutations roll their digits in place (manim's ChangeDecimalToValue):
   for a .heap-val--old / .heap-val pair sharing a data-step, the engine finds
   the last number in each text and counts one into the other — forward on the
   step, backward when scrubbing off it. Values without a number fall back to
   the CSS crossfade. A field with class heap-obj__field--strike is the
   before/after variant (old number struck through, new value beside it — see
   css/deck.css); the engine leaves those alone. Prefer it when a roll would
   read as incrementing rather than replacing.
   A stacked (non-strike) field can also opt out with data-roll="off" — the
   CSS crossfade runs instead, e.g. a default being overwritten (0 → 2021).

   Wire and value state is a pure function of the deck step, so scrubbing both
   directions stays correct. Single-step moves animate; jumps, slide entries,
   and prefers-reduced-motion snap. */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var DRAW_MS = 620, SWING_MS = 680, RETRACT_MS = 420, LAG_MS = 260, COUNT_MS = 600;
  var HEAD = 26, HEADW = 9;          // arrowhead length / half-width, canvas px
  var GAP_OUT = 10, GAP_IN = 8;      // clearance off the pill / before the box
  var EDGE_PAD = 16;                 // arrows land within the box edge, not corners
  var SAMPLES = 36;                  // curve tessellation (drawn as a polyline)

  // manim's default rate function — smootherstep: zero velocity AND zero
  // acceleration at both ends. Matches --ease-smooth in css/deck.css.
  function smooth(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

  var boards = [];
  var last = { slide: -1, step: -1 };

  // ---------------------------------------------------------------- geometry
  // Offset coords relative to the heap container (offsetParent chains end at
  // .codewalk__heap because it is position:relative). Untransformed canvas px,
  // so the deck's viewport scale never enters the math.
  function rectIn(el, root) {
    var x = 0, y = 0, n = el;
    while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }

  // Start = just off the pill's right edge; end = on the box's left edge, at
  // the height where a straight shot at the box centre crosses it (clamped off
  // the corners), plus the unit direction into the centre — the end tangent.
  // Aiming at centres is what makes shared objects read as "both arrows
  // converge on this one thing".
  function anchors(wire, objEl) {
    var p = rectIn(wire.pill, wire.heap), o = rectIn(objEl, wire.heap);
    var S = { x: p.x + p.w + GAP_OUT, y: p.y + p.h / 2 };
    var cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    var ex = o.x - GAP_IN;
    var t = (ex - S.x) / Math.max(1, cx - S.x);
    var ey = S.y + (cy - S.y) * t;
    ey = Math.min(Math.max(ey, o.y + EDGE_PAD), o.y + o.h - EDGE_PAD);
    var ax = cx - ex, ay = cy - ey, al = Math.hypot(ax, ay) || 1;
    return { S: S, E: { x: ex, y: ey, ax: ax / al, ay: ay / al } };
  }

  // Cubic connector: leaves the pill horizontally, arrives along the aim-at-
  // centre direction. Structural, not cosmetic — the horizontal exit keeps a
  // long wire out in the gutter, clear of the object rows it passes.
  // Row-aligned wires degenerate to a straight line. Tessellated so partial
  // draws and tip tangents are just arithmetic on the polyline.
  function curveFor(S, E) {
    var chord = Math.hypot(E.x - S.x, E.y - S.y);
    var k1 = Math.min(150, chord * 0.42);
    var k2 = Math.min(130, chord * 0.38);
    var C1 = { x: S.x + k1, y: S.y };
    var C2 = { x: E.x - (E.ax || 1) * k2, y: E.y - (E.ay || 0) * k2 };
    var pts = [], cum = [0], total = 0, i, u, a, x, y;
    for (i = 0; i <= SAMPLES; i++) {
      u = i / SAMPLES; a = 1 - u;
      x = a * a * a * S.x + 3 * a * a * u * C1.x + 3 * a * u * u * C2.x + u * u * u * E.x;
      y = a * a * a * S.y + 3 * a * a * u * C1.y + 3 * a * u * u * C2.y + u * u * u * E.y;
      if (i) { total += Math.hypot(x - pts[i - 1].x, y - pts[i - 1].y); cum.push(total); }
      pts.push({ x: x, y: y });
    }
    return { pts: pts, cum: cum, total: total };
  }

  function pointAt(c, s) {
    s = Math.min(Math.max(s, 0), c.total);
    var i = 1;
    while (i < c.cum.length - 1 && c.cum[i] < s) i++;
    var seg = c.cum[i] - c.cum[i - 1] || 1;
    var f = (s - c.cum[i - 1]) / seg;
    var A = c.pts[i - 1], B = c.pts[i];
    return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f };
  }

  // ---------------------------------------------------------------- render
  // f = drawn fraction of the wire's arc length. The head grows out of the
  // first few pixels and rides the tip for the rest of the draw.
  function render(wire, S, E, f) {
    if (f <= 0.001) { wire.g.style.opacity = 0; return; }
    wire.g.style.opacity = 1;
    var c = curveFor(S, E);
    var tip = c.total * f;
    var k = Math.min(1, tip / (HEAD * 1.4));         // head scale while emerging
    var solid = Math.max(0, tip - HEAD * k * 0.72);  // stroke stops under the head
    var d = '', i = 1, P;
    d = 'M ' + c.pts[0].x.toFixed(1) + ' ' + c.pts[0].y.toFixed(1);
    while (i < c.cum.length && c.cum[i] <= solid) {
      d += ' L ' + c.pts[i].x.toFixed(1) + ' ' + c.pts[i].y.toFixed(1);
      i++;
    }
    P = pointAt(c, solid);
    d += ' L ' + P.x.toFixed(1) + ' ' + P.y.toFixed(1);
    wire.line.setAttribute('d', d);

    var T = pointAt(c, tip), B = pointAt(c, Math.max(0, tip - 2));
    var ang = Math.atan2(T.y - B.y, T.x - B.x);
    var ca = Math.cos(ang), sa = Math.sin(ang);
    var bx = T.x - HEAD * k * ca, by = T.y - HEAD * k * sa;
    var px = -sa * HEADW * k, py = ca * HEADW * k;
    wire.head.setAttribute('d',
      'M ' + T.x.toFixed(1) + ' ' + T.y.toFixed(1) +
      ' L ' + (bx + px).toFixed(1) + ' ' + (by + py).toFixed(1) +
      ' L ' + (bx - px).toFixed(1) + ' ' + (by - py).toFixed(1) + ' Z');
  }

  // ---------------------------------------------------------------- animate
  function animate(wire, ms, delay, frame, done) {
    cancelAnimationFrame(wire.raf);
    var t0 = performance.now() + delay;
    function tick(now) {
      var u = (now - t0) / ms;
      if (u < 0) { frame(0); wire.raf = requestAnimationFrame(tick); return; }
      if (u >= 1) { frame(1); wire.raf = 0; if (done) done(); return; }
      frame(smooth(u));
      wire.raf = requestAnimationFrame(tick);
    }
    wire.raf = requestAnimationFrame(tick);
  }

  // Bring one wire to its state for `obj` (an object id or null).
  // mode 'snap' jumps; 'anim' picks draw / swing / retract from the change.
  function setWire(wire, obj, mode, lag) {
    var target = obj ? wire.objs[obj] : null;
    if (obj && !target) return;                       // authoring typo: ignore
    if (mode === 'snap' || reduced()) {
      cancelAnimationFrame(wire.raf); wire.raf = 0;
      wire.cur = obj;
      if (!target) { render(wire, { x: 0, y: 0 }, { x: 1, y: 0 }, 0); return; }
      var a0 = anchors(wire, target);
      wire.S = a0.S; wire.E = a0.E;
      render(wire, a0.S, a0.E, 1);
      return;
    }
    if (!obj) {                                       // retract (back-step)
      var S1 = wire.S, E1 = wire.E;
      wire.cur = null;
      animate(wire, RETRACT_MS, 0, function (u) { render(wire, S1, E1, 1 - u); });
    } else if (!wire.cur) {                           // draw on
      var a1 = anchors(wire, target);
      wire.S = a1.S; wire.E = a1.E; wire.cur = obj;
      animate(wire, DRAW_MS, lag ? LAG_MS : 0, function (u) { render(wire, a1.S, a1.E, u); });
    } else {                                          // swing to a new object
      var a2 = anchors(wire, target);
      var S2 = wire.S, E0 = wire.E, E2 = a2.E;
      wire.cur = obj; wire.E = E2;
      animate(wire, SWING_MS, 0, function (u) {
        render(wire, S2, {
          x: E0.x + (E2.x - E0.x) * u,
          y: E0.y + (E2.y - E0.y) * u,
          ax: (E0.ax || 1) + ((E2.ax || 1) - (E0.ax || 1)) * u,
          ay: (E0.ay || 0) + ((E2.ay || 0) - (E0.ay || 0)) * u,
        }, 1);
      });
    }
  }

  function targetAt(tl, step) {
    var obj = null, i;
    for (i = 0; i < tl.length; i++) if (tl[i].step <= step) obj = tl[i].obj;
    return obj;
  }

  // ---------------------------------------------------------------- counts
  // Split a value text around its last number, e.g. "id = 123" →
  // pre "id = ", num 123, dec 0, suf "". null num = not countable.
  function parseVal(el) {
    var text = el.textContent;
    var m = text.match(/-?\d+(?:\.\d+)?(?!.*\d)/);
    if (!m) return { text: text, num: null };
    return {
      text: text,
      num: parseFloat(m[0]),
      dec: (m[0].split('.')[1] || '').length,
      pre: text.slice(0, m.index),
      suf: text.slice(m.index + m[0].length),
    };
  }

  // manim's ChangeDecimalToValue: showEl's digits roll from one value to the
  // other, in place. Both elements swap instantly (inline transition: none) —
  // the roll IS the animation; any crossfade under it reads as ghosting. The
  // inline styles and authored texts are restored by the next snap/step
  // (onStep's else arm touches every pair on every move).
  function runCount(c, from, to, showEl, hideEl) {
    if (from.num == null || to.num == null) return;    // CSS crossfade handles it
    hideEl.style.transition = 'none'; hideEl.style.opacity = '0';
    showEl.style.transition = 'none'; showEl.style.opacity = '1';
    showEl.textContent = to.pre + from.num.toFixed(to.dec) + to.suf;   // before paint
    animate(c, COUNT_MS, 0, function (u) {
      showEl.textContent = to.pre + (from.num + (to.num - from.num) * u).toFixed(to.dec) + to.suf;
    }, function () { showEl.textContent = to.text; });
  }

  // ---------------------------------------------------------------- pc bar
  // One translucent bar per editor glides to whichever .walkline is-current.
  function updatePC(sec, animated) {
    sec.querySelectorAll('.editor').forEach(function (ed) {
      var bar = ed.querySelector('.editor__pc');
      if (!bar) return;
      var cur = ed.querySelector('.walkline.is-current');
      if (!animated) bar.style.transition = 'none';
      if (cur) {
        bar.style.transform = 'translateY(' + cur.offsetTop + 'px)';
        bar.style.height = cur.offsetHeight + 'px';
        bar.classList.add('is-on');
      } else {
        bar.classList.remove('is-on');
      }
      if (!animated) { void bar.offsetWidth; bar.style.transition = ''; }
    });
  }

  // ---------------------------------------------------------------- wiring
  // Rebuilt from the DOM on every slides:loaded (the studio swaps slide DOM in
  // place and refires it). Idempotent: the svg is emptied before repopulating.
  function build() {
    boards = [];
    var deckEl = document.querySelector('.deck');
    if (!deckEl) return;
    Array.prototype.forEach.call(deckEl.children, function (sec, i) {
      var heaps = sec.querySelectorAll('.codewalk__heap');
      if (!heaps.length && !sec.querySelector('.editor__pc')) return;
      var board = { sec: sec, index: i + 1, wires: [], counts: [] };
      sec.querySelectorAll('.heap-obj__field').forEach(function (field) {
        if (field.classList.contains('heap-obj__field--strike')) return;   // before/after: CSS only
        if (field.getAttribute('data-roll') === 'off') return;             // authored opt-out: crossfade, never count
        var old = field.querySelector('.heap-val--old[data-step]');
        var neu = field.querySelector('.heap-val[data-step]:not(.heap-val--old)');
        if (!old || !neu) return;
        board.counts.push({
          old: old, neu: neu,
          step: parseInt(neu.getAttribute('data-step'), 10) || 0,
          o: parseVal(old), n: parseVal(neu), raf: 0,
        });
      });
      heaps.forEach(function (heap) {
        var svg = heap.querySelector('svg.heap-wires');
        if (!svg) {
          svg = document.createElementNS(SVGNS, 'svg');
          svg.setAttribute('class', 'heap-wires');
          svg.setAttribute('aria-hidden', 'true');
          heap.appendChild(svg);
        }
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        var objs = {};
        heap.querySelectorAll('[data-obj]').forEach(function (o) {
          objs[o.getAttribute('data-obj')] = o;
        });
        heap.querySelectorAll('[data-wire]').forEach(function (pill) {
          var tl = pill.getAttribute('data-wire').trim().split(/[\s,]+/)
            .map(function (pair) {
              var m = pair.split(':');
              return { step: parseInt(m[0], 10) || 0, obj: m[1] };
            })
            .sort(function (a, b) { return a.step - b.step; });
          var g = document.createElementNS(SVGNS, 'g');
          var line = document.createElementNS(SVGNS, 'path');
          var head = document.createElementNS(SVGNS, 'path');
          g.setAttribute('class', 'wire');
          line.setAttribute('class', 'wire__line');
          head.setAttribute('class', 'wire__head');
          g.style.opacity = 0;
          g.appendChild(line); g.appendChild(head); svg.appendChild(g);
          board.wires.push({
            pill: pill, heap: heap, objs: objs, tl: tl,
            g: g, line: line, head: head,
            cur: null, S: null, E: null, raf: 0,
          });
        });
      });
      boards.push(board);
    });
  }

  function onStep(slide, step) {
    var animated = slide === last.slide && Math.abs(step - last.step) === 1 && !reduced();
    boards.forEach(function (b) {
      if (b.index !== slide) return;                  // only the visible slide measures
      b.wires.forEach(function (w) {
        var obj = targetAt(w.tl, step);
        if (obj === w.cur && (w.E || !obj)) return;
        // when the target box (or the pill) materialises this same step, let
        // it grow in first — the wire draws a beat behind it.
        var lag = false;
        if (obj) {
          var os = parseInt(w.objs[obj].getAttribute('data-step') || '0', 10);
          var ps = parseInt(w.pill.getAttribute('data-step') || '0', 10);
          lag = os === step || ps === step;
        }
        setWire(w, obj, animated ? 'anim' : 'snap', lag);
      });
      b.counts.forEach(function (c) {
        cancelAnimationFrame(c.raf); c.raf = 0;
        if (animated && step === c.step && last.step === c.step - 1) {
          runCount(c, c.o, c.n, c.neu, c.old);         // forward onto the step
        } else if (animated && step === c.step - 1 && last.step === c.step) {
          runCount(c, c.n, c.o, c.old, c.neu);         // scrubbed back off it
        } else {                                       // snap: authored state
          c.old.style.opacity = ''; c.neu.style.opacity = '';
          c.old.style.transition = ''; c.neu.style.transition = '';
          c.old.textContent = c.o.text; c.neu.textContent = c.n.text;
        }
      });
      updatePC(b.sec, animated);
    });
    last = { slide: slide, step: step };
  }

  function refresh() {                                 // re-measure (fonts settle)
    if (!window.deck) return;
    last = { slide: -1, step: -1 };
    boards.forEach(function (b) { b.wires.forEach(function (w) { w.cur = null; w.E = null; }); });
    onStep(window.deck.state.slide, window.deck.state.step);
  }

  window.addEventListener('deck:stepchange', function (e) {
    onStep(e.detail.slide, e.detail.step);
  });
  // deck.js re-announces inside its own slides:loaded handler, which ran before
  // ours could rebuild — so rebuild here and re-derive state from deck.state.
  window.addEventListener('slides:loaded', function () { build(); refresh(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
})();
