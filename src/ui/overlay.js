export function createOverlay(store, actions) {
  const overlay = document.createElement('div');
  overlay.className = 'kt-overlay';
  overlay.innerHTML = `
    <button class="kt-overlay-btn" title="Play (k)">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </button>
  `;

  overlay.querySelector('button').addEventListener('click', actions.togglePlay);

  store.select(
    s => ({ alive: s.alive, playing: s.playing, buffering: s.buffering }),
    ({ alive, playing, buffering }) => {
      overlay.classList.toggle('kt-overlay-hidden', !alive || playing || buffering);
    }
  );

  return overlay;
}
