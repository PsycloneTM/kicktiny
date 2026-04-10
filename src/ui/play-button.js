import { svgPlay, svgPause, svgSpin } from './icons.js';

export function createPlayBtn(store, actions) {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-play';
  btn.title = 'Play/Pause (k)';
  btn.innerHTML = svgPlay();
  btn.addEventListener('click', actions.togglePlay);

  // select() fires only when playing or buffering changes — the 500ms position
  // poll and 1s uptime ticker no longer trigger needless DOM updates here.
  store.select(
    s => ({ playing: s.playing, buffering: s.buffering }),
    ({ playing, buffering }) => {
      btn.innerHTML = buffering ? svgSpin() : playing ? svgPause() : svgPlay();
      btn.title = playing ? 'Pause (k)' : 'Play (k)';
    }
  );

  return btn;
}
