// ── actions.js ───────────────────────────────────────────────────────────────
// High-level user-intent actions. The ONLY thing UI components import.
// No if (inDvr()) checks — that complexity lives in the engine manager.
//
// Usage:
//   const actions = createActions(store, engineManager, prefs);
//   actions.togglePlay();
//   actions.setVolume(80);
//   // pass to UI: createBar(store, actions)

import {
  LIVE_EDGE_BEHIND_SEC,
  VOLUME_SAVE_DEBOUNCE_MS,
  DOUBLE_CLICK_WINDOW_MS,
} from './constants.js';

export function createActions(store, engineManager, prefs) {

  // ── play / pause ────────────────────────────────────────────────────────────

  function play()  { engineManager.play(); }
  function pause() { engineManager.pause(); }

  function togglePlay() {
    store.getState().playing ? engineManager.pause() : engineManager.play();
  }

  // ── volume / mute ───────────────────────────────────────────────────────────

  let _volSaveTimer = null;

  function setVolume(pct) {
    const v = Math.max(0, Math.min(100, pct));
    engineManager.setVolume(v);
    clearTimeout(_volSaveTimer);
    _volSaveTimer = setTimeout(() => prefs.save({ volume: v }), VOLUME_SAVE_DEBOUNCE_MS);
  }

  function setMuted(m) { engineManager.setMuted(m); }

  function toggleMute() {
    const s = store.getState();
    if (s.muted || s.volume === 0) {
      const restore = s.volume > 0 ? s.volume : 5;
      engineManager.setVolume(restore);
      engineManager.setMuted(false);
    } else {
      engineManager.setMuted(true);
    }
  }

  // ── quality / rate ──────────────────────────────────────────────────────────

  function setQuality(q) { engineManager.setQuality(q); }

  function setRate(r) { engineManager.setRate(Math.max(0.25, Math.min(2, r))); }

  // ── live edge ───────────────────────────────────────────────────────────────

  function seekToLive() { engineManager.seekToLive(); }

  // ── DVR ─────────────────────────────────────────────────────────────────────

  function enterDvr(sec)            { engineManager.enterDvr(sec); }
  function dvrSeekToBehindLive(sec) { engineManager.dvrSeekToBehindLive(sec); }

  // ── fullscreen ──────────────────────────────────────────────────────────────

  function toggleFullscreen() {
    const container = document.querySelector('.aspect-video-responsive')
      || document.querySelector('div[class*="aspect-video"]')
      || document.body;
    if (!document.fullscreenElement) {
      container.requestFullscreen?.()?.catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  }

  // ── keyboard bindings ───────────────────────────────────────────────────────
  // Bound once in main.js via actions.bindKeys().

  let _keysBound = false;
  function bindKeys() {
    if (_keysBound) return;
    _keysBound = true;
    document.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = store.getState();
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); togglePlay(); break;
        case 'm': toggleMute(); break;
        case 'ArrowUp':   e.preventDefault(); setVolume(s.volume + 5); break;
        case 'ArrowDown': e.preventDefault(); setVolume(s.volume - 5); break;
        case 'ArrowLeft':
          e.preventDefault();
          if (s.engine === 'dvr') {
            dvrSeekToBehindLive(s.dvrBehindLive + 10);
          } else if (s.vodId) {
            enterDvr(60);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (s.engine === 'dvr') {
            const next = Math.max(0, s.dvrBehindLive - 10);
            if (next <= LIVE_EDGE_BEHIND_SEC) seekToLive();
            else dvrSeekToBehindLive(next);
          }
          break;
        case 'f': toggleFullscreen(); break;
        case 'l': seekToLive(); break;
      }
    });
  }

  return {
    play, pause, togglePlay,
    setVolume, setMuted, toggleMute,
    setQuality, setRate,
    seekToLive, enterDvr, dvrSeekToBehindLive,
    toggleFullscreen, bindKeys,
    DOUBLE_CLICK_WINDOW_MS, // exposed so main.js click handler can read it
  };
}
