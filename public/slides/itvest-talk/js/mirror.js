// Two-window mirror. Opt in by loading the deck with ?mirror in the URL on
// both windows (e.g. one on the projector, one on the laptop). Same-origin,
// same-browser, same-machine only — uses BroadcastChannel.
//
// Sync is on the hash (`#slide.step`). The deck already routes all state
// through history.replaceState + the `deck:stepchange` event, so we just
// broadcast on every stepchange and apply incoming hashes by writing to
// location.hash (which triggers the existing hashchange listener in deck.js).
(function () {
  const params = new URLSearchParams(location.search);
  if (!params.has('mirror')) return;
  if (!('BroadcastChannel' in window)) {
    console.warn('mirror.js: BroadcastChannel unsupported; falling back to localStorage.');
  }

  const channel = ('BroadcastChannel' in window) ? new BroadcastChannel('deck-mirror') : null;
  let suppress = false;

  function send(hash) {
    const payload = { type: 'hash', hash, t: Date.now() };
    if (channel) channel.postMessage(payload);
    else {
      // localStorage fallback: writing fires 'storage' in *other* tabs only.
      localStorage.setItem('deck-mirror', JSON.stringify(payload));
    }
  }

  function receive(payload) {
    if (!payload || payload.type !== 'hash') return;
    if (payload.hash === location.hash) return;
    suppress = true;
    location.hash = payload.hash;
    // hashchange → deck.js applies state → deck:stepchange fires;
    // suppress that one rebroadcast so we don't echo.
    setTimeout(() => { suppress = false; }, 80);
  }

  if (channel) {
    channel.addEventListener('message', (e) => receive(e.data));
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== 'deck-mirror' || !e.newValue) return;
      try { receive(JSON.parse(e.newValue)); } catch {}
    });
  }

  // deck.js uses history.replaceState for hash updates, which does NOT fire
  // hashchange. The deck:stepchange custom event is what we hook for outgoing.
  window.addEventListener('deck:stepchange', () => {
    if (suppress) return;
    send(location.hash || '#1.0');
  });

  // After slides load, announce our position so a later-opened window can
  // catch up to whichever window loaded first (or last — last write wins).
  window.addEventListener('slides:loaded', () => {
    setTimeout(() => send(location.hash || '#1.0'), 300);
  });
})();
