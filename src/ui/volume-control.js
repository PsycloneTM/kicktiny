import { svgVolume } from './icons.js';

export function createVolumeCtrl(store, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'kt-vol-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-mute';
  btn.addEventListener('click', e => { e.stopPropagation(); actions.toggleMute(); });

  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'kt-vol-slider-wrap';

  const slider = document.createElement('input');
  slider.type = 'range'; slider.className = 'kt-vol-slider';
  slider.min = '0'; slider.max = '100'; slider.step = '1';

  sliderWrap.appendChild(slider);
  wrap.append(btn, sliderWrap);

  let _dragging = false;
  slider.addEventListener('mousedown', () => {
    _dragging = true;
    const up = () => { _dragging = false; document.removeEventListener('mouseup', up); };
    document.addEventListener('mouseup', up);
  });
  slider.addEventListener('input', () => {
    actions.setVolume(Number(slider.value));
    _updateFill(Number(slider.value));
  });

  function syncUi(volume, muted) {
    const isMuted = muted || volume === 0;
    btn.innerHTML = svgVolume(isMuted);
    btn.title     = isMuted ? 'Unmute (m)' : 'Mute (m)';
    if (!_dragging) { slider.value = isMuted ? 0 : volume; _updateFill(isMuted ? 0 : volume); }
  }

  function _updateFill(pct) { slider.style.setProperty('--kt-vol-pct', pct + '%'); }

  // Only re-render when volume or muted actually changes
  store.select(
    s => ({ volume: s.volume, muted: s.muted }),
    ({ volume, muted }) => syncUi(volume, muted)
  );
  syncUi(store.getState().volume, store.getState().muted);

  return wrap;
}
