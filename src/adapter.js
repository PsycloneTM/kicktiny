import { setState, state } from './state.js';
import { loadPrefs, KEYS } from './prefs.js';
import { enterDvrAtBehindLive } from './dvr/controller.js';

const EV = {
  STATE_CHANGED:         'PlayerStateChanged',
  QUALITY_CHANGED:       'PlayerQualityChanged',
  VOLUME_CHANGED:        'PlayerVolumeChanged',
  MUTED_CHANGED:         'PlayerMutedChanged',
  PLAYBACK_RATE_CHANGED: 'PlayerPlaybackRateChanged',
  ERROR:                 'PlayerError',
  RECOVERABLE_ERROR:     'PlayerRecoverableError',
};

const PS = {
  PLAYING:   'Playing',
  BUFFERING: 'Buffering',
};

let _player = null;
let _boundPlayer = null;
let _retryTimer = null;
let _latencyTimer = null;
const MAX_RETRIES = 40;
const RETRY_INTERVAL = 500;

const RECONNECT_CODES = new Set([-2, -3]);

export function getPlayer() { return _player; }

export function initAdapter() {
  clearTimeout(_retryTimer);
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
  const isPlayer = v =>
    v &&
    typeof v === 'object' &&
    typeof v.getState === 'function' &&
    typeof v.getQualities === 'function' &&
    typeof v.getQuality === 'function' &&
    typeof v.setQuality === 'function' &&
    typeof v.getVolume === 'function' &&
    typeof v.setVolume === 'function' &&
    typeof v.addEventListener === 'function';

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
  if (!p || _boundPlayer === p) return;
  _boundPlayer = p;

  const prefs = loadPrefs();

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

  if (prefs.volume !== null) p.setVolume(prefs.volume / 100);
  let qualityApplied = false;
  if (prefs.quality !== null) {
    qualityApplied = applyQualityPref(p, prefs.quality);
  }

  let _pausedAt = null;

  p.addEventListener(EV.STATE_CHANGED, e => {
    if (state.engine !== 'ivs') return;
    const ps = e?.state ?? e;
    const buffering = ps === PS.BUFFERING;
    const playing   = ps === PS.PLAYING;

    if (playing) {
      sessionStorage.removeItem('kt.reloads');
      // Resuming — check if paused long enough to enter DVR instead of live edge
      if (_pausedAt !== null) {
        const pausedMs = Date.now() - _pausedAt;
        _pausedAt = null;
        if (pausedMs > 30_000 && state.vodId) {
          // Use actual live latency as behindSec — IVS keeps buffering while paused
          // so latency reflects real distance behind live, not the pause duration
          const latency = p.getLiveLatency?.() ?? (pausedMs / 1000);
          const behindSec = isFinite(latency) && latency > 0 ? latency : pausedMs / 1000;
          console.log('[KickTiny] Long pause (' + Math.round(pausedMs / 1000) + 's) — entering DVR', behindSec.toFixed(1), 's behind live');
          p.pause();
          enterDvrAtBehindLive(behindSec);
          return;
        }
      }
    } else if (!playing && !buffering) {
      // Paused — record timestamp (only if not already set, i.e. not our own p.pause() call)
      if (_pausedAt === null) _pausedAt = Date.now();
    }

    setState({ playing, buffering });
  });

  let _reapplying = false;
  let _reapplyAttempts = 0;
  const MAX_REAPPLY = 3;

  p.addEventListener(EV.QUALITY_CHANGED, e => {
    if (state.engine !== 'ivs') return;
    const q = e?.name ? e : (e?.quality ?? null);
    const qs = p.getQualities();
    if (qs && qs.length) setState({ qualities: qs });

    if (!qualityApplied && prefs.quality !== null && qs && qs.length) {
      qualityApplied = applyQualityPref(p, prefs.quality);
      if (qualityApplied) return;
    }

    const savedName = localStorage.getItem(KEYS.quality);

    if (!state.autoQuality && savedName && q?.name !== savedName) {
      if (_reapplyAttempts >= MAX_REAPPLY) {
        _reapplying = false;
        _reapplyAttempts = 0;
        setState({ quality: q, autoQuality: state.autoQuality });
        return;
      }
      if (!_reapplying) {
        const all = qs || state.qualities;
        const match = all.find(x => x.name === savedName)
          || all.find(x => x.name.replace(/\d+$/, '') === savedName.replace(/\d+$/, ''));
        if (match) {
          _reapplying = true;
          _reapplyAttempts++;
          p.setAutoQualityMode(false);
          p.setQuality(match);
        } else {
          _reapplying = false;
          _reapplyAttempts = 0;
          setState({ quality: q, autoQuality: state.autoQuality });
        }
      }
      return;
    }

    _reapplying = false;
    _reapplyAttempts = 0;
    // Use state.autoQuality as source of truth rather than p.isAutoQualityMode()
    // because IVS briefly reports autoMode:true during rebuffer even when we just
    // called setAutoQualityMode(false) — this would corrupt state.autoQuality.
    setState({ quality: q, autoQuality: state.autoQuality });
  });

  p.addEventListener(EV.VOLUME_CHANGED, e => {
    if (state.engine !== 'ivs') return;
    const vol = typeof e === 'number' ? e : (e?.volume ?? p.getVolume());
    setState({ volume: Math.round(vol * 100) });
  });

  p.addEventListener(EV.MUTED_CHANGED, e => {
    if (state.engine !== 'ivs') return;
    const muted = typeof e === 'boolean' ? e : (e?.muted ?? p.isMuted());
    setState({ muted });
  });

  p.addEventListener(EV.PLAYBACK_RATE_CHANGED, e => {
    if (state.engine !== 'ivs') return;
    const rate = typeof e === 'number' ? e : (e?.playbackRate ?? p.getPlaybackRate());
    setState({ rate });
  });

  p.addEventListener(EV.ERROR, err => {
    if (state.engine !== 'ivs') return;
    setState({ error: err });
    console.error('[KickTiny] IVS Error:', err);

    // Transient bad M3U8 response — try replaying before giving up
    if (err?.type === 'ErrorInvalidData' && err?.source === 'MediaPlaylist') {
      console.warn('[KickTiny] Bad M3U8 response — attempting recovery play()');
      setTimeout(() => {
        try { p.play(); } catch (_) {
          console.warn('[KickTiny] Recovery failed — reloading page');
          window.location.reload();
        }
      }, 1500);
    }
  });

  p.addEventListener(EV.RECOVERABLE_ERROR, err => {
    const code = err?.code ?? null;
    if (RECONNECT_CODES.has(code)) {
      const key = 'kt.reloads';
      const count = Number(sessionStorage.getItem(key) || 0);
      if (count >= 3) {
        console.error('[KickTiny] Too many reload attempts, giving up.');
        sessionStorage.removeItem(key);
        return;
      }
      sessionStorage.setItem(key, String(count + 1));
      console.warn('[KickTiny] IVS fatal worker error, reloading... (attempt', count + 1, 'of 3)');
      setTimeout(() => window.location.reload(), 2000);
    }
  });

  document.addEventListener('fullscreenchange', () => {
    setState({ fullscreen: !!document.fullscreenElement });
  });

  setTimeout(() => {
    const qs = p.getQualities();
    if (qs && qs.length) {
      if (state.qualities.length === 0) setState({ qualities: qs });
      if (!qualityApplied && prefs.quality !== null) {
        qualityApplied = applyQualityPref(p, prefs.quality);
      }
    }
  }, 2000);

  clearInterval(_latencyTimer);
  _latencyTimer = setInterval(() => {
    if (state.engine !== 'ivs') return;
    try {
      const latency = p.getLiveLatency?.();
      if (latency == null || !isFinite(latency)) return;
      setState({ atLiveEdge: latency <= 3.5 });
    } catch (_) {}
  }, 1000);

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
    setState({ autoQuality: false, quality: match });
    return true;
  }
  return false;
}