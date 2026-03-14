import { createPlayBtn } from './play.js';
import { createVolumeCtrl } from './volume.js';
import { createQualityBtn } from './quality.js';
import { createSpeedBtn } from './speed.js';
import { createFullscreenBtn } from './fullscreen.js';
import { createInfo } from './info.js';
import { createSeekbar } from './seekbar.js';
import { subscribe, state } from '../state.js';

export function createBar() {
  const bar = document.createElement('div');
  bar.className = 'kt-bar';

  const seekbar = createSeekbar();

  const controls = document.createElement('div');
  controls.className = 'kt-controls';

  const left = document.createElement('div');
  left.className = 'kt-bar-left';
  left.append(createPlayBtn(), createVolumeCtrl(), createInfo());

  const right = document.createElement('div');
  right.className = 'kt-bar-right';
  right.append(createSpeedBtn(), createQualityBtn(), createFullscreenBtn());

  controls.append(left, right);
  bar.append(seekbar, controls);
  return bar;
}

export function initBarHover(root, bar, container, topBar) {
  let hideTimer = null;

  const show = () => {
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
    root.classList.remove('kt-idle');
    container.classList.remove('kt-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (state.playing) {
        bar.classList.remove('kt-bar-visible');
        if (topBar) topBar.classList.remove('kt-top-bar-visible');
        root.classList.add('kt-idle');
        container.classList.add('kt-idle');
      }
    }, 3000);
  };

  let _moveRaf = 0;
  container.addEventListener('mousemove', () => {
    if (_moveRaf) return;
    _moveRaf = requestAnimationFrame(() => { show(); _moveRaf = 0; });
  });

  container.addEventListener('mouseleave', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      bar.classList.remove('kt-bar-visible');
      if (topBar) topBar.classList.remove('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
    }, 500);
  });

  bar.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
  });

  if (topBar) {
    topBar.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      topBar.classList.add('kt-top-bar-visible');
      bar.classList.add('kt-bar-visible');
    });
  }

  subscribe(({ playing }) => {
    if (!playing) {
      bar.classList.add('kt-bar-visible');
      if (topBar) topBar.classList.add('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
      clearTimeout(hideTimer);
    } else {
      show();
    }
  });
}