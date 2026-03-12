import { getPlayer } from './adapter.js';
import { state, setState } from './state.js';
import { savePrefs } from './prefs.js';

export function play() {
  if (!state.alive) return;
  getPlayer()?.play();
}

export function pause() {
  if (!state.alive) return;
  getPlayer()?.pause();
}

export function togglePlay() {
  if (!state.alive) return;
  state.playing ? pause() : play();
}

let _volSaveTimer = null;
export function setVolume(pct) {
  const p = getPlayer();
  if (!p) return;
  const v = Math.max(0, Math.min(100, pct));
  p.setVolume(v / 100);
  if (v > 0 && p.isMuted()) p.setMuted(false);
  clearTimeout(_volSaveTimer);
  _volSaveTimer = setTimeout(() => savePrefs({ volume: v }), 300);
}

export function setMuted(muted) {
  getPlayer()?.setMuted(muted);
}

export function toggleMute() {
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

export function setQuality(qualityObj) {
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

export function setRate(r) {
  const p = getPlayer();
  if (!p) return;
  p.setPlaybackRate(Math.max(0.25, Math.min(2, r)));
}

export function seekToLive() {
  const p = getPlayer();
  if (!p) return;
  const latency = p.getLiveLatency?.();
  if (latency == null || !isFinite(latency)) return;
  p.seekTo(p.getPosition() + latency);
}

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
      case 'ArrowUp': e.preventDefault(); setVolume(state.volume + 5); break;
      case 'ArrowDown': e.preventDefault(); setVolume(state.volume - 5); break;
      case 'f': toggleFullscreen(); break;
      case 'l': seekToLive(); break;
    }
  });
}
