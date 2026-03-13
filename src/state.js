export const state = {
  alive: false,
  playing: false,
  buffering: false,
  qualities: [],
  quality: null,
  autoQuality: true,
  volume: 50,
  muted: false,
  fullscreen: false,
  rate: 1,
  atLiveEdge: true,
  username: '',
  displayName: '',
  avatar: '',
  viewers: null,
  uptime: null,
  title: null,
  error: null,
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
