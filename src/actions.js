import { getPlayer } from './adapter.js';
import { state, setState } from './state.js';
import { savePrefs } from './prefs.js';
import { getDvrVideo, dvrSeekToBehindLive, dvrSeekToLive, setDvrQuality, enterDvrAtBehindLive } from './dvr/controller.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function inDvr() { return state.engine === 'dvr'; }

// ── play / pause ──────────────────────────────────────────────────────────────

export function play() {
  if (inDvr()) {
    getDvrVideo()?.play().catch(() => {});
  } else {
    getPlayer()?.play();
  }
}

export function pause() {
  if (inDvr()) {
    getDvrVideo()?.pause();
  } else {
    getPlayer()?.pause();
  }
}

export function togglePlay() {
  state.playing ? pause() : play();
}

// ── volume / mute ─────────────────────────────────────────────────────────────

let _volSaveTimer = null;
export function setVolume(pct) {
  const v = Math.max(0, Math.min(100, pct));
  if (inDvr()) {
    const vid = getDvrVideo();
    if (!vid) return;
    vid.volume = v / 100;
    if (v > 0) vid.muted = false;
    setState({ volume: v, muted: vid.muted });
  } else {
    const p = getPlayer();
    if (!p) return;
    p.setVolume(v / 100);
    if (v > 0 && p.isMuted()) p.setMuted(false);
  }
  clearTimeout(_volSaveTimer);
  _volSaveTimer = setTimeout(() => savePrefs({ volume: v }), 300);
}

export function setMuted(muted) {
  if (inDvr()) {
    const vid = getDvrVideo();
    if (!vid) return;
    vid.muted = muted;
    setState({ muted });
  } else {
    getPlayer()?.setMuted(muted);
  }
}

export function toggleMute() {
  if (inDvr()) {
    const vid = getDvrVideo();
    if (!vid) return;
    if (state.muted || state.volume === 0) {
      const restore = state.volume > 0 ? state.volume : 5;
      vid.volume = restore / 100;
      vid.muted  = false;
      setState({ volume: restore, muted: false });
    } else {
      vid.muted = true;
      setState({ muted: true });
    }
  } else {
    const p = getPlayer();
    if (!p) return;
    if (state.muted || state.volume === 0) {
      const restore = state.volume > 0 ? state.volume : 5;
      p.setVolume(restore / 100);
      p.setMuted(false);
    } else {
      p.setMuted(true);
    }
  }
}

// ── quality ───────────────────────────────────────────────────────────────────

export function setQuality(qualityObj) {
  if (inDvr()) {
    setDvrQuality(qualityObj === 'auto' ? 'auto' : qualityObj);
    return;
  }
  const p = getPlayer();
  if (!p) return;
  if (qualityObj === 'auto') {
    p.setAutoQualityMode(true);
    setState({ autoQuality: true, quality: null });
    savePrefs({ quality: null });
  } else {
    p.setAutoQualityMode(false);
    p.setQuality(qualityObj);
    setState({ autoQuality: false, quality: qualityObj });
    savePrefs({ quality: qualityObj.name });
  }
}

// ── rate ──────────────────────────────────────────────────────────────────────

export function setRate(r) {
  const clamped = Math.max(0.25, Math.min(2, r));
  if (inDvr()) {
    const vid = getDvrVideo();
    if (!vid) return;
    vid.playbackRate = clamped;
    setState({ rate: clamped });
  } else {
    getPlayer()?.setPlaybackRate(clamped);
  }
}

// ── live edge ─────────────────────────────────────────────────────────────────

export function seekToLive() {
  if (inDvr()) {
    dvrSeekToLive();
    return;
  }
  const p = getPlayer();
  if (!p) return;
  const latency = p.getLiveLatency?.();
  if (latency == null || !isFinite(latency)) return;
  p.seekTo(p.getPosition() + latency + 0.25);
}

// ── fullscreen ────────────────────────────────────────────────────────────────

export function toggleFullscreen() {
  const container = document.querySelector('.aspect-video-responsive')
    || document.querySelector('div[class*="aspect-video"]')
    || document.body;
  if (!document.fullscreenElement) {
    container.requestFullscreen?.()?.catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// ── keyboard ──────────────────────────────────────────────────────────────────

let _keysBound = false;
export function bindKeys() {
  if (_keysBound) return;
  _keysBound = true;
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ':
      case 'k': e.preventDefault(); togglePlay(); break;
      case 'm': toggleMute(); break;
      case 'ArrowUp':    e.preventDefault(); setVolume(state.volume + 5); break;
      case 'ArrowDown':  e.preventDefault(); setVolume(state.volume - 5); break;
      case 'ArrowLeft':
        e.preventDefault();
        if (inDvr()) {
          dvrSeekToBehindLive(state.dvrBehindLive + 10);
        } else if (state.vodId) {
          enterDvrAtBehindLive(60);
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (inDvr()) {
          const next = Math.max(0, state.dvrBehindLive - 10);
          if (next <= 30) seekToLive();
          else dvrSeekToBehindLive(next);
        }
        break;
      case 'f': toggleFullscreen(); break;
      case 'l': seekToLive(); break;
    }
  });
}
