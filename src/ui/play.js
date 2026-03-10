import { togglePlay } from '../actions.js';
import { subscribe } from '../state.js';

export function createPlayBtn() {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-play';
  btn.title = 'Play/Pause (k)';
  btn.innerHTML = svgPlay();
  btn.addEventListener('click', togglePlay);

  subscribe(({ playing, buffering }) => {
    btn.innerHTML = buffering ? svgSpin() : playing ? svgPause() : svgPlay();
    btn.title = playing ? 'Pause (k)' : 'Play (k)';
  });

  return btn;
}

function svgPlay() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}
function svgPause() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
}
function svgSpin() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="kt-spin"><circle cx="12" cy="12" r="9" stroke-dasharray="30 60"/></svg>`;
}
