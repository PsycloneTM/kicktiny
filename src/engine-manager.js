// ── engine-manager.js ────────────────────────────────────────────────────────
// Coordinates the IVS and DVR engines. This is the key decoupling piece:
// it eliminates all if (inDvr()) checks from actions and UI components by
// exposing a single unified interface that delegates to whichever engine
// is currently active.
//
// Usage:
//   const engines = createEngineManager(store, prefs, api);
//   engines.init(container);
//   engines.play(); engines.setVolume(80);   // no engine awareness needed
//   engines.enterDvr(90);                    // switch to DVR 90s behind live
//   engines.exitDvr();                       // switch back to IVS live

import { createIvsEngine } from './engines/ivs-engine.js';
import { createDvrEngine  } from './engines/dvr-engine.js';

export function createEngineManager(store, prefs, api) {
  let _ivs      = null;
  let _dvr      = null;
  let _entering = false;  // race-condition guard on IVS→DVR transition

  function _active() {
    return store.getState().engine === 'dvr' ? _dvr : _ivs;
  }

  // ── Unified PlaybackEngine interface ───────────────────────────────────────
  // Actions and UI call these — they never know which engine is active.

  function play()         { _active()?.play?.(); }
  function pause()        { _active()?.pause?.(); }
  function setVolume(pct) { _active()?.setVolume?.(pct); }
  function setMuted(m)    { _active()?.setMuted?.(m); }
  function setRate(r)     { _active()?.setRate?.(r); }
  function setQuality(q)  { _active()?.setQuality?.(q); }
  function seekToLive() {
    if (store.getState().engine === 'dvr') {
      exitDvr();
    } else {
      _ivs.seekToLive();
    }
  }

  // ── DVR-specific ───────────────────────────────────────────────────────────

  async function enterDvr(behindSec) {
    if (_entering) {
      console.warn('[EngineManager] enterDvr already in progress — ignoring duplicate call');
      return;
    }
    const s = store.getState();
    if (!s.vodId) { console.warn('[EngineManager] enterDvr: no vodId'); return; }

    // If already in DVR, just seek to the requested position
    if (s.engine === 'dvr') {
      _dvr.seekToBehindLive(behindSec);
      return;
    }

    _entering = true;
    const rawPlayer = _ivs.getRawPlayer();
    const wasPlaying = s.playing;
    const wasVolume  = s.volume;
    const wasMuted   = s.muted;

    try {
      if (rawPlayer) rawPlayer.pause();
      await _dvr.enter(behindSec);
    } catch (e) {
      console.warn('[EngineManager] DVR entry failed:', e.message);
      // Restore IVS live playback on failure
      _dvr.exit();
      _restoreIvs(rawPlayer, wasPlaying, wasVolume, wasMuted);
    } finally {
      _entering = false;
    }
  }

  function exitDvr() {
    if (store.getState().engine !== 'dvr') return;
    const rawPlayer = _ivs.getRawPlayer();
    const s = store.getState();

    _dvr.exit();

    // Restore IVS quality and resume from near live edge
    if (rawPlayer) {
      rawPlayer.setVolume(s.volume / 100);
      rawPlayer.setMuted(s.muted);

      // Carry quality selection across the transition
      if (s.dvrQuality !== null && s.qualities?.length) {
        const match = s.qualities.find(q => q.name === s.dvrQuality.name)
          || s.qualities.find(q => q.name.replace(/\d+$/, '') === s.dvrQuality.name.replace(/\d+$/, ''));
        if (match) { rawPlayer.setAutoQualityMode(false); rawPlayer.setQuality(match); }
      }

      // Nudge playback head past accumulated latency
      try {
        const pos     = rawPlayer.getPosition?.() ?? 0;
        const latency = rawPlayer.getLiveLatency?.() ?? 0;
        if (isFinite(pos) && isFinite(latency) && latency > 0) rawPlayer.seekTo(pos + latency + 0.25);
      } catch (_) {}

      rawPlayer.play();
    }

    console.log('[EngineManager] Returned to IVS live');
  }

  function dvrSeekToBehindLive(sec) {
    if (store.getState().engine !== 'dvr') return;
    _dvr.seekToBehindLive(sec);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async function init(container) {
    _ivs = createIvsEngine(store, prefs);
    _dvr = createDvrEngine(store, api);

    _ivs.init();

    // Pre-create the DVR video element — no URL is fetched here.
    // DVR init happens lazily when the user seeks into the past.
    await _dvr.setupContainer(container).catch(e => {
      console.warn('[EngineManager] DVR container setup failed:', e.message);
    });
  }

  function destroy() {
    _ivs?.destroy();
    _dvr?.destroy();
  }

  function isInDvr() { return store.getState().engine === 'dvr'; }

  // ── private ────────────────────────────────────────────────────────────────

  function _restoreIvs(player, wasPlaying, wasVolume, wasMuted) {
    if (!player) return;
    player.setVolume(wasVolume / 100);
    player.setMuted(!!wasMuted);
    if (wasPlaying) player.play();
  }

  return {
    // Unified interface
    play, pause, setVolume, setMuted, setRate, setQuality, seekToLive,
    // DVR transitions
    enterDvr, exitDvr, dvrSeekToBehindLive,
    // Lifecycle
    init, destroy, isInDvr,
  };
}
