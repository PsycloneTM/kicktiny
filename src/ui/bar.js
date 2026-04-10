import { createPlayBtn }       from './play-button.js';
import { createVolumeCtrl }    from './volume-control.js';
import { createQualityBtn }    from './quality-menu.js';
import { createSpeedBtn }      from './speed-menu.js';
import { createFullscreenBtn } from './fullscreen-button.js';
import { createInfo }          from './info.js';
import { createSeekbar }       from './seekbar.js';
import { CONTROLS_HIDE_DELAY_MS, CONTROLS_LEAVE_DELAY_MS } from '../constants.js';

export function createBar(store, actions, viewerInterceptor, api) {
  const bar = document.createElement('div');
  bar.className = 'kt-bar';

  const { live, wrap: infoWrap } = createInfo(store, actions, viewerInterceptor, api);

  const left = document.createElement('div'); left.className = 'kt-bar-left';
  left.append(createPlayBtn(store, actions), live, createVolumeCtrl(store, actions), infoWrap);

  const right = document.createElement('div'); right.className = 'kt-bar-right';
  right.append(createSpeedBtn(store, actions), createQualityBtn(store, actions), createFullscreenBtn(store, actions));

  const controls = document.createElement('div'); controls.className = 'kt-controls';
  controls.append(left, right);

  bar.append(createSeekbar(store, actions), controls);
  return bar;
}

export function initBarHover(root, bar, container, topBar, store) {
  let hideTimer   = null;

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
    hideTimer = setTimeout(() => { if (store.getState().playing) hide(); }, CONTROLS_HIDE_DELAY_MS);
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
    }, CONTROLS_LEAVE_DELAY_MS);
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

  // Only react to actual playing state changes — not every setState tick.
  // The position poll (500ms) and uptime ticker (1s) would otherwise reset
  // the hide timer on every tick, keeping the controls visible forever.
  store.select(
    s => ({ playing: s.playing }),
    ({ playing }) => {
      if (!playing) {
        clearTimeout(hideTimer);
        bar.classList.add('kt-bar-visible');
        if (topBar) topBar.classList.add('kt-top-bar-visible');
        root.classList.remove('kt-idle');
        container.classList.remove('kt-idle');
      } else {
        show();
      }
    }
  );
}
