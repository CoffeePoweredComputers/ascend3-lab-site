/* ss-motion v2 — slide-studio: slide-to-slide transitions. Plays the
   data-transition attribute on each <section class="slide"> using the classes
   styled in css/studio-anim.css. A stale version of this file is rewritten on
   studio upgrade while this header remains; strip the header to take ownership.
   Safe to delete (with its <script> tag in index.html) — the deck still works. */
(function () {
  'use strict';
  var deckEl = document.querySelector('.deck');
  if (!deckEl) return;
  var last = null, timer = null, run = 0;

  function clearMotion() {
    if (timer) { clearTimeout(timer); timer = null; }
    var v = deckEl.querySelectorAll('.ss-enter, .ss-leave');
    for (var i = 0; i < v.length; i++) {
      v[i].classList.remove('ss-enter', 'ss-leave');
      v[i].removeAttribute('data-leaving');
    }
    deckEl.removeAttribute('data-dir');
  }

  // deck.js dispatches synchronously inside readHash() -> apply() -> announce(),
  // so the classes added here land before the next paint - no flash of the
  // hidden outgoing slide. Reading window.deck.state (not e.detail) tolerates
  // the studio's detail-less synthetic re-fit events.
  window.addEventListener('deck:stepchange', function () {
    var st = window.deck && window.deck.state;
    if (!st) return;
    var cur = st.slide;
    if (last === null) { last = cur; return; }          // initial position
    if (cur === last) return;                            // step move within a slide
    var secs = deckEl.children;
    var incoming = secs[cur - 1], outgoing = secs[last - 1];
    var dir = cur < last ? 'back' : 'fwd';
    last = cur;
    clearMotion();
    var name = incoming && incoming.getAttribute('data-transition');
    if (!incoming || !name || name === 'none') return;
    deckEl.setAttribute('data-dir', dir);
    incoming.classList.add('ss-enter');
    if (outgoing && outgoing !== incoming) {
      outgoing.setAttribute('data-leaving', name);       // leave styled by the INCOMING slide's transition
      outgoing.classList.add('ss-leave');
    }
    var myRun = ++run;                                   // a stale animationend must not kill the next transition
    var done = function () { if (run === myRun) clearMotion(); };
    incoming.addEventListener('animationend', done, { once: true });
    timer = setTimeout(done, 700);                       // animationend can be lost (display:none race, reduced motion)
  });

  window.addEventListener('slides:loaded', clearMotion); // studio swapped DOM in place
})();
