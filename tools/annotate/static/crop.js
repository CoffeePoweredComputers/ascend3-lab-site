// Draw the keep-rectangle on the triage photo. The four hidden inputs carry it
// to the server as fractions of the image, so it survives any display size.
(function () {
  const frame = document.querySelector('[data-crop]');
  if (!frame) return;
  const box = frame.querySelector('.crop__box');
  const form = frame.closest('form');
  const field = (name) => form.querySelector(`[name="crop_${name}"]`);
  let start = null;
  let before = null;

  function show(x, y, w, h) {
    box.hidden = false;
    box.style.left = `${x * 100}%`;
    box.style.top = `${y * 100}%`;
    box.style.width = `${w * 100}%`;
    box.style.height = `${h * 100}%`;
    for (const [name, value] of Object.entries({ x, y, w, h })) field(name).value = value.toFixed(4);
  }

  function clear() {
    box.hidden = true;
    for (const name of ['x', 'y', 'w', 'h']) field(name).value = '';
  }

  function at(event) {
    // Measured on the picture itself, whatever the box round it is doing.
    const r = frame.querySelector('img').getBoundingClientRect();
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return { x: clamp((event.clientX - r.left) / r.width), y: clamp((event.clientY - r.top) / r.height) };
  }

  frame.addEventListener('pointerdown', (event) => {
    start = at(event);
    before = ['x', 'y', 'w', 'h'].map((name) => field(name).value);
    frame.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  frame.addEventListener('pointermove', (event) => {
    if (!start) return;
    const now = at(event);
    show(Math.min(start.x, now.x), Math.min(start.y, now.y), Math.abs(now.x - start.x), Math.abs(now.y - start.y));
  });
  frame.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    // A click or a sliver is not a crop: put back whatever was there.
    if (Number(field('w').value) < 0.03 || Number(field('h').value) < 0.03) {
      if (before.every((v) => v !== '')) show(...before.map(Number));
      else clear();
    }
  });
  frame.addEventListener('pointercancel', () => { start = null; });

  document.querySelector('[data-crop-clear]').addEventListener('click', clear);

  const saved = ['x', 'y', 'w', 'h'].map((k) => parseFloat(frame.dataset[k]));
  if (saved.every((v) => !Number.isNaN(v))) show(...saved);
})();
