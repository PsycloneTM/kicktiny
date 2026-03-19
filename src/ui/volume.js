import { toggleMute, setVolume } from '../actions.js';
import { subscribe, state } from '../state.js';

export function createVolumeCtrl() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-vol-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-mute';
  btn.addEventListener('click', e => { e.stopPropagation(); toggleMute(); });

  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'kt-vol-slider-wrap';

  const slider = document.createElement('input');
  slider.type      = 'range';
  slider.className = 'kt-vol-slider';
  slider.min  = '0';
  slider.max  = '100';
  slider.step = '1';

  sliderWrap.appendChild(slider);
  wrap.append(btn, sliderWrap);

  // ── slider drag ─────────────────────────────────────────────────────────────
  let _dragging = false;

  slider.addEventListener('mousedown', () => {
    _dragging = true;
    const up = () => { _dragging = false; document.removeEventListener('mouseup', up); };
    document.addEventListener('mouseup', up);
  });

  slider.addEventListener('input', () => {
    setVolume(Number(slider.value));
    _updateFill(Number(slider.value));
  });

  // ── sync UI from state ───────────────────────────────────────────────────────

  function syncUi(volume, muted) {
    const isMuted = muted || volume === 0;
    btn.innerHTML = svgVol(isMuted);
    btn.title     = isMuted ? 'Unmute (m)' : 'Mute (m)';
    if (!_dragging) {
      const displayVal = isMuted ? 0 : volume;
      slider.value = displayVal;
      _updateFill(displayVal);
    }
  }

  function _updateFill(pct) {
    slider.style.setProperty('--kt-vol-pct', pct + '%');
  }

  subscribe(({ volume, muted }) => syncUi(volume, muted));
  syncUi(state.volume, state.muted);

  return wrap;
}

function svgVol(muted) {
  if (muted) {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
}
