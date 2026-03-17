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

  const { live, wrap: infoWrap } = createInfo();

  const left = document.createElement('div');
  left.className = 'kt-bar-left';
  left.append(createPlayBtn(), live, createVolumeCtrl(), infoWrap);

  const right = document.createElement('div');
  right.className = 'kt-bar-right';
  right.append(createSpeedBtn(), createQualityBtn(), createFullscreenBtn());

  controls.append(left, right);
  bar.append(seekbar, controls);
  return bar;
}

export function initBarHover(root, bar, container, topBar) {
  let hideTimer = null;
  let _lastPlaying = state.playing;

  function hide() {
    bar.classList.remove('kt-bar-visible');
    if (topBar) topBar.classList.remove('kt-top-bar-visible');
    root.classList.add('kt-idle');
    container.classList.add('kt-idle');
  }

  function show() {
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
    root.classList.remove('kt-idle');
    container.classList.remove('kt-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (state.playing) hide();
    }, 3000);
  }

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

  // Only react to actual changes in playing state — not every setState call.
  // The position poll (500ms) and uptime ticker (1s) call setState constantly,
  // which would otherwise call show() on every tick and reset the hide timer forever.
  subscribe(({ playing }) => {
    if (playing === _lastPlaying) return;
    _lastPlaying = playing;

    if (!playing) {
      // Paused — show bars permanently until user plays again
      clearTimeout(hideTimer);
      bar.classList.add('kt-bar-visible');
      if (topBar) topBar.classList.add('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
    } else {
      // Started playing — begin auto-hide countdown
      show();
    }
  });
}