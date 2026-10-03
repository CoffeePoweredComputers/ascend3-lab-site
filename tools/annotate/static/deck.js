// Keyboard play. Anything on the page with data-key="x" is clicked when x is
// pressed: a choice toggles, a button submits, a link opens. Typing in a text
// field is left alone; Escape leaves the field.
(function () {
  const typing = (el) =>
    el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' && !['checkbox', 'radio'].includes(el.type)));

  // Put the "you are here" marker, and each teammate's dot, where their
  // share of the trail ends. Teammates standing together are spread sideways.
  const climbed = document.querySelector('.trail__gain');
  if (climbed) {
    const total = climbed.getTotalLength();
    const you = document.querySelector('.trail__you');
    if (you) {
      const at = climbed.getPointAtLength(total * Number(you.dataset.at));
      you.setAttribute('cx', at.x);
      you.setAttribute('cy', at.y);
      you.classList.remove('is-unplaced');
    }
    document.querySelectorAll('.mate').forEach((mate) => {
      const at = climbed.getPointAtLength(total * Number(mate.dataset.at));
      const x = at.x + Number(mate.dataset.shift) * 8;
      mate.querySelector('.mate__dot').setAttribute('cx', x);
      mate.querySelector('.mate__dot').setAttribute('cy', at.y);
      const name = mate.querySelector('.mate__name');
      name.setAttribute('x', x);
      name.setAttribute('y', at.y - 8);
      mate.classList.remove('is-unplaced');
    });
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
