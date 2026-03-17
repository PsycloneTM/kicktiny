export const state = {
  // playback engine
  engine: 'ivs',

  // DVR
  dvrAvailable:  false,
  uptimeSec:     0,       // total stream age in seconds (Date.now() - streamStartTime)
  dvrBehindLive: 0,       // seconds behind live edge (seekableEnd - currentTime)
  dvrWindowSec:  0,       // actual seekable DVR window (seekableEnd - seekableStart)
  dvrQualities:  [],
  dvrQuality:    null,

  // stream metadata
  vodId:           null,
  streamStartTime: null,  // ISO string, stable source for uptime calc

  // playback state
  playing:     false,
  buffering:   false,
  qualities:   [],
  quality:     null,
  autoQuality: true,
  volume:      50,
  muted:       false,
  fullscreen:  false,
  rate:        1,
  atLiveEdge:  true,

  // channel info
  username:    '',
  displayName: '',
  avatar:      '',
  viewers:     null,
  title:       null,
  error:       null,
};

const listeners = new Set();

function shallowEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

export function setState(patch) {
  let changed = false;
  for (const k in patch) {
    if (!shallowEqual(state[k], patch[k])) {
      state[k] = patch[k];
      changed = true;
    }
  }
  if (changed) listeners.forEach(fn => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}