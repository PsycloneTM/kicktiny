import { svgExpand, svgCompress } from './icons.js';

export function createFullscreenBtn(store, actions) {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-fs';
  btn.title = 'Fullscreen (f)';
  btn.innerHTML = svgExpand();
  btn.addEventListener('click', actions.toggleFullscreen);

  store.select(
    s => ({ fullscreen: s.fullscreen }),
    ({ fullscreen }) => {
      btn.innerHTML = fullscreen ? svgCompress() : svgExpand();
      btn.title = fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
    }
  );

  return btn;
}
