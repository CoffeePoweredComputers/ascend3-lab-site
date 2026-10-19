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

  // A search box over a list: a row that does not mention every word typed is
  // hidden. Enter ticks the first row left, rather than sending the card.
  document.querySelectorAll('[data-filters]').forEach((box) => {
    const list = document.getElementById(box.dataset.filters);
    const rows = [...list.querySelectorAll('label')];
    const none = list.querySelector('p[hidden]');
    const shown = () => rows.filter((row) => !row.hidden);
    box.addEventListener('input', () => {
      const words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
      rows.forEach((row) => {
        const text = row.textContent.toLowerCase();
        row.hidden = !words.every((word) => text.includes(word));
      });
      if (none) none.hidden = shown().length > 0;
    });
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const first = box.value.trim() && shown()[0];
      if (first) { first.control.click(); box.select(); }
    });
  });

  // The codes ticked on this card are listed under it. Every code has a line
  // there, shown only while its box is ticked; "Take off" unticks the box.
  const applied = document.querySelector('[data-applied]');
  if (applied) {
    const lines = [...applied.querySelectorAll('[data-code]')];
    const box = (line) => document.querySelector(`input[name="code"][value="${line.dataset.code}"]`);
    document.addEventListener('change', () => lines.forEach((line) => { line.hidden = !box(line).checked; }));
    applied.addEventListener('click', (event) => {
      const line = event.target.closest('button') && event.target.closest('[data-code]');
      if (line) box(line).click();
    });
  }

  // Has anything on this card been changed and not saved? A box with no name
  // is not sent, so typing in it changes nothing.
  let dirty = false;
  document.addEventListener('input', (event) => { if (event.target.form && event.target.name) dirty = true; });
  document.addEventListener('submit', () => { dirty = false; });

  // The diagram, big. A click on it, or +, opens it over the page: scroll or
  // + and - to zoom toward the pointer, drag to move, 0 to fit, Esc to close.
  // While it is open no card key reaches the page behind it.
  const zoomers = document.querySelectorAll('[data-zoom]');
  if (zoomers.length) {
    const dialog = document.createElement('dialog');
    dialog.className = 'zoomed';
    dialog.setAttribute('aria-label', 'The diagram, enlarged');
    const stage = document.createElement('div');
    stage.className = 'zoomed__stage';
    const big = document.createElement('img');
    big.alt = 'Student diagram, enlarged';
    big.draggable = false;
    stage.append(big);
    const bar = document.createElement('p');
    bar.className = 'zoomed__bar';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Scroll or + and - to zoom, drag to move, 0 to fit.';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'quiet';
    close.innerHTML = 'Close <kbd>Esc</kbd>';
    bar.append(hint, close);
    dialog.append(stage, bar);
    document.body.append(dialog);

    let scale = 1, x = 0, y = 0;
    const apply = () => { big.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
    const fit = () => { scale = 1; x = 0; y = 0; apply(); };
    // Zoom by a factor, keeping the point under (px, py) where it is.
    const zoomAt = (factor, px, py) => {
      const next = Math.min(8, Math.max(1, scale * factor));
      const rect = stage.getBoundingClientRect();
      const cx = (px ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const cy = (py ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      x = cx - (cx - x) * (next / scale);
      y = cy - (cy - y) * (next / scale);
      scale = next;
      if (scale === 1) { x = 0; y = 0; }
      apply();
    };

    zoomers.forEach((button) => button.addEventListener('click', () => {
      const img = button.querySelector('img');
      big.src = img.currentSrc || img.src;
      fit();
      dialog.showModal();
      close.focus();
    }));
    close.addEventListener('click', () => dialog.close());
    // A click on the dark backdrop closes it too.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', (event) => {
      if (scale > 1) fit(); else zoomAt(2.5, event.clientX, event.clientY);
    });
    let drag = null;
    stage.addEventListener('pointerdown', (event) => {
      drag = { px: event.clientX, py: event.clientY, x, y };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', (event) => {
      if (!drag) return;
      x = drag.x + event.clientX - drag.px;
      y = drag.y + event.clientY - drag.py;
      apply();
    });
    const drop = () => { drag = null; stage.classList.remove('is-dragging'); };
    stage.addEventListener('pointerup', drop);
    stage.addEventListener('pointercancel', drop);
    dialog.addEventListener('keydown', (event) => {
      if (event.key === '+' || event.key === '=') zoomAt(1.4);
      else if (event.key === '-' || event.key === '_') zoomAt(1 / 1.4);
      else if (event.key === '0') fit();
      else return;
      event.preventDefault();
    });
  }

  document.addEventListener('keydown', (event) => {
    // The enlarged diagram has its own keys; nothing goes to the card behind it.
    if (document.querySelector('dialog.zoomed[open]')) return;
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
