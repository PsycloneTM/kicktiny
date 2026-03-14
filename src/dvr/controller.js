import { state, setState } from '../state.js';
import { getPlayer } from '../adapter.js';
import { dvr } from './discovery.js';
import { fetchDvrUrl } from '../api.js';

let _Hls        = null;
let _hls        = null;
let _dvrVideo   = null;
let _nativeVideo= null;
let _posTimer   = null;
let _durTimer   = null;
let _proTimer   = null;
let _initUrl    = null;
let _refreshing = false;
let _refreshFailures = 0;
const MAX_REFRESH_FAILURES = 3;
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000;
const REFRESH_TIMEOUT_MS   = 15 * 1000;

export function getDvrVideo() { return _dvrVideo; }
export function getDvrHls()   { return _hls; }

export function setDvrQuality(index) {
  if (!_hls) return;
  if (index === 'auto') {
    _hls.currentLevel = -1;
    setState({ dvrQuality: null });
  } else {
    _hls.currentLevel = index;
    const level = _hls.levels?.[index];
    setState({ dvrQuality: { name: level?.name || (level?.height + 'p') || String(index), index } });
  }
}

// ── hls.js loader ─────────────────────────────────────────────────────────────

function loadHlsJs() {
  return new Promise((resolve, reject) => {
    if (window.Hls) { resolve(window.Hls); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
    s.onload  = () => resolve(window.Hls);
    s.onerror = () => reject(new Error('hls.js failed to load'));
    document.head.appendChild(s);
  });
}

function _createHlsInstance(url) {
  if (_hls) { _hls.destroy(); _hls = null; }

  _hls = new _Hls({
    enableWorker:         true,
    lowLatencyMode:       false,
    autoStartLoad:        true,
    liveDurationInfinity: false,
  });

  _hls.loadSource(url);
  _hls.attachMedia(_dvrVideo);

  _hls.on(_Hls.Events.MANIFEST_PARSED, (_, data) => {
    const dvrQualities = data.levels
      .map((l, i) => ({
        name:  l.name || (l.height + 'p') || String(i),
        index: i,
      }))
      .reverse();
    console.log('[KickTiny DVR] Manifest parsed —', dvrQualities.map(q => q.name).join(', '));
    setState({ dvrAvailable: true, dvrQualities });
    _startDurationPoll();
  });

  _hls.on(_Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;

    const isPlaylistError = (
      data.type === _Hls.ErrorTypes.NETWORK_ERROR &&
      (data.details === _Hls.ErrorDetails.MANIFEST_LOAD_ERROR      ||
       data.details === _Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT    ||
       data.details === _Hls.ErrorDetails.LEVEL_LOAD_ERROR         ||
       data.details === _Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT)
    );

    if (isPlaylistError && !_refreshing) {
      console.warn('[KickTiny DVR] Fatal playlist error — attempting token refresh:', data.details);
      _refreshDvrUrl();
    } else if (!isPlaylistError) {
      console.error('[KickTiny DVR] Fatal media error:', data.details);
      _hls.recoverMediaError();
    }
  });
}

// ── cleanup ───────────────────────────────────────────────────────────────────

function _destroy() {
  _stopPositionPoll();
  clearInterval(_durTimer); _durTimer = null;
  clearTimeout(_proTimer);  _proTimer = null;
  _refreshing = false;
  _refreshFailures = 0;
  if (_hls)      { _hls.destroy(); _hls = null; }
  if (_dvrVideo) { _dvrVideo.remove(); _dvrVideo = null; }
  _initUrl = null;
  setState({ dvrAvailable: false, dvrDuration: 0, dvrPosition: 0, dvrQualities: [], dvrQuality: null });
}

// ── init ──────────────────────────────────────────────────────────────────────

export async function initDvrController(container, dvrUrl) {
  if (_initUrl === dvrUrl) return;
  if (_initUrl !== null) _destroy();

  _initUrl     = dvrUrl;
  _nativeVideo = container.querySelector('video');

  if (!_nativeVideo) {
    console.warn('[KickTiny DVR] No native video found in container');
    return;
  }

  const cs = window.getComputedStyle(container);
  if (cs.position === 'static') container.style.position = 'relative';

  try {
    _Hls = await loadHlsJs();
  } catch (e) {
    console.warn('[KickTiny DVR] hls.js load failed:', e.message);
    return;
  }

  if (!_Hls.isSupported()) {
    console.warn('[KickTiny DVR] hls.js not supported in this browser');
    return;
  }

  _dvrVideo = document.createElement('video');
  _dvrVideo.playsInline = true;
  _dvrVideo.style.cssText = [
    'position:absolute', 'inset:0', 'width:100%', 'height:100%',
    'display:none', 'z-index:2', 'background:#000',
  ].join(';');
  container.appendChild(_dvrVideo);

  _dvrVideo.addEventListener('playing',      () => { if (state.engine === 'dvr') setState({ playing: true,  buffering: false }); });
  _dvrVideo.addEventListener('pause',        () => { if (state.engine === 'dvr') setState({ playing: false }); });
  _dvrVideo.addEventListener('waiting',      () => { if (state.engine === 'dvr') setState({ buffering: true }); });
  _dvrVideo.addEventListener('volumechange', () => { if (state.engine === 'dvr') setState({ volume: Math.round(_dvrVideo.volume * 100), muted: _dvrVideo.muted }); });

  _createHlsInstance(dvrUrl);

  _proTimer = setTimeout(() => {
    if (!_refreshing) {
      console.log('[KickTiny DVR] Proactive token refresh triggered');
      _refreshDvrUrl();
    }
  }, PROACTIVE_REFRESH_MS);

  console.log('[KickTiny DVR] Controller initialised');
}

// ── token refresh ─────────────────────────────────────────────────────────────

async function _refreshDvrUrl() {
  if (_refreshing) return;
  _refreshing = true;

  if (!dvr.vodId) {
    console.warn('[KickTiny DVR] No vodId — cannot refresh');
    _refreshing = false;
    return;
  }

  if (_refreshFailures >= MAX_REFRESH_FAILURES) {
    console.error('[KickTiny DVR] Max refresh failures reached — DVR unavailable');
    setState({ dvrAvailable: false });
    _refreshing = false;
    return;
  }

  const newUrl = await fetchDvrUrl(dvr.vodId);
  if (!newUrl) {
    _refreshFailures++;
    console.warn(`[KickTiny DVR] Refresh failed (${_refreshFailures}/${MAX_REFRESH_FAILURES})`);
    _refreshing = false;
    return;
  }

  dvr.url  = newUrl;

  const savedPos     = _dvrVideo?.currentTime ?? 0;
  const wasInDvr     = state.engine === 'dvr';
  const savedQuality = state.dvrQuality;

  console.log('[KickTiny DVR] Token refreshed — rebuilding hls.js, restoring at', savedPos.toFixed(1), 's');

  _createHlsInstance(newUrl);

  const refreshTimeout = setTimeout(() => {
    if (_refreshing) {
      console.warn('[KickTiny DVR] Refresh timed out — unlocking');
      _refreshFailures++;
      _refreshing = false;
    }
  }, REFRESH_TIMEOUT_MS);

  const onParsed = () => {
    _hls.off(_Hls.Events.MANIFEST_PARSED, onParsed);
    clearTimeout(refreshTimeout);
    _initUrl = newUrl;
    _refreshFailures = 0;
    _refreshing = false;

    if (_dvrVideo && isFinite(savedPos) && savedPos > 0) {
      const dur = _dvrVideo.duration;
      _dvrVideo.currentTime = isFinite(dur) ? Math.min(savedPos, Math.max(0, dur - 1)) : savedPos;
    }

    if (savedQuality !== null && savedQuality?.index != null) {
      const levels = _hls?.levels ?? [];
      if (savedQuality.index < levels.length) {
        _hls.currentLevel = savedQuality.index;
        setState({ dvrQuality: savedQuality });
      }
    }

    if (wasInDvr) _dvrVideo?.play().catch(() => {});

    clearTimeout(_proTimer);
    _proTimer = setTimeout(() => {
      if (!_refreshing) _refreshDvrUrl();
    }, PROACTIVE_REFRESH_MS);

    console.log('[KickTiny DVR] Refresh complete, position restored to', savedPos.toFixed(1), 's');
  };

  _hls.on(_Hls.Events.MANIFEST_PARSED, onParsed);
}

// ── mode switching ────────────────────────────────────────────────────────────

export function enterDvrMode(seekTo) {
  if (!_dvrVideo || !_nativeVideo) return;
  if (state.engine === 'dvr') return;

  const p = getPlayer();
  if (p) p.setMuted(true);

  _nativeVideo.style.visibility = 'hidden';
  _dvrVideo.volume       = state.muted ? 0 : state.volume / 100;
  _dvrVideo.muted        = state.muted;
  _dvrVideo.playbackRate = state.rate;
  _dvrVideo.style.display = 'block';

  const doSeek = () => {
    if (seekTo != null && isFinite(seekTo) && _dvrVideo.seekable.length > 0) {
      _dvrVideo.currentTime = seekTo;
    }
    _dvrVideo.play().catch(() => {});
  };

  if (_dvrVideo.readyState >= 1) {
    doSeek();
  } else {
    _dvrVideo.addEventListener('loadedmetadata', doSeek, { once: true });
  }

  setState({ engine: 'dvr' });
  _startPositionPoll();

  if (state.quality !== null && state.dvrQualities?.length) {
    const match = state.dvrQualities.find(q => q.name === state.quality.name)
      || state.dvrQualities.find(q => q.name.replace(/\d+$/, '') === state.quality.name.replace(/\d+$/, ''));
    if (match) setDvrQuality(match.index);
  }

  console.log('[KickTiny DVR] Entered DVR mode');
}

export function exitDvrMode() {
  if (!_dvrVideo || !_nativeVideo) return;

  _dvrVideo.pause();
  _dvrVideo.style.display = 'none';
  _nativeVideo.style.visibility = 'visible';

  const p = getPlayer();
  if (p) {
    p.setMuted(state.muted);
    p.setVolume(state.volume / 100);

    if (state.dvrQuality !== null && state.qualities?.length) {
      const match = state.qualities.find(q => q.name === state.dvrQuality.name)
        || state.qualities.find(q => q.name.replace(/\d+$/, '') === state.dvrQuality.name.replace(/\d+$/, ''));
      if (match) {
        p.setAutoQualityMode(false);
        p.setQuality(match);
      }
    }
  }

  setState({ engine: 'ivs', atLiveEdge: true });
  _stopPositionPoll();
  console.log('[KickTiny DVR] Exited DVR mode — back to IVS live');
}

// ── DVR actions ───────────────────────────────────────────────────────────────

export function dvrSeek(seconds) {
  if (!_dvrVideo) return;
  _dvrVideo.currentTime = seconds;
}

export function dvrSeekToLive() { exitDvrMode(); }
export function getDvrDuration() { return _dvrVideo?.duration ?? 0; }
export function getDvrPosition() { return _dvrVideo?.currentTime ?? 0; }

// ── polling ───────────────────────────────────────────────────────────────────

function _startDurationPoll() {
  clearInterval(_durTimer);
  _durTimer = setInterval(() => {
    if (!_dvrVideo) return;
    const dur = _dvrVideo.duration;
    if (isFinite(dur) && dur > 0) setState({ dvrDuration: dur });
  }, 2000);
}

function _startPositionPoll() {
  _stopPositionPoll();
  _posTimer = setInterval(() => {
    if (!_dvrVideo || state.engine !== 'dvr') { _stopPositionPoll(); return; }
    const dur = _dvrVideo.duration;
    const pos = _dvrVideo.currentTime;
    setState({
      dvrDuration:  isFinite(dur) ? dur : 0,
      dvrPosition:  pos,
      atLiveEdge:   isFinite(dur) && (dur - pos) <= 5,
    });
  }, 500);
}

function _stopPositionPoll() {
  clearInterval(_posTimer);
  _posTimer = null;
}