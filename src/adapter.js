import { setState, state } from './state.js';
import { loadPrefs, KEYS } from './prefs.js';

// IVS event string literals
const EV = {
  STATE_CHANGED:         'PlayerStateChanged',
  QUALITY_CHANGED:       'PlayerQualityChanged',
  VOLUME_CHANGED:        'PlayerVolumeChanged',
  MUTED_CHANGED:         'PlayerMutedChanged',
  PLAYBACK_RATE_CHANGED: 'PlayerPlaybackRateChanged',
  ERROR:                 'PlayerError',
  RECOVERABLE_ERROR:     'PlayerRecoverableError',
};

// IVS PlayerState string literals
const PS = {
  PLAYING:   'Playing',
  BUFFERING: 'Buffering',
};

let _player = null;
let _retryTimer = null;
const MAX_RETRIES = 40;
const RETRY_INTERVAL = 500;
const RECONNECT_CODES = new Set([-2, -3]);

export function getPlayer() { return _player; }

export function initAdapter() {
  tryExtract(0);
}

function tryExtract(attempt) {
  const p = extractPlayer();
  if (p) {
    _player = p;
    onPlayerReady();
    return;
  }
  if (attempt < MAX_RETRIES) {
    _retryTimer = setTimeout(() => tryExtract(attempt + 1), RETRY_INTERVAL);
  } else {
    console.warn('[KickTiny] Could not find IVS player after', MAX_RETRIES, 'attempts');
  }
}

function extractPlayer() {
  try {
    const video = document.querySelector('video');
    if (!video) return null;
    const fiberKey = Object.keys(video).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    return walkFiberForPlayer(video[fiberKey]);
  } catch (e) { /* keep trying */ }
  return null;
}

function walkFiberForPlayer(fiber) {
  const isPlayer = v => v && typeof v === 'object' && typeof v.getState === 'function'
    && typeof v.getQualities === 'function';

  const seen = new Set();

  function walkHooks(node) {
    let s = node?.memoizedState;
    while (s) {
      const val = s.memoizedState;
      if (isPlayer(val)) return val;
      if (val && typeof val === 'object' && isPlayer(val.current)) return val.current;
      if (val && typeof val === 'object') {
        try {
          for (const v of Object.values(val)) {
            if (isPlayer(v)) return v;
            if (v && typeof v === 'object' && isPlayer(v?.current)) return v.current;
          }
        } catch (_) {}
      }
      s = s.next;
    }
    return null;
  }

  function walk(node, depth) {
    if (!node || depth > 50 || seen.has(node)) return null;
    seen.add(node);
    if (isPlayer(node.stateNode)) return node.stateNode;
    const h = walkHooks(node);
    if (h) return h;
    return walk(node.return, depth + 1)
        || walk(node.child, depth + 1)
        || walk(node.sibling, depth + 1);
  }

  return walk(fiber, 0);
}

function onPlayerReady() {
  const p = _player;

  // Load saved prefs before reading player state
  const prefs = loadPrefs();

  // Sync initial state from player
  const vol = prefs.volume !== null ? prefs.volume : Math.round(p.getVolume() * 100);
  setState({
    alive: true,
    playing: p.getState() === PS.PLAYING,
    buffering: p.getState() === PS.BUFFERING,
    qualities: p.getQualities() || [],
    quality: p.getQuality(),
    autoQuality: p.isAutoQualityMode(),
    volume: vol,
    muted: p.isMuted(),
    rate: p.getPlaybackRate(),
  });

  // Apply saved prefs to player
  if (prefs.volume !== null) p.setVolume(prefs.volume / 100);
  let qualityApplied = false;
  if (prefs.quality !== null) {
    qualityApplied = applyQualityPref(p, prefs.quality);
  }

  p.addEventListener(EV.STATE_CHANGED, e => {
    const ps = e?.state ?? e;
    const buffering = ps === PS.BUFFERING;
    const playing = ps === PS.PLAYING;

    // If catching up and we hit buffering, we've reached live edge — reset
    if (buffering && state.catching) {
      p.setPlaybackRate(1);
      setState({ catching: false, rate: 1 });
    }

    setState({ playing, buffering });
  });

  let _reapplying = false;
  p.addEventListener(EV.QUALITY_CHANGED, e => {
    const q = e?.name ? e : (e?.quality ?? null);
    const qs = p.getQualities();
    if (qs && qs.length) setState({ qualities: qs });

    if (!qualityApplied && prefs.quality !== null && qs && qs.length) {
      qualityApplied = applyQualityPref(p, prefs.quality);
      if (qualityApplied) return;
    }

    const savedName = localStorage.getItem(KEYS.quality);

    // If IVS silently reset our quality, re-apply pref
    // Don't update UI state with the wrong quality
    if (!state.autoQuality && savedName && q?.name !== savedName) {
      if (!_reapplying) {
        const all = qs || state.qualities;
        const match = all.find(x => x.name === savedName)
          || all.find(x => x.name.replace(/\d+$/, '') === savedName.replace(/\d+$/, ''));
        if (match) {
          _reapplying = true;
          p.setAutoQualityMode(false);
          p.setQuality(match);
        } else {
          // Saved quality no longer available, accept whatever IVS gives us
          _reapplying = false;
          setState({ quality: q });
        }
      }
      return;
    }

    _reapplying = false;
    setState({ quality: q });
  });

  p.addEventListener(EV.VOLUME_CHANGED, e => {
    const vol = typeof e === 'number' ? e : (e?.volume ?? p.getVolume());
    setState({ volume: Math.round(vol * 100) });
  });

  p.addEventListener(EV.MUTED_CHANGED, e => {
    const muted = typeof e === 'boolean' ? e : (e?.muted ?? p.isMuted());
    setState({ muted });
  });

  p.addEventListener(EV.PLAYBACK_RATE_CHANGED, e => {
    const rate = typeof e === 'number' ? e : (e?.playbackRate ?? p.getPlaybackRate());
    setState({ rate });
  });

  p.addEventListener(EV.ERROR, err => {
    setState({ error: err });
    console.error('[KickTiny] IVS Error:', err);
  });

  p.addEventListener(EV.RECOVERABLE_ERROR, err => {
    const code = err?.code ?? null;
    if (RECONNECT_CODES.has(code)) {
      console.warn('[KickTiny] IVS fatal worker error, reloading...');
      setTimeout(() => window.location.reload(), 2000);
    }
  });

  document.addEventListener('fullscreenchange', () => {
    setState({ fullscreen: !!document.fullscreenElement });
  });

  //retry quality pref if qualities were empty at init
  setTimeout(() => {
    const qs = p.getQualities();
    if (qs && qs.length) {
      if (state.qualities.length === 0) setState({ qualities: qs });
      if (!qualityApplied && prefs.quality !== null) {
        qualityApplied = applyQualityPref(p, prefs.quality);
      }
    }
  }, 2000);

  console.log('[KickTiny] Adapter ready. IVS player attached.');
}

function applyQualityPref(p, savedName) {
  const qualities = p.getQualities();
  if (!qualities || !qualities.length) return false;
  let match = qualities.find(q => q.name === savedName);
  if (!match) {
    const stripped = savedName.replace(/\d+$/, '');
    match = qualities.find(q => q.name.replace(/\d+$/, '') === stripped);
  }
  if (match) {
    p.setAutoQualityMode(false);
    p.setQuality(match);
    setState({ autoQuality: false, quality: match }); // keep state in sync
    return true;
  }
  return false;
}
