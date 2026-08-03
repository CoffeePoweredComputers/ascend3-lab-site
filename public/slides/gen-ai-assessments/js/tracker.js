/* Section tracker — a scantron take on the beamer headline, injected at
   runtime so slide files stay clean. One header band per content slide:
   section names with one bubble per slide, the current one penciled in.

   Membership is DERIVED from the manifest in index.html. Each section is
   named by the slide that OPENS it; every slide from there up to the next
   opener belongs to it. So adding a slide to the manifest gives it a band
   and a bubble automatically — the manifest stays the single source of
   deck order, and a new slide can no longer silently lose its band.
   Only touch SECTION_STARTS when a slide begins a genuinely new section. */
(function () {
  'use strict';

  // section name → the manifest stem (filename without .html) that opens it
  const SECTION_STARTS = [
    ['Assessments', 'response-score-claim'],
    ['Concepts', 'the-chain'],
    ['Generation', 'the-question-splits'],
    ['Testing', 'so-what'],
    ['GenAI Grading', 'the-pile'],
    ['Implications & Future Work', 'return-to-pedagogy'],
  ];

  // Front and back matter sit outside the arc and carry no band: the cover,
  // the agenda, and the reference list. Everything else in the manifest gets
  // one. (Slides ahead of the first opener are excluded automatically.)
  const NO_BAND = ['title', 'overview', 'references', 'references-cont'];

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

  function buildTrack(sections, stem) {
    let found = false;
    const track = document.createElement('div');
    track.className = 'sec-track';
    for (const [name, stems] of sections) {
      const sec = document.createElement('div');
      sec.className = 'st-sec';
      const em = document.createElement('em');
      em.textContent = name;
      const dots = document.createElement('span');
      for (const s of stems) {
        const b = document.createElement('b');
        if (s === stem) {
          b.className = 'is-now';
          sec.className = 'st-sec is-here';
          found = true;
        }
        dots.appendChild(b);
      }
      sec.appendChild(em);
      sec.appendChild(dots);
      track.appendChild(sec);
    }
    return found ? track : null;   // front/back matter gets no band
  }

  function inject() {
    const manifest = window.SLIDE_MANIFEST || [];
    const stems = manifest.map(function (f) { return f.replace(/\.html$/, ''); });
    const sections = buildSections(stems);
    const slides = document.querySelectorAll('.deck > section.slide');
    slides.forEach(function (sec, i) {
      sec.querySelectorAll('.sec-track').forEach(function (t) { t.remove(); });
      if (i >= stems.length) return;
      const track = buildTrack(sections, stems[i]);
      if (track) sec.appendChild(track);
    });
  }

  // runs on initial load and again whenever the studio swaps slide DOM
  window.addEventListener('slides:loaded', inject);
})();
