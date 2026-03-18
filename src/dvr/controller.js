import { state, setState } from '../state.js';
import { getPlayer } from '../adapter.js';
import { fetchVodPlaybackUrl } from '../api.js';

let _Hls             = null;
let _hls             = null;
let _dvrVideo        = null;
let _nativeVideo     = null;
let _posTimer        = null;
let _expiryTimer     = null;
let _catchUpTimer    = null;   // active when within 60s of end of loaded segments
let _refreshing      = false;
let _manifestOffset  = 0;

// Synthetic manifest state
let _segments          = [];
let _targetDuration    = 10;
let _lastSnapshotBase  = '';
let _cachedManifest    = '';
let _lastSegmentCount  = 0;

const SYNTHETIC_URL       = 'https://kt.local/dvr.m3u8';
const SEEKABLE_WAIT_MS    = 8  * 1000;
const EXPIRY_LEAD_MS      = 2  * 60 * 1000;
const FALLBACK_REFRESH_MS = 50 * 60 * 1000;
const CATCH_UP_INTERVAL   = 12500;  // ~one segment duration
const NEAR_END_THRESHOLD  = 60;     // seconds from end of manifest

export function getDvrVideo() { return _dvrVideo; }

// ── quality ───────────────────────────────────────────────────────────────────

export function setDvrQuality(index) {
  if (!_hls) return;
  if (index === 'auto') {
    // Pick middle quality
    const qualities = [...(state.dvrQualities || [])];
    const mid = qualities[Math.floor(qualities.length / 2)];
    if (mid) _switchDvrVariant(mid);
    setState({ dvrQuality: null });
  } else {
    const q = typeof index === 'object' ? index : state.dvrQualities?.find(q => q.index === index);
    if (q) _switchDvrVariant(q);
    setState({ dvrQuality: q ?? null });
  }
}

async function _switchDvrVariant(q) {
  if (!state.vodId) return;
  const savedPos = _dvrVideo?.currentTime ?? 0;

  // Fetch fresh VOD URL to get a new multivariant playlist
  const vodUrl = await fetchVodPlaybackUrl(state.vodId);
  if (!vodUrl) return;

  const res  = await fetch(vodUrl);
  const text = await res.text();
  if (!text.includes('#EXT-X-STREAM-INF')) return;

  // Find the variant URL matching this quality by name
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

  // Rebuild synthetic manifest with new variant's segments
  _segments = [];
  _cachedManifest = '';
  const varRes  = await fetch(variantUrl);
  const varText = await varRes.text();
  _mergeSegments(varText, variantUrl);
  _scheduleExpiryRefresh(variantUrl);

  // Destroy and recreate hls.js with the new manifest, restore position
  _destroyHls();
  _createHlsInstance();
  if (isFinite(savedPos) && savedPos > 0) {
    const onMeta = () => {
      _dvrVideo.currentTime = savedPos;
      _dvrVideo.play().catch(() => {});
    };
    if (_dvrVideo.readyState >= 1) onMeta();
    else _dvrVideo.addEventListener('loadedmetadata', onMeta, { once: true });
  }
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

function _parseSegments(text, baseUrl) {
  const lines  = text.split('\n');
  const result = [];
  let duration      = null;
  let pdt           = null;
  let discontinuity = false;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#EXT-X-TARGETDURATION:')) {
      const td = parseInt(t.split(':')[1]);
      if (td && td !== _targetDuration) {
        _targetDuration = td;
        _cachedManifest = ''; // Invalidate cache if target duration changes
      }
      continue;
    }
    if (t.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuity = true;
      continue;
    }
    if (t.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pdt = t;
      continue;
    }
    if (t.startsWith('#EXTINF:')) {
      duration = t;
      continue;
    }
    if (duration && !t.startsWith('#')) {
      const url = t.startsWith('http') ? t : new URL(t, baseUrl).href;
      result.push({ duration, url, pdt, discontinuity });
      duration      = null;
      pdt           = null;
      discontinuity = false;
    }
  }
  return result;
}

function _generateManifestString() {
  if (_segments.length === _lastSegmentCount && _cachedManifest) {
    return _cachedManifest;
  }

  const header = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    `#EXT-X-TARGETDURATION:${_targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  const body = [];
  for (const seg of _segments) {
    if (seg.discontinuity) body.push('#EXT-X-DISCONTINUITY');
    if (seg.pdt) body.push(seg.pdt);
    body.push(seg.duration);
    body.push(seg.url);
  }
  _cachedManifest = header.join('\n') + '\n' + body.join('\n') + '\n';
  _lastSegmentCount = _segments.length;
  return _cachedManifest;
}

function _stripQuery(url) {
  try { return url.split('?')[0]; } catch { return url; }
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

  let searchFrom = 0;
  if (_segments.length > 0) {
    const lastSeg = _segments[_segments.length - 1];
    const lastUrlPath = _stripQuery(lastSeg.url);
    const lastFilename = lastUrlPath.split('/').pop();
    const lastIdx = text.lastIndexOf(lastFilename);

    if (lastIdx !== -1) {
      const extInfIdx = text.lastIndexOf('#EXTINF:', lastIdx);
      if (extInfIdx !== -1) {
        searchFrom = text.lastIndexOf('\n', extInfIdx);
        if (searchFrom === -1) searchFrom = 0;
      }
    }
  }

  const newText = searchFrom > 0 ? text.slice(searchFrom) : text;
  const segments = _parseSegments(newText, baseUrl);
  if (!segments.length) return 0;

  let startIdx = 0;
  if (_segments.length > 0) {
    const lastUrlPath = _stripQuery(_segments[_segments.length - 1].url);
    const overlapIdx = segments.map(s => _stripQuery(s.url)).lastIndexOf(lastUrlPath);
    if (overlapIdx !== -1) {
      startIdx = overlapIdx + 1;
    } else {
      console.warn('[KickTiny DVR] Overlap not found, resetting segments. Last URL path:', lastUrlPath);
      _segments = [];
      _cachedManifest = '';
      startIdx = 0;
      if (searchFrom > 0) return _mergeSegments(text, baseUrl);
    }
  }

  const newSegments = segments.slice(startIdx);
  if (newSegments.length > 0) {
    _segments.push(...newSegments);
    console.log('[KickTiny DVR] Merged', newSegments.length, 'new segments. Total:', _segments.length, 'Tail:', _stripQuery(newSegments[newSegments.length - 1].url).split('/').pop());
  }
  return newSegments.length;
}

async function _fetchAndMergeSnapshot(snapshotUrl) {
  try {
    const res  = await fetch(snapshotUrl);
    const text = await res.text();
    if (text.includes('#EXT-X-STREAM-INF')) {
      _setDvrQualitiesFromMultivariant(text);
      const playlistUrl = _pickVariantUrl(text, snapshotUrl);
      const varRes  = await fetch(playlistUrl);
      const varText = await varRes.text();
      return _mergeSegments(varText, playlistUrl);
    }
    return _mergeSegments(text, snapshotUrl);
  } catch (e) {
    console.warn('[KickTiny DVR] Snapshot fetch failed:', e.message);
    return 0;
  }
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
    // Sort highest quality first (matches IVS quality list order)
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    streams.forEach((s, i) => { s.index = i; });
    setState({ dvrQualities: streams });
  }
}

// ── extend manifest (fetch fresh VOD JWT + merge new segments) ────────────────

async function _fetchAndExtendManifest() {
  if (_refreshing || !state.vodId) return;
  _refreshing = true;

  // Proactive token refresh: check if current URL is close to expiry
  const needsRefresh = _lastSnapshotBase ? (_getTokenExpiryMs(_lastSnapshotBase) - Date.now() < EXPIRY_LEAD_MS) : true;

  if (needsRefresh) {
    console.log('[KickTiny DVR] Token expiring or missing, fetching fresh VOD URL');
    const newUrl = await fetchVodPlaybackUrl(state.vodId);
    if (newUrl) {
      await _fetchAndMergeSnapshot(newUrl);
      _scheduleExpiryRefresh(newUrl);
    }
  } else {
    await _fetchAndMergeSnapshot(_lastSnapshotBase);
  }

  _refreshing = false;
}

// ── catch-up timer (runs only when within 60s of end of loaded segments) ──────

function _startCatchUpTimer() {
  if (_catchUpTimer) return;
  console.log('[KickTiny DVR] Entering catch-up mode');
  _fetchAndExtendManifest(); // immediate fetch on entry
  _catchUpTimer = setInterval(() => {
    if (state.engine !== 'dvr') { _stopCatchUpTimer(); return; }
    _fetchAndExtendManifest();
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
    console.log('[KickTiny DVR] Manifest parsed —', data.levels.length, 'level(s)');
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
      const end = _dvrVideo.seekable.end(i);
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
  console.log('[KickTiny DVR] Token expires in', Math.round((expMs - Date.now()) / 1000), 's');
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

function _restoreIvs(player, shouldPlay, wasVolume) {
  if (!player) return;
  player.setVolume(wasVolume / 100);
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
    _returnToLiveUi(); _restoreIvs(p, wasPlaying, wasVolume);
    setState({ buffering: false }); return;
  }

  _segments = [];
  const appended = await _fetchAndMergeSnapshot(url);
  if (appended === 0) {
    console.warn('[KickTiny DVR] No segments in snapshot');
    _returnToLiveUi(); _restoreIvs(p, wasPlaying, wasVolume);
    setState({ buffering: false }); return;
  }

  _destroyHls();
  _createHlsInstance();

  const win = await _waitForSeekable();
  if (!win) {
    console.warn('[KickTiny DVR] Seekable window never available');
    _returnToLiveUi(); _destroyHls(); _restoreIvs(p, wasPlaying, wasVolume);
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

  // Match the live IVS quality to the DVR quality list
  if (state.quality !== null && state.dvrQualities?.length) {
    const match = state.dvrQualities.find(q => q.name === state.quality?.name)
      || state.dvrQualities.find(q => q.name.replace(/\d+$/, '') === state.quality?.name.replace(/\d+$/, ''));
    if (match) {
      setState({ dvrQuality: match });
    }
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
    if (state.dvrQuality !== null && state.qualities?.length) {
      const match = state.qualities.find(q => q.name === state.dvrQuality.name)
        || state.qualities.find(q => q.name.replace(/\d+$/, '') === state.dvrQuality.name.replace(/\d+$/, ''));
      if (match) { p.setAutoQualityMode(false); p.setQuality(match); }
    }
    try {
      const pos     = p.getPosition?.() ?? 0;
      const latency = p.getLiveLatency?.() ?? 0;
      if (isFinite(pos) && isFinite(latency) && latency > 0) {
        p.seekTo(pos + latency + 0.25);
      }
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

    // Within 60s of end of loaded segments → catch-up mode (poll for new segments)
    // Outside 60s (user seeked back) → stop catch-up mode
    if (win) {
      if (win.end - _dvrVideo.currentTime < NEAR_END_THRESHOLD) {
        _startCatchUpTimer();
      } else {
        _stopCatchUpTimer();
      }
    }
  }, 500);
}

function _stopPositionPoll() {
  clearInterval(_posTimer);
  _posTimer = null;
}
