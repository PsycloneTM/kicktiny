import { state, setState } from '../state.js';
import { getPlayer } from '../adapter.js';
import { fetchVodPlaybackUrl } from '../api.js';

let _Hls          = null;
let _hls          = null;
let _dvrVideo     = null;
let _nativeVideo  = null;
let _posTimer     = null;
let _expiryTimer  = null;
let _catchUpTimer = null;
let _refreshing   = false;
let _manifestOffset = 0;

// Segments array — replaces growing string for O(1) append and clean generation
// Each entry: { duration, url, pdt, discontinuity }
let _segments      = [];
let _lastSegUrl    = '';    // last known segment URL for overlap detection
let _targetDuration = 10;
let _lastSnapshotBase = '';

const SYNTHETIC_URL       = 'https://kt.local/dvr.m3u8';
const SEEKABLE_WAIT_MS    = 8  * 1000;
const EXPIRY_LEAD_MS      = 2  * 60 * 1000;
const FALLBACK_REFRESH_MS = 50 * 60 * 1000;
const CATCH_UP_INTERVAL   = 12500;
const NEAR_END_THRESHOLD  = 60;

export function getDvrVideo() { return _dvrVideo; }

// ── quality ───────────────────────────────────────────────────────────────────

export function setDvrQuality(index) {
  if (!_hls) return;
  if (index === 'auto') {
    const qualities = [...(state.dvrQualities || [])];
    const mid = qualities[Math.floor(qualities.length / 2)];
    if (mid) _switchDvrVariant(mid);
    setState({ dvrQuality: null });
  } else {
    const q = typeof index === 'object' ? index : state.dvrQualities?.find(q => q.index === index);
    if (q) _switchDvrVariant(q);
  }
}

async function _switchDvrVariant(q) {
  if (!state.vodId) return;
  const savedPos = _dvrVideo?.currentTime ?? 0;

  const vodUrl = await fetchVodPlaybackUrl(state.vodId);
  if (!vodUrl) return;

  const res  = await fetch(vodUrl);
  if (!res.ok) { console.warn('[KickTiny DVR] variant manifest fetch failed:', res.status); return; }
  const text = await res.text();
  if (!text.includes('#EXT-X-STREAM-INF')) return;

  const lines = text.split('\n');
  let variantUrl = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
    const nameMatch = t.match(/VIDEO="([^"]+)"/);
    if (nameMatch && nameMatch[1] === q.name) {
      const url = lines[i + 1]?.trim();
      if (url && !url.startsWith('#')) {
        variantUrl = url.startsWith('http') ? url : new URL(url, vodUrl).href;
        break;
      }
    }
  }
  if (!variantUrl) return;

  console.log('[KickTiny DVR] Switching to variant:', q.name);

  // Reset segments and rebuild from the new variant
  _segments = [];
  _lastSegUrl = '';
  const varRes  = await fetch(variantUrl);
  if (!varRes.ok) { console.warn('[KickTiny DVR] variant fetch failed:', varRes.status); return; }
  const varText = await varRes.text();
  _mergeSegments(varText, variantUrl);

  // Reschedule expiry for the new URL
  _scheduleExpiryRefresh(vodUrl);

  _destroyHls();
  _createHlsInstance();

  const onReady = () => {
    _dvrVideo.currentTime = savedPos;
    _dvrVideo.play().catch(() => {});
  };
  if (_dvrVideo.readyState >= 1) onReady();
  else _dvrVideo.addEventListener('loadedmetadata', onReady, { once: true });

  setState({ dvrQuality: q });
}

// ── hls.js loader ─────────────────────────────────────────────────────────────

function _loadHlsJs() {
  return new Promise((resolve, reject) => {
    if (window.Hls) { resolve(window.Hls); return; }
    const CDNS = [
      'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js',
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= CDNS.length) { reject(new Error('hls.js failed to load')); return; }
      const s = document.createElement('script');
      s.src = CDNS[idx++];
      s.onload  = () => window.Hls ? resolve(window.Hls) : tryNext();
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    }
    tryNext();
  });
}

// ── synthetic manifest ────────────────────────────────────────────────────────

function _buildManifestHeader() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    `#EXT-X-TARGETDURATION:${_targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ].join('\n') + '\n';
}

function _generateManifestString() {
  let out = _buildManifestHeader();
  for (const seg of _segments) {
    if (seg.discontinuity) out += '#EXT-X-DISCONTINUITY\n';
    if (seg.pdt)            out += seg.pdt + '\n';
    out += seg.duration + '\n';
    out += seg.url + '\n';
  }
  return out;
}

function _parseSegments(text, baseUrl) {
  const lines  = text.split('\n');
  const result = [];
  let duration     = null;
  let pdt          = null;
  let discontinuity = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#EXT-X-TARGETDURATION:')) {
      _targetDuration = parseInt(t.split(':')[1]) || _targetDuration;
      continue;
    }
    if (t === '#EXT-X-DISCONTINUITY') { discontinuity = true; continue; }
    if (t.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pdt = t; continue; }
    if (t.startsWith('#EXTINF:')) { duration = t; continue; }
    if (duration && t && !t.startsWith('#')) {
      const url = t.startsWith('http') ? t : new URL(t, baseUrl).href;
      result.push({ duration, url, pdt, discontinuity });
      duration = null; pdt = null; discontinuity = false;
    }
  }
  return result;
}

function _pickVariantUrl(multivariantText, baseUrl) {
  const lines   = multivariantText.split('\n');
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
    const resMatch  = t.match(/RESOLUTION=\d+x(\d+)/);
    const bwMatch   = t.match(/BANDWIDTH=(\d+)/);
    const nameMatch = t.match(/VIDEO="([^"]+)"/);
    const url       = lines[i + 1]?.trim();
    if (!url || url.startsWith('#')) continue;
    streams.push({
      url:       url.startsWith('http') ? url : new URL(url, baseUrl).href,
      height:    resMatch  ? parseInt(resMatch[1])  : 0,
      bandwidth: bwMatch   ? parseInt(bwMatch[1])   : 0,
      name:      nameMatch ? nameMatch[1]            : '',
    });
  }
  if (!streams.length) return baseUrl;

  const qualityName = state.quality?.name ?? null;
  if (qualityName) {
    let match = streams.find(s => s.name === qualityName);
    if (!match) {
      const stripped = qualityName.replace(/\d+$/, '');
      match = streams.find(s => s.name.replace(/\d+$/, '') === stripped);
    }
    if (match) { console.log('[KickTiny DVR] Picked variant:', match.name); return match.url; }
  }

  const sorted = [...streams].sort((a, b) => b.bandwidth - a.bandwidth);
  const pick   = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
  console.log('[KickTiny DVR] No quality match, picking middle variant:', pick.name);
  return pick.url;
}

function _mergeSegments(text, baseUrl) {
  _lastSnapshotBase = baseUrl;

  // Strip EXT-X-ENDLIST so our EVENT manifest stays open
  const cleaned  = text.replace(/#EXT-X-ENDLIST.*/g, '');
  const incoming = _parseSegments(cleaned, baseUrl);
  if (!incoming.length) return 0;

  // Overlap detection: find where incoming picks up from our last known segment
  // This is O(1) amortized — scan from the end of incoming for the last known URL
  let startIdx = 0;
  if (_lastSegUrl) {
    const overlapIdx = incoming.findLastIndex(s => s.url === _lastSegUrl);
    if (overlapIdx >= 0) {
      startIdx = overlapIdx + 1; // append only what's new
    } else {
      // No overlap found — incoming is completely new (e.g. quality switch)
      // Keep existing segments, append all incoming
      startIdx = 0;
    }
  }

  const newSegs = incoming.slice(startIdx);
  if (!newSegs.length) return 0;

  _segments.push(...newSegs);
  _lastSegUrl = _segments[_segments.length - 1].url;

  console.log('[KickTiny DVR] Merged', newSegs.length, 'new segments, total:', _segments.length,
    '\n  tail:', _lastSegUrl.split('/').slice(-1)[0]);
  return newSegs.length;
}

function _setDvrQualitiesFromMultivariant(text) {
  const lines   = text.split('\n');
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
    const nameMatch = t.match(/VIDEO="([^"]+)"/);
    const bwMatch   = t.match(/BANDWIDTH=(\d+)/);
    if (nameMatch) {
      streams.push({
        name:      nameMatch[1],
        index:     streams.length,
        bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
      });
    }
  }
  if (streams.length) {
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    streams.forEach((s, i) => { s.index = i; });
    setState({ dvrQualities: streams });
  }
}

async function _fetchAndMergeSnapshot(snapshotUrl) {
  try {
    const res  = await fetch(snapshotUrl);
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const text = await res.text();
    if (text.includes('#EXT-X-STREAM-INF')) {
      _setDvrQualitiesFromMultivariant(text);
      const playlistUrl = _pickVariantUrl(text, snapshotUrl);
      const varRes  = await fetch(playlistUrl);
      if (!varRes.ok) throw new Error(`variant playlist ${varRes.status}`);
      const varText = await varRes.text();
      return _mergeSegments(varText, playlistUrl);
    }
    return _mergeSegments(text, snapshotUrl);
  } catch (e) {
    console.warn('[KickTiny DVR] Snapshot fetch failed:', e.message);
    return 0;
  }
}

// ── segment extrapolation ─────────────────────────────────────────────────────
// The .ts URL pattern is predictable: only the segment number changes.
// PDT increments by _targetDuration seconds per segment.
// Add one segment at a time — called when we're near the end of loaded segments.

function _extrapolateNextSegment() {
  if (!_segments.length) return false;

  const last  = _segments[_segments.length - 1];
  const match = last.url.match(/^(.*\/)(\d+)\.ts$/);
  if (!match) {
    console.warn('[KickTiny DVR] Cannot extrapolate — URL pattern not recognized');
    return false;
  }

  const url = `${match[1]}${parseInt(match[2]) + 1}.ts`;

  // Compute next PDT from last one
  let pdt = null;
  if (last.pdt) {
    const pdtMatch = last.pdt.match(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/);
    if (pdtMatch) {
      const nextMs = new Date(pdtMatch[1]).getTime() + _targetDuration * 1000;
      pdt = `#EXT-X-PROGRAM-DATE-TIME:${new Date(nextMs).toISOString()}`;
    }
  }

  _segments.push({ duration: last.duration, url, pdt, discontinuity: false });
  _lastSegUrl = url;
  console.log('[KickTiny DVR] Extrapolated next segment:', url.split('/').slice(-1)[0]);
  return true;
}

// ── extend manifest (fetch fresh VOD JWT) — only called by expiry timer ────────

async function _fetchAndExtendManifest() {
  if (_refreshing || !state.vodId) return;
  _refreshing = true;
  console.log('[KickTiny DVR] Fetching fresh VOD URL (expiry refresh)');
  const newUrl = await fetchVodPlaybackUrl(state.vodId);
  if (newUrl) {
    await _fetchAndMergeSnapshot(newUrl);
    _scheduleExpiryRefresh(newUrl);
  }
  _refreshing = false;
}

// ── catch-up timer ────────────────────────────────────────────────────────────
// Uses segment extrapolation — zero network requests during normal catch-up

function _startCatchUpTimer() {
  if (_catchUpTimer) return;
  console.log('[KickTiny DVR] Entering catch-up mode (extrapolation)');
  _extrapolateNextSegment();
  _catchUpTimer = setInterval(() => {
    if (state.engine !== 'dvr') { _stopCatchUpTimer(); return; }
    const win = _getSeekableWindow();
    if (win && (win.end - _dvrVideo.currentTime) < NEAR_END_THRESHOLD) {
      _extrapolateNextSegment();
    }
  }, CATCH_UP_INTERVAL);
}

function _stopCatchUpTimer() {
  if (!_catchUpTimer) return;
  clearInterval(_catchUpTimer);
  _catchUpTimer = null;
  console.log('[KickTiny DVR] Exiting catch-up mode');
}

// ── custom hls.js loader ──────────────────────────────────────────────────────

function _buildCustomLoader(DefaultLoader) {
  return class SyntheticLoader extends DefaultLoader {
    load(context, config, callbacks) {
      if (context.url === SYNTHETIC_URL) {
        const data = _generateManifestString();
        const now  = performance.now();
        setTimeout(() => callbacks.onSuccess(
          { data, url: SYNTHETIC_URL },
          {
            aborted: false, loaded: data.length, total: data.length, retry: 0,
            trequest: now, tfirst: now, tload: now, chunkCount: 0, bwEstimate: Infinity,
            loading:   { start: now, first: now, end: now },
            parsing:   { start: now, end: now },
            buffering: { start: now, first: now, end: now },
          },
          context
        ), 0);
        return;
      }
      super.load(context, config, callbacks);
    }
    abort() {}
  };
}

// ── HLS instance ──────────────────────────────────────────────────────────────

function _createHlsInstance() {
  if (_hls) { _hls.destroy(); _hls = null; }
  _hls = new _Hls({
    loader:                  _buildCustomLoader(_Hls.DefaultConfig.loader),
    liveDurationInfinity:    true,
    backBufferLength:        Infinity,
    enableWorker:            true,
    lowLatencyMode:          false,
    autoStartLoad:           true,
    manifestLoadingTimeOut:  5000,
    manifestLoadingMaxRetry: 2,
  });
  _hls.loadSource(SYNTHETIC_URL);
  _hls.attachMedia(_dvrVideo);
  _hls.on(_Hls.Events.MANIFEST_PARSED, (_, data) => {
    console.log('[KickTiny DVR] Manifest parsed —', data.levels.length, 'level(s),', _segments.length, 'segments');
    setState({ dvrAvailable: true });
  });
  _hls.on(_Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    console.error('[KickTiny DVR] Fatal error:', data.details);
    _hls.recoverMediaError();
  });
}

// ── wait for seekable ─────────────────────────────────────────────────────────

async function _waitForSeekable(timeoutMs = SEEKABLE_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (_dvrVideo?.seekable?.length > 0) {
      const i = _dvrVideo.seekable.length - 1;
      const end   = _dvrVideo.seekable.end(i);
      const start = _dvrVideo.seekable.start(i);
      if (isFinite(end) && end > start) return { start, end };
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

function _getSeekableWindow() {
  if (!_dvrVideo?.seekable?.length) return null;
  const i = _dvrVideo.seekable.length - 1;
  return { start: _dvrVideo.seekable.start(i), end: _dvrVideo.seekable.end(i) };
}

// ── JWT expiry ────────────────────────────────────────────────────────────────

function _getTokenExpiryMs(url) {
  try {
    const jwt = new URL(url).searchParams.get('init');
    if (!jwt) return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64));
    return payload?.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

function _stopExpiryTimer() {
  clearTimeout(_expiryTimer);
  _expiryTimer = null;
}

function _scheduleExpiryRefresh(url) {
  _stopExpiryTimer();
  const expMs = _getTokenExpiryMs(url);
  if (!expMs) {
    _expiryTimer = setTimeout(() => {
      if (state.engine === 'dvr' && !_refreshing) _fetchAndExtendManifest();
    }, FALLBACK_REFRESH_MS);
    return;
  }
  const msUntilRefresh = expMs - Date.now() - EXPIRY_LEAD_MS;
  console.log('[KickTiny DVR] Token expires in', Math.round((expMs - Date.now()) / 1000), 's — refresh in', Math.round(Math.max(5000, msUntilRefresh) / 1000), 's');
  _expiryTimer = setTimeout(() => {
    if (state.engine === 'dvr' && !_refreshing) _fetchAndExtendManifest();
  }, Math.max(5000, msUntilRefresh));
}

// ── cleanup ───────────────────────────────────────────────────────────────────

function _destroyHls() {
  if (_hls) { _hls.destroy(); _hls = null; }
}

function _returnToLiveUi() {
  if (_dvrVideo) _dvrVideo.style.display = 'none';
  if (_nativeVideo) _nativeVideo.style.visibility = 'visible';
}

function _restoreIvs(player, shouldPlay, wasVolume, wasMuted) {
  if (!player) return;
  player.setVolume(wasVolume / 100);
  player.setMuted(!!wasMuted);
  if (shouldPlay) player.play();
}

// ── one-time container setup ──────────────────────────────────────────────────

export async function setupDvrContainer(container) {
  if (_dvrVideo) return;
  _nativeVideo = container.querySelector('video');
  if (!_nativeVideo) { console.warn('[KickTiny DVR] No native video found'); return; }
  const cs = window.getComputedStyle(container);
  if (cs.position === 'static') container.style.position = 'relative';
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
  console.log('[KickTiny DVR] Container ready');
}

// ── lazy DVR entry ────────────────────────────────────────────────────────────

export async function enterDvrAtBehindLive(behindSec) {
  if (!_dvrVideo || !_nativeVideo) { console.warn('[KickTiny DVR] Container not set up yet'); return; }
  if (!state.vodId) { console.warn('[KickTiny DVR] No vodId'); return; }

  // Already in DVR — just seek
  if (state.engine === 'dvr' && _hls) {
    const win = _getSeekableWindow();
    if (win) {
      const manifestOffset = Math.max(0, state.uptimeSec - win.end);
      const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - manifestOffset)));
      _dvrVideo.currentTime = target;
      const trueBehind = Math.max(0, win.end - target) + manifestOffset;
      setState({ dvrBehindLive: trueBehind, atLiveEdge: trueBehind <= 30 });
      return;
    }
  }

  console.log('[KickTiny DVR] Entering DVR mode,', behindSec.toFixed(1), 's behind live');

  const p          = getPlayer();
  const wasPlaying = state.playing;
  const wasVolume  = state.volume;
  const wasMuted   = state.muted;
  setState({ buffering: true });

  if (!_Hls) {
    try { _Hls = await _loadHlsJs(); } catch (e) {
      console.warn('[KickTiny DVR] hls.js load failed:', e.message);
      setState({ buffering: false }); return;
    }
    if (!_Hls.isSupported()) {
      console.warn('[KickTiny DVR] hls.js not supported');
      setState({ buffering: false }); return;
    }
  }

  if (p) p.pause();
  _nativeVideo.style.visibility = 'hidden';
  _dvrVideo.style.display = 'block';
  _dvrVideo.volume       = wasVolume / 100;
  _dvrVideo.muted        = state.muted;
  _dvrVideo.playbackRate = state.rate;

  const url = await fetchVodPlaybackUrl(state.vodId);
  if (!url) {
    console.warn('[KickTiny DVR] Could not fetch VOD URL');
    _returnToLiveUi(); _restoreIvs(p, wasPlaying, wasVolume, wasMuted);
    setState({ buffering: false }); return;
  }

  // Reset segment store for fresh DVR session
  _segments = [];
  _lastSegUrl = '';
  const appended = await _fetchAndMergeSnapshot(url);
  if (appended === 0) {
    console.warn('[KickTiny DVR] No segments in snapshot');
    _returnToLiveUi(); _restoreIvs(p, wasPlaying, wasVolume, wasMuted);
    setState({ buffering: false }); return;
  }

  _destroyHls();
  _createHlsInstance();

  const win = await _waitForSeekable();
  if (!win) {
    console.warn('[KickTiny DVR] Seekable window never available');
    _returnToLiveUi(); _destroyHls(); _restoreIvs(p, wasPlaying, wasVolume, wasMuted);
    setState({ buffering: false }); return;
  }

  _manifestOffset = Math.max(0, state.uptimeSec - win.end);
  const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - _manifestOffset)));
  console.log('[KickTiny DVR] Seekable', win.start.toFixed(1), '–', win.end.toFixed(1),
              '| offset', _manifestOffset.toFixed(1), '→ seeking to', target.toFixed(1));
  _dvrVideo.currentTime = target;

  const trueBehind = Math.max(0, win.end - target) + _manifestOffset;
  setState({
    engine:        'dvr',
    buffering:     false,
    dvrAvailable:  true,
    dvrWindowSec:  Math.max(0, win.end - win.start),
    dvrBehindLive: trueBehind,
    atLiveEdge:    trueBehind <= 30,
  });

  _startPositionPoll();
  _scheduleExpiryRefresh(url);
  _dvrVideo.play().catch(() => {});

  if (state.quality !== null && state.dvrQualities?.length) {
    const match = state.dvrQualities.find(q => q.name === state.quality?.name)
      || state.dvrQualities.find(q => q.name.replace(/\d+$/, '') === state.quality?.name.replace(/\d+$/, ''));
    if (match) setState({ dvrQuality: match });
  }

  console.log('[KickTiny DVR] DVR mode active');
}

// ── exit DVR ──────────────────────────────────────────────────────────────────

export function exitDvrMode() {
  if (!_dvrVideo || !_nativeVideo) return;
  _dvrVideo.pause();
  _destroyHls();
  _returnToLiveUi();
  _stopExpiryTimer();
  _stopPositionPoll();
  _stopCatchUpTimer();
  _manifestOffset = 0;

  setState({ engine: 'ivs', atLiveEdge: true, dvrBehindLive: 0, dvrWindowSec: 0, buffering: false });

  const p = getPlayer();
  if (p) {
    p.setVolume(state.volume / 100);
    p.setMuted(state.muted);
    p.setMuted(state.muted);
    if (state.dvrQuality !== null && state.qualities?.length) {
      const match = state.qualities.find(q => q.name === state.dvrQuality.name)
        || state.qualities.find(q => q.name.replace(/\d+$/, '') === state.dvrQuality.name.replace(/\d+$/, ''));
      if (match) { p.setAutoQualityMode(false); p.setQuality(match); }
    }
    try {
      const pos     = p.getPosition?.() ?? 0;
      const latency = p.getLiveLatency?.() ?? 0;
      if (isFinite(pos) && isFinite(latency) && latency > 0) p.seekTo(pos + latency + 0.25);
    } catch (_) {}
    p.play();
  }
  console.log('[KickTiny DVR] Exited DVR mode — back to IVS live');
}

// ── DVR seek ──────────────────────────────────────────────────────────────────

export function dvrSeekToBehindLive(behindSec) {
  if (!_dvrVideo) return;
  const win = _getSeekableWindow();
  if (!win) return;
  const manifestOffset = Math.max(0, state.uptimeSec - win.end);
  const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - manifestOffset)));
  _dvrVideo.currentTime = target;
}

export function dvrSeekToLive() { exitDvrMode(); }

// ── position poll ─────────────────────────────────────────────────────────────

function _startPositionPoll() {
  _stopPositionPoll();
  _posTimer = setInterval(() => {
    if (!_dvrVideo || state.engine !== 'dvr') { _stopPositionPoll(); return; }

    const win            = _getSeekableWindow();
    const manifestOffset = win ? Math.max(0, state.uptimeSec - win.end) : _manifestOffset;
    const behindLive     = win ? Math.max(0, (win.end - _dvrVideo.currentTime) + manifestOffset) : 0;
    const windowSec      = win ? Math.max(0, win.end - win.start) : 0;

    setState({ dvrBehindLive: behindLive, dvrWindowSec: windowSec, atLiveEdge: behindLive <= 30 });

    if (win) {
      const secsFromEnd = win.end - _dvrVideo.currentTime;
      // Start catch-up when within 60s of end, stop only when > 120s away (hysteresis)
      // This prevents rapid start/stop cycling when extrapolation pushes win.end forward
      if (secsFromEnd < NEAR_END_THRESHOLD) {
        _startCatchUpTimer();
      } else if (secsFromEnd > NEAR_END_THRESHOLD * 2 && _catchUpTimer) {
        _stopCatchUpTimer();
      }
    }
  }, 500);
}

function _stopPositionPoll() {
  clearInterval(_posTimer);
  _posTimer = null;
}
