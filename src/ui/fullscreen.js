import { toggleFullscreen } from '../actions.js';
import { subscribe } from '../state.js';

export function createFullscreenBtn() {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-fs';
  btn.title = 'Fullscreen (f)';
  btn.innerHTML = svgExpand();
  btn.addEventListener('click', toggleFullscreen);

  subscribe(({ fullscreen }) => {
    btn.innerHTML = fullscreen ? svgCompress() : svgExpand();
    btn.title = fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
  });

  return btn;
}

function svgExpand() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
}
function svgCompress() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;
}
