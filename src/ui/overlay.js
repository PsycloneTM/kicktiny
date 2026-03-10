import { togglePlay, toggleFullscreen } from '../actions.js';
import { subscribe } from '../state.js';

export function createOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'kt-overlay';
  overlay.innerHTML = `
    <button class="kt-overlay-btn" title="Play (k)">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>
    </button>
  `;
  overlay.querySelector('button').addEventListener('click', togglePlay);
  overlay.addEventListener('dblclick', toggleFullscreen); // fix: was dynamic import()

  subscribe(({ playing, buffering }) => {
    overlay.classList.toggle('kt-overlay-hidden', playing || buffering);
  });

  return overlay;
}
