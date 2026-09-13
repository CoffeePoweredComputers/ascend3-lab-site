/* timer.js — the discussion countdown on a vote slide, as a deck step.

   Markup, once per slide that has a discussion (the manim arc):
     <div class="timer frag" data-step="1" data-timer="300" data-state="idle" role="timer" aria-label="…">
       <svg class="timer__arc" viewBox="0 0 150 150" aria-hidden="true">
         <circle class="timer__track" cx="75" cy="75" r="62"/>
         <g class="timer__ticks"><line class="timer__tick" …/> ×5 (every 72° from twelve)</g>
         <circle class="timer__ring" cx="75" cy="75" r="62" transform="rotate(-90 75 75)"/>
         <g class="timer__hand"><circle class="timer__dot" cx="75" cy="13" r="7"/></g>
         <text class="timer__time" x="75" y="88">5:00</text>
       </svg>
     </div>
   data-timer is the length in seconds. Styles live in css/deck.css (.timer).
   paint() sets the ring's dashoffset (2π·62 × elapsed fraction), rotates the
   hand to the tip, marks the ticks the tip has passed, and writes the digits.

   No keys of its own: the timer is a .frag, so it behaves like any build.
   Whatever advances the deck (space, the right or down arrow, page down)
   reaches its step and the clock starts; the next press moves on to the
   next slide. Stepping back before its step resets it, and stepping forward
   again restarts it. Leaving the slide resets it. State is a function of the
   deck's hash, so scrubbing works both ways. Written to data-state (idle ·
   running · done); the last minute adds .timer--last, so colour is CSS's.
   Ticks on a 250 ms interval from a wall-clock start, so a slow frame never
   loses time. */
(function () {
  'use strict';
  var timers = [];

  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  var CIRC = 2 * Math.PI * 62;
  function paint(t) {
    var r = t.total ? t.left / t.total : 0;               // fraction remaining
    t.el.querySelector('.timer__time').textContent = fmt(t.left);
    var ring = t.el.querySelector('.timer__ring'), hand = t.el.querySelector('.timer__hand');
    if (ring) ring.style.strokeDashoffset = CIRC * (1 - r);
    if (hand) hand.style.transform = 'rotate(' + (r * 360) + 'deg)';
    var ticks = t.el.querySelectorAll('.timer__tick');
    for (var i = 0; i < ticks.length; i++) ticks[i].classList.toggle('is-past', i > 0 && i / ticks.length >= r);
    t.el.classList.toggle('timer--last', t.left > 0 && t.left <= 60);
  }
  // A reset snaps: the ring refills and the hand returns to twelve without
  // the glide, so stepping back never plays a spin.
  function reset(t) {
    clearInterval(t.iv); t.iv = 0; t.running = false; t.left = t.total;
    t.el.setAttribute('data-state', 'idle');
    t.el.classList.add('timer--snap'); paint(t);
    void t.el.offsetWidth;                            // commit the snapped frame before the glide returns
    t.el.classList.remove('timer--snap');
  }
  function start(t) {
    t.running = true; t.startAt = Date.now();
    t.el.setAttribute('data-state', 'running'); paint(t);
    t.iv = setInterval(function () {
      t.left = Math.max(0, t.total - (Date.now() - t.startAt) / 1000);
      paint(t);
      if (t.left <= 0) { clearInterval(t.iv); t.iv = 0; t.running = false; t.el.setAttribute('data-state', 'done'); }
    }, 250);
  }

  // Bring every timer to the state its step and slide imply.
  function sync() {
    timers.forEach(function (t) {
      var sec = t.el.closest('section');
      var live = sec && sec.classList.contains('is-active') &&
                 (t.el.classList.contains('is-current') || t.el.classList.contains('is-past'));
      if (live) { if (!t.running && t.el.getAttribute('data-state') !== 'done') start(t); }
      else reset(t);
    });
  }
  function build() {
    timers.forEach(function (t) { clearInterval(t.iv); });
    timers = [];
    document.querySelectorAll('.timer[data-timer]').forEach(function (el) {
      timers.push({ el: el, total: parseInt(el.getAttribute('data-timer'), 10) || 300, left: 0, running: false, iv: 0, startAt: 0 });
    });
    timers.forEach(reset);
  }

  window.addEventListener('slides:loaded', function () { build(); sync(); });
  window.addEventListener('deck:stepchange', sync);
})();
