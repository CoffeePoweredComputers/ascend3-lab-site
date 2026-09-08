/* Information-sheet page: the print button (CSP disallows inline handlers). */
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-print]');
  if (b) window.print();
});
