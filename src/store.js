// ── store.js ──────────────────────────────────────────────────────────────────
// Creates the application state store. Call createStore() once in main.js and
// pass the returned object to every module that needs it.
//
// API:
//   store.getState()          → state object (treat as readonly outside store)
//   store.setState(patch)     → merge patch, notify subscribers on change
//   store.subscribe(fn)       → fn(state) on every change; returns unsub()
//   store.select(sel, cb)     → cb(slice) only when selected slice changes; returns unsub()

export function createStore() {
  const state = {
    // lifecycle
    engine:  'ivs',
    alive:   false,

    // DVR
    dvrAvailable:  false,
    uptimeSec:     0,
    dvrBehindLive: 0,
    dvrWindowSec:  0,
    dvrQualities:  [],
    dvrQuality:    null,

    // stream metadata
    vodId:           null,
    streamStartTime: null,

    // playback
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

    // channel
    username:    '',
    displayName: '',
    avatar:      '',
    viewers:     null,
    title:       null,
    error:       null,
  };

  const _knownKeys = new Set(Object.keys(state));
  const _listeners = new Set();

  // Handles primitives, flat arrays, and plain objects (e.g. quality objects).
  // Without object support, quality comparisons always fail reference equality,
  // causing unnecessary subscriber re-renders on every quality-changed event.
  function shallowEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (Array.isArray(a) && Array.isArray(b))
      return a.length === b.length && a.every((v, i) => v === b[i]);
    if (typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every(k => a[k] === b[k]);
    }
    return false;
  }

  function getState() { return { ...state }; }

  function setState(patch) {
    let changed = false;
    for (const k in patch) {
      if (!_knownKeys.has(k)) {
        console.warn(`[KickTiny] setState: unknown key "${k}" — typo?`);
        continue;
      }
      if (!shallowEqual(state[k], patch[k])) {
        state[k] = patch[k];
        changed = true;
      }
    }
    if (changed) _listeners.forEach(fn => fn(state));
  }

  function subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }

  // Fires callback only when the selected slice actually changes.
  // Use this in UI components to avoid re-renders from unrelated state updates
  // (e.g. the 500ms position poll or 1s uptime ticker).
  function select(selectorFn, callback) {
    let prev = selectorFn(state);
    return subscribe(s => {
      const next = selectorFn(s);
      if (!shallowEqual(prev, next)) { prev = next; callback(next, s); }
    });
  }

  return { getState, setState, subscribe, select };
}
