// ── engines/ivs-engine.js ────────────────────────────────────────────────────
// IVS player adapter. Extracted from adapter.js.
// Receives the store and prefs as constructor parameters — no global imports.
//
// Usage:
//   const ivs = createIvsEngine(store, prefs);
//   ivs.init();
//   ivs.play(); ivs.setVolume(80); ...
//   ivs.destroy();

import {
  LIVE_EDGE_LATENCY_SEC,
  ADAPTER_RETRY_INTERVAL_MS,
  ADAPTER_MAX_RETRIES,
  LATENCY_POLL_INTERVAL_MS,
  MAX_REAPPLY_ATTEMPTS,
  MAX_RELOAD_ATTEMPTS,
  RECONNECT_CODES,
} from '../constants.js';

const EV = {
  STATE_CHANGED:         'PlayerStateChanged',
  QUALITY_CHANGED:       'PlayerQualityChanged',
  VOLUME_CHANGED:        'PlayerVolumeChanged',
  MUTED_CHANGED:         'PlayerMutedChanged',
  PLAYBACK_RATE_CHANGED: 'PlayerPlaybackRateChanged',
  ERROR:                 'PlayerError',
  RECOVERABLE_ERROR:     'PlayerRecoverableError',
};
const PS = { PLAYING: 'Playing', BUFFERING: 'Buffering' };

export function createIvsEngine(store, prefs) {
  let _player      = null;
  let _boundPlayer = null;
  let _retryTimer  = null;
  let _latencyTimer = null;

  // ── extraction ─────────────────────────────────────────────────────────────

  function init() {
    clearTimeout(_retryTimer);
    _tryExtract(0);
  }

  function _tryExtract(attempt) {
    const p = _extractPlayer();
    if (p) { _player = p; _onPlayerReady(); return; }
    if (attempt < ADAPTER_MAX_RETRIES) {
      _retryTimer = setTimeout(() => _tryExtract(attempt + 1), ADAPTER_RETRY_INTERVAL_MS);
    } else {
      console.warn('[KickTiny] Could not find IVS player after', ADAPTER_MAX_RETRIES, 'attempts');
    }
  }

  function _extractPlayer() {
    try {
      const video = document.querySelector('video');
      if (!video) return null;
      const fiberKey = Object.keys(video).find(k => k.startsWith('__reactFiber'));
      if (!fiberKey) return null;
      return _walkFiber(video[fiberKey]);
    } catch (e) {
      // The fiber walk can throw on partially-constructed React trees — recoverable.
      console.warn('[KickTiny] extractPlayer error (will retry):', e.message);
    }
    return null;
  }

  function _walkFiber(fiber) {
    const isPlayer = v =>
      v && typeof v === 'object' &&
      typeof v.getState === 'function' &&
      typeof v.getQualities === 'function' &&
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

  // ── player ready ───────────────────────────────────────────────────────────

  function _onPlayerReady() {
    const p = _player;
    if (!p || _boundPlayer === p) return;
    _boundPlayer = p;

    const savedPrefs = prefs.load();
    const vol = savedPrefs.volume !== null ? savedPrefs.volume : Math.round(p.getVolume() * 100);

    store.setState({
      alive:       true,
      playing:     p.getState() === PS.PLAYING,
      buffering:   p.getState() === PS.BUFFERING,
      qualities:   p.getQualities() || [],
      quality:     p.getQuality(),
      autoQuality: p.isAutoQualityMode(),
      volume:      vol,
      muted:       p.isMuted(),
      rate:        p.getPlaybackRate(),
    });

    if (savedPrefs.volume !== null) p.setVolume(savedPrefs.volume / 100);
    let qualityApplied = false;
    if (savedPrefs.quality !== null) qualityApplied = _applyQualityPref(p, savedPrefs.quality);

    let _reapplying = false;
    let _reapplyAttempts = 0;

    p.addEventListener(EV.STATE_CHANGED, e => {
      const s = store.getState();
      if (s.engine !== 'ivs') return;
      const ps        = e?.state ?? e;
      const buffering = ps === PS.BUFFERING;
      const playing   = ps === PS.PLAYING;

      if (playing) {
        sessionStorage.removeItem('kt.reloads');
      }

      store.setState({ playing, buffering });
    });

    p.addEventListener(EV.QUALITY_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      const q  = e?.name ? e : (e?.quality ?? null);
      const qs = p.getQualities();
      if (qs?.length) store.setState({ qualities: qs });

      if (!qualityApplied && savedPrefs.quality !== null && qs?.length) {
        qualityApplied = _applyQualityPref(p, savedPrefs.quality);
        if (qualityApplied) return;
      }

      const savedName = prefs.load().quality;
      const st        = store.getState();

      if (!st.autoQuality && savedName && q?.name !== savedName) {
        if (_reapplyAttempts >= MAX_REAPPLY_ATTEMPTS) {
          _reapplying = false; _reapplyAttempts = 0;
          store.setState({ quality: q, autoQuality: st.autoQuality });
          return;
        }
        if (!_reapplying) {
          const all   = qs || st.qualities;
          const match = all.find(x => x.name === savedName)
            || all.find(x => x.name.replace(/\d+$/, '') === savedName.replace(/\d+$/, ''));
          if (match) {
            _reapplying = true; _reapplyAttempts++;
            p.setAutoQualityMode(false); p.setQuality(match);
          } else {
            _reapplying = false; _reapplyAttempts = 0;
            store.setState({ quality: q, autoQuality: st.autoQuality });
          }
        }
        return;
      }

      _reapplying = false; _reapplyAttempts = 0;
      store.setState({ quality: q, autoQuality: st.autoQuality });
    });

    p.addEventListener(EV.VOLUME_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      const vol = typeof e === 'number' ? e : (e?.volume ?? p.getVolume());
      store.setState({ volume: Math.round(vol * 100) });
    });

    p.addEventListener(EV.MUTED_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      store.setState({ muted: typeof e === 'boolean' ? e : (e?.muted ?? p.isMuted()) });
    });

    p.addEventListener(EV.PLAYBACK_RATE_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      store.setState({ rate: typeof e === 'number' ? e : (e?.playbackRate ?? p.getPlaybackRate()) });
    });

    p.addEventListener(EV.ERROR, err => {
      if (store.getState().engine !== 'ivs') return;
      store.setState({ error: err });
      console.error('[KickTiny] IVS Error:', err);
      if (err?.type === 'ErrorInvalidData' && err?.source === 'MediaPlaylist') {
        console.warn('[KickTiny] Bad M3U8 — attempting recovery play()');
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
        const key   = 'kt.reloads';
        const count = Number(sessionStorage.getItem(key) || 0);
        if (count >= MAX_RELOAD_ATTEMPTS) {
          console.error('[KickTiny] Too many reload attempts, giving up.');
          sessionStorage.removeItem(key);
          return;
        }
        sessionStorage.setItem(key, String(count + 1));
        console.warn('[KickTiny] IVS fatal worker error, reloading... (attempt', count + 1, 'of', MAX_RELOAD_ATTEMPTS, ')');
        setTimeout(() => window.location.reload(), 2000);
      }
    });

    document.addEventListener('fullscreenchange', () => {
      store.setState({ fullscreen: !!document.fullscreenElement });
    });

    // Fallback quality init after 2s (IVS may not have fired QUALITY_CHANGED yet)
    setTimeout(() => {
      const qs = p.getQualities();
      if (qs?.length) {
        if (!store.getState().qualities.length) store.setState({ qualities: qs });
        if (!qualityApplied && savedPrefs.quality !== null) qualityApplied = _applyQualityPref(p, savedPrefs.quality);
      }
    }, 2000);

    clearInterval(_latencyTimer);
    _latencyTimer = setInterval(() => {
      if (store.getState().engine !== 'ivs') return;
      try {
        const latency = p.getLiveLatency?.();
        if (latency == null || !isFinite(latency)) return;
        store.setState({ atLiveEdge: latency <= LIVE_EDGE_LATENCY_SEC });
      } catch (_) {}
    }, LATENCY_POLL_INTERVAL_MS);

    console.log('[KickTiny] Adapter ready. IVS player attached.');
  }

  function _applyQualityPref(p, savedName) {
    const qs = p.getQualities();
    if (!qs?.length) return false;
    const stripped = savedName.replace(/\d+$/, '');
    const match    = qs.find(q => q.name === savedName)
      || qs.find(q => q.name.replace(/\d+$/, '') === stripped);
    if (match) {
      p.setAutoQualityMode(false);
      p.setQuality(match);
      store.setState({ autoQuality: false, quality: match });
      return true;
    }
    return false;
  }

  // ── PlaybackEngine interface ───────────────────────────────────────────────

  function play()  { _player?.play(); }
  function pause() { _player?.pause(); }

  function setVolume(pct) {
    if (!_player) return;
    _player.setVolume(pct / 100);
    if (pct > 0 && _player.isMuted()) _player.setMuted(false);
  }

  function setMuted(m)  { _player?.setMuted(m); }
  function setRate(r)   { _player?.setPlaybackRate(r); }

  function setQuality(q) {
    if (!_player) return;
    if (q === 'auto') {
      _player.setAutoQualityMode(true);
      store.setState({ autoQuality: true, quality: null });
      prefs.save({ quality: null });
    } else {
      _player.setAutoQualityMode(false);
      _player.setQuality(q);
      store.setState({ autoQuality: false, quality: q });
      prefs.save({ quality: q.name });
    }
  }

  function seekToLive() {
    if (!_player) return;
    _player.setPlaybackRate(2);
    const check = setInterval(() => {
      const lat = _player.getLiveLatency?.();
      if (lat == null || !isFinite(lat) || lat <= LIVE_EDGE_LATENCY_SEC) {
        _player.setPlaybackRate(1);
        clearInterval(check);
      }
    }, 250);
  }

  /** Escape hatch for engine-manager to restore state after DVR→IVS transition. */
  function getRawPlayer() { return _player; }

  function destroy() {
    clearTimeout(_retryTimer);
    clearInterval(_latencyTimer);
    _player = null; _boundPlayer = null;
  }

  return { init, destroy, play, pause, setVolume, setMuted, setRate, setQuality, seekToLive, getRawPlayer };
}
