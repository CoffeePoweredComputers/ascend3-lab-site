// Keyboard play. Anything on the page with data-key="x" is clicked when x is
// pressed: a choice toggles, a button submits, a link opens. Typing in a text
// field is left alone; Escape leaves the field.
(function () {
  const typing = (el) =>
    el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' && !['checkbox', 'radio'].includes(el.type)));

  // Put the "you are here" marker where the climbed part of the trail ends.
  const climbed = document.querySelector('.trail__gain');
  const you = document.querySelector('.trail__you');
  if (climbed && you) {
    const at = climbed.getPointAtLength(climbed.getTotalLength() * Number(you.dataset.at));
    you.setAttribute('cx', at.x);
    you.setAttribute('cy', at.y);
    you.classList.remove('is-unplaced');
  }

  // A field that makes another one required once it has something in it:
  // a new code's name needs its definition.
  document.querySelectorAll('[data-needs]').forEach((el) => {
    const other = el.form && el.form.elements[el.dataset.needs];
    if (other) el.addEventListener('input', () => { other.required = el.value.trim() !== ''; });
  });

  // Has anything on this card been changed and not saved?
  let dirty = false;
  document.addEventListener('input', (event) => { if (event.target.form) dirty = true; });
  document.addEventListener('submit', () => { dirty = false; });

  document.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    // Ctrl+Enter from a text box is the card's main button.
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && typing(active) && active.form) {
      const main = active.form.querySelector('[data-key="Enter"]:not([disabled])');
      if (main) { event.preventDefault(); main.click(); }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (typing(active)) {
      if (event.key === 'Escape') active.blur();
      return;
    }
    // Leave the browser's own behaviour for a focused button, link or radio group.
    if (event.key === 'Enter' && active && ['BUTTON', 'A', 'SUMMARY'].includes(active.tagName)) return;
    if (event.key.startsWith('Arrow') && active && active.type === 'radio') return;

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const target = document.querySelector(`[data-key="${CSS.escape(key)}"]:not([disabled])`);
    if (!target || target.offsetParent === null) return;  // not on screen, e.g. inside a closed panel
    event.preventDefault();
    // A key on a label puts the cursor in its box.
    if (target.tagName === 'LABEL' && target.control) { target.control.focus(); return; }
    // A key never walks away from a card with unsaved changes on it.
    if (target.tagName === 'A' && dirty && target.target !== '_blank') return;
    target.click();
  });
})();
