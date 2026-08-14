/* Light/dark theme toggle.
   `t` key or the corner button flips :root.theme-light; choice persists in
   localStorage so the deck reopens in whichever theme the venue needed.
   This deck defaults to LIGHT — index.html ships class="theme-light" on <html>
   so the first paint is already light; only an explicit saved 'dark' undoes it. */
(function () {
  const KEY = 'itvest-deck-theme';
  const root = document.documentElement;

  function apply(theme) {
    root.classList.toggle('theme-light', theme === 'light');
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode */ }
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'light' ? '◑' : '◐';
  }

  function flip() {
    apply(root.classList.contains('theme-light') ? 'dark' : 'light');
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  apply(saved === 'dark' ? 'dark' : 'light');

  document.addEventListener('keydown', (e) => {
    if (e.key !== 't' && e.key !== 'T') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    flip();
  });

  function mountButton() {
    if (document.getElementById('theme-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.type = 'button';
    btn.title = 'Toggle light/dark theme (t)';
    btn.textContent = root.classList.contains('theme-light') ? '◑' : '◐';
    btn.addEventListener('click', flip);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }
})();
