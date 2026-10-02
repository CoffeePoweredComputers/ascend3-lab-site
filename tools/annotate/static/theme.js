// Light and dark, the way the main site does it: the choice lives in
// localStorage under "theme" on this origin, so the site and the tool share it.
// Loaded in <head>, so the class is set before anything paints.
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) { /* storage blocked */ }
  if (saved === 'dark' || (!saved && matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.classList.add('dark');
  }
  document.addEventListener('click', function (event) {
    if (!event.target.closest('[data-theme-toggle]')) return;
    var dark = root.classList.toggle('dark');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) { /* still switches for this page */ }
  });
})();
