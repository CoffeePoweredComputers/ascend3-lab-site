// Loads all slide partials into the deck container, in numeric order.
// Fetches in parallel; appends in manifest order so DOM stays correct.
(async function loadSlides() {
  const manifest = window.SLIDE_MANIFEST || [];
  const deck = document.querySelector('.deck');
  if (!deck) return;
  const parser = new DOMParser();

  const texts = await Promise.all(
    manifest.map(filename =>
      fetch(`slides/${filename}?v=166`)
        .then(r => r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`))
        .catch(err => { console.error(`slides/${filename}:`, err); return null; })
    )
  );

  // Track imported scripts so we can re-create them as live scripts after
  // the DOM is settled. Scripts parsed via DOMParser are inert when imported.
  const scriptsToRun = [];

  texts.forEach((text, i) => {
    if (!text) return;
    const doc = parser.parseFromString(text, 'text/html');
    const section = doc.querySelector('section.slide');
    if (!section) {
      console.warn(`No <section class="slide"> in slides/${manifest[i]}`);
      return;
    }
    const imported = document.importNode(section, true);
    deck.appendChild(imported);
    imported.querySelectorAll('script').forEach(s => scriptsToRun.push(s));
  });

  // Re-create each script element so the browser actually executes it.
  // (DOMParser-imported <script> nodes are inert by HTML spec.)
  scriptsToRun.forEach(orig => {
    const fresh = document.createElement('script');
    for (const attr of orig.attributes) fresh.setAttribute(attr.name, attr.value);
    fresh.textContent = orig.textContent;
    orig.replaceWith(fresh);
  });

  window.dispatchEvent(new Event('slides:loaded'));
})();
