// The video's buttons. On an episode's card the browser itself starts the
// video five seconds before the episode and pauses at its end (the #t= on
// its address); on a session's page it plays the whole recording. This wires
// up the buttons beside it, which deck.js presses for their keys, and the
// clock on each transcript line. Times come in data- attributes, in ms.
(function () {
  const video = document.querySelector('[data-player]');
  if (!video) return;
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
  const shown = document.querySelector('[data-rate-shown]');

  // The speed carries from one card to the next, for this tab only.
  let rate = 1;
  try { rate = Number(sessionStorage.getItem('annotate-rate')) || 1; } catch (e) { /* storage blocked */ }
  if (!RATES.includes(rate)) rate = 1;

  function speed(next) {
    rate = next;
    video.defaultPlaybackRate = rate;  // survives the browser reloading the video
    video.playbackRate = rate;
    shown.textContent = `${rate}×`;
    try { sessionStorage.setItem('annotate-rate', String(rate)); } catch (e) { /* storage blocked */ }
  }

  function play(seconds) {
    if (seconds !== undefined) video.currentTime = seconds;
    video.play().catch(() => {});  // refused until the page has been touched; the button still works
  }

  speed(rate);
  document.querySelector('[data-play]').addEventListener('click', () => (video.paused ? play() : video.pause()));
  const replay = document.querySelector('[data-replay]');
  if (replay) replay.addEventListener('click', () => play(Number(video.dataset.from) / 1000));
  document.querySelectorAll('[data-skip]').forEach((button) => button.addEventListener('click', () => {
    video.currentTime = Math.max(0, video.currentTime + Number(button.dataset.skip));
  }));
  document.querySelectorAll('[data-rate]').forEach((button) => button.addEventListener('click', () => {
    const i = RATES.indexOf(rate) + Number(button.dataset.rate);
    speed(RATES[Math.min(RATES.length - 1, Math.max(0, i))]);
  }));
  document.querySelectorAll('[data-seek]').forEach((button) => button.addEventListener('click', () => {
    play(Number(button.dataset.seek) / 1000);
  }));
})();
