// ==UserScript==
// @name         KickTiny
// @namespace    https://github.com/reda777/kicktiny
// @version      0.0.0-dev
// @description  Custom player overlay for Kick.com embeds
// @author       Reda777
// @match        https://player.kick.com/*
// @updateURL    https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @downloadURL  https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @supportURL   https://github.com/reda777/kicktiny
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function() {
'use strict';

// ── state.js ──
const state = {
  // playback engine
  engine: 'ivs',

  // DVR
  dvrAvailable:  false,
  uptimeSec:     0,       // total stream age in seconds (Date.now() - streamStartTime)
  dvrBehindLive: 0,       // seconds behind live edge (seekableEnd - currentTime)
  dvrWindowSec:  0,       // actual seekable DVR window (seekableEnd - seekableStart)
  dvrQualities:  [],
  dvrQuality:    null,

  // stream metadata
  vodId:           null,
  streamStartTime: null,  // ISO string, stable source for uptime calc

  // playback state
  playing:     false,
  buffering:   false,
  qualities:   [],
  quality:     null,
  autoQuality: true,
  volume:      50,
  muted:       false,
  fullscreen:  false,
  rate:        1,
  atLiveEdge:  true,

  // channel info
  username:    '',
  displayName: '',
  avatar:      '',
  viewers:     null,
  title:       null,
  error:       null,
};

const listeners = new Set();

function shallowEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

function setState(patch) {
  let changed = false;
  for (const k in patch) {
    if (!shallowEqual(state[k], patch[k])) {
      state[k] = patch[k];
      changed = true;
    }
  }
  if (changed) listeners.forEach(fn => fn(state));
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── prefs.js ──
const KEYS = {
  quality: 'kt.quality',
  volume:  'kt.volume',
};

function loadPrefs() {
  return {
    quality: localStorage.getItem(KEYS.quality) || null,
    volume:  localStorage.getItem(KEYS.volume) !== null
               ? Number(localStorage.getItem(KEYS.volume)) : null,
  };
}

function savePrefs(patch) {
  if ('quality' in patch) {
    if (patch.quality === null) localStorage.removeItem(KEYS.quality);
    else localStorage.setItem(KEYS.quality, patch.quality);
  }
  if ('volume' in patch) {
    localStorage.setItem(KEYS.volume, String(patch.volume));
  }
}


// ── adapter.js ──



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

function getPlayer() { return _player; }

function initAdapter() {
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

  p.addEventListener(EV.STATE_CHANGED, e => {
    if (state.engine !== 'ivs') return;
    const ps = e?.state ?? e;
    const buffering = ps === PS.BUFFERING;
    const playing = ps === PS.PLAYING;

    if (playing) sessionStorage.removeItem('kt.reloads');

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

// ── api.js ──
const BASE = 'https://kick.com';

async function get(path) {
  const res = await fetch(BASE + path, {
    credentials: 'omit',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function fetchChannelInfo(username) {
  return get(`/api/v2/channels/${username}/info`);
}

async function fetchChannelInit(username) {
  try {
    const data = await fetchChannelInfo(username);
    const ls = data?.livestream ?? null;
    return {
      isLive:       ls?.is_live === true,
      displayName:  data?.user?.username    ?? null,
      avatar:       data?.user?.profile_pic ?? null,
      vodId:        ls?.vod_id              ?? null,
      livestreamId: ls?.id                  ?? null,
      viewers:      ls?.viewer_count        ?? null,
      startTime:    ls?.start_time          ?? null,
      title:        ls?.session_title       ?? null,
    };
  } catch {
    return { isLive: null, displayName: null, avatar: null, vodId: null, livestreamId: null, viewers: null, startTime: null, title: null };
  }
}

function getDeviceId() {
  const KEY = 'kt.deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

async function fetchVodPlaybackUrl(vodId) {
  try {
    const res = await fetch(
      `https://web.kick.com/api/v1/stream/${encodeURIComponent(vodId)}/playback`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept':       'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          video_player: {
            player: {
              player_name:             'web',
              player_version:          'web_7a224cf6',
              player_software:         'IVS Player',
              player_software_version: '1.49.0',
            },
            mux_sdk:        { sdk_available: false },
            datazoom_sdk:   { sdk_available: false },
            google_ads_sdk: { sdk_available: false },
          },
          video_session: {
            page_type:              'channel',
            player_remote_played:   false,
            viewer_connection_type: '',
            enable_sampling:        false,
          },
          user_session: {
            player_device_id:               getDeviceId(),
            player_resettable_id:           '',
            player_resettable_consent_type: '',
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const dvr = data?.playback_url?.vod ?? null;
    if (!dvr) throw new Error('vod field missing from response');
    return dvr;
  } catch (e) {
    console.warn('[KickTiny DVR] fetchVodPlaybackUrl failed:', e.message);
    return null;
  }
}

// ── dvr\controller.js ──

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

function getDvrVideo() { return _dvrVideo; }

// ── quality ───────────────────────────────────────────────────────────────────

function setDvrQuality(index) {
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

function _restoreIvs(player, shouldPlay, wasVolume) {
  if (!player) return;
  player.setVolume(wasVolume / 100);
  if (shouldPlay) player.play();
}

// ── one-time container setup ──────────────────────────────────────────────────

async function setupDvrContainer(container) {
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

async function enterDvrAtBehindLive(behindSec) {
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

  // Reset segment store for fresh DVR session
  _segments = [];
  _lastSegUrl = '';
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

  if (state.quality !== null && state.dvrQualities?.length) {
    const match = state.dvrQualities.find(q => q.name === state.quality?.name)
      || state.dvrQualities.find(q => q.name.replace(/\d+$/, '') === state.quality?.name.replace(/\d+$/, ''));
    if (match) setState({ dvrQuality: match });
  }

  console.log('[KickTiny DVR] DVR mode active');
}

// ── exit DVR ──────────────────────────────────────────────────────────────────

function exitDvrMode() {
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
      if (isFinite(pos) && isFinite(latency) && latency > 0) p.seekTo(pos + latency + 0.25);
    } catch (_) {}
    p.play();
  }
  console.log('[KickTiny DVR] Exited DVR mode — back to IVS live');
}

// ── DVR seek ──────────────────────────────────────────────────────────────────

function dvrSeekToBehindLive(behindSec) {
  if (!_dvrVideo) return;
  const win = _getSeekableWindow();
  if (!win) return;
  const manifestOffset = Math.max(0, state.uptimeSec - win.end);
  const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - manifestOffset)));
  _dvrVideo.currentTime = target;
}

function dvrSeekToLive() { exitDvrMode(); }

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


// ── actions.js ──





// ── helpers ───────────────────────────────────────────────────────────────────

function inDvr() { return state.engine === 'dvr'; }

// ── play / pause ──────────────────────────────────────────────────────────────

function play() {
  if (inDvr()) {
    getDvrVideo()?.play().catch(() => {});
  } else {
    getPlayer()?.play();
  }
}

function pause() {
  if (inDvr()) {
    getDvrVideo()?.pause();
  } else {
    getPlayer()?.pause();
  }
}

function togglePlay() {
  state.playing ? pause() : play();
}

// ── volume / mute ─────────────────────────────────────────────────────────────

let _volSaveTimer = null;
function setVolume(pct) {
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

function setMuted(muted) {
  if (inDvr()) {
    const vid = getDvrVideo();
    if (!vid) return;
    vid.muted = muted;
    setState({ muted });
  } else {
    getPlayer()?.setMuted(muted);
  }
}

function toggleMute() {
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

function setQuality(qualityObj) {
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

function setRate(r) {
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

function seekToLive() {
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

// ── keyboard ──────────────────────────────────────────────────────────────────

let _keysBound = false;
function bindKeys() {
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


// ── ui\play.js ──

function createPlayBtn() {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-play';
  btn.title = 'Play/Pause (k)';
  btn.innerHTML = svgPlay();
  btn.addEventListener('click', togglePlay);

  subscribe(({ playing, buffering }) => {
    btn.innerHTML = buffering ? svgSpin() : playing ? svgPause() : svgPlay();
    btn.title = playing ? 'Pause (k)' : 'Play (k)';
  });

  return btn;
}

function svgPlay() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}
function svgPause() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
}
function svgSpin() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="kt-spin"><circle cx="12" cy="12" r="9" stroke-dasharray="30 60"/></svg>`;
}


// ── ui\volume.js ──



function createVolumeCtrl() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-vol-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-mute';
  btn.title = 'Mute (m)';
  btn.addEventListener('click', toggleMute);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'kt-vol-slider';
  slider.min = 0;
  slider.max = 100;
  slider.step = 1;

  const clip = document.createElement('div');
  clip.className = 'kt-vol-clip';
  clip.appendChild(slider);

  let _dragging = false;
  slider.addEventListener('mousedown', () => {
    _dragging = true;
    const up = () => { _dragging = false; document.removeEventListener('mouseup', up); };
    document.addEventListener('mouseup', up);
  });
  slider.addEventListener('touchstart', () => { _dragging = true; }, { passive: true });
  slider.addEventListener('touchend',   () => { _dragging = false; }, { passive: true });
  slider.addEventListener('input', () => setVolume(Number(slider.value)));

  wrap.append(btn, clip);

  subscribe(({ volume, muted }) => {
    btn.innerHTML = svgVol(muted || volume === 0);
    if (!_dragging) slider.value = muted ? 0 : volume;
    btn.title = muted ? 'Unmute (m)' : 'Mute (m)';
  });

  btn.innerHTML = svgVol(state.muted || state.volume === 0);
  slider.value = state.muted ? 0 : state.volume;

  return wrap;
}

function svgVol(muted) {
  if (muted) {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
}


// ── ui\popup.js ──
let _popupGlobalsBound = false;
function bindPopupGlobals() {
  if (_popupGlobalsBound) return;
  _popupGlobalsBound = true;
  document.addEventListener('click', () => {
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
}

function openPopup(popup, triggerBtn) {
  popup.hidden = false;
  popup.style.visibility = 'hidden';
  const rect = triggerBtn.getBoundingClientRect();
  const vw = window.innerWidth;
  const popupW = popup.offsetWidth || 120;
  const popupH = popup.offsetHeight || 100;

  const availableH = rect.top - 8 - 4;
  const maxH = Math.max(80, availableH);
  popup.style.maxHeight = maxH + 'px';

  let top = rect.top - Math.min(popupH, maxH) - 8;
  if (top < 4) top = 4;

  let left = rect.right - popupW;
  if (left < 4) left = 4;
  if (left + popupW > vw - 4) left = vw - popupW - 4;

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.style.visibility = '';
}

function setupPopupToggle(btn, popup, onOpen) {
  bindPopupGlobals();
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!popup.hidden) { popup.hidden = true; return; }
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
    if (onOpen) onOpen();
    openPopup(popup, btn);
  });
}


// ── utils\format.js ──
function fmtViewers(n) {
  if (n === null || n === undefined) return '';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function fmtUptime(startDate) {
  if (!startDate) return '';
  const secs = Math.floor((Date.now() - startDate.getTime()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtQuality(name) {
  if (!name) return name;
  // Remove frame rate suffix if 30fps or less (e.g. "480p30" → "480p", "1080p60" stays)
  return name.replace(/(\d+p)(\d+)$/, (_, res, fps) => parseInt(fps) > 30 ? res + fps : res);
}

function fmtDuration(totalSec) {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// ── ui\quality.js ──





function createQualityBtn() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-qual-btn';
  btn.title = 'Quality';
  btn.textContent = 'AUTO';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-qual-popup';
  popup.hidden = true;

  let _s = {
    engine: 'ivs',
    qualities: [], quality: null, autoQuality: true,
    dvrQualities: [], dvrQuality: null,
  };

  setupPopupToggle(btn, popup, () => renderPopup(popup, _s));

  document.body.appendChild(popup);
  wrap.append(btn);

  subscribe(({ engine, qualities, quality, autoQuality, dvrQualities, dvrQuality }) => {
    _s = { engine, qualities, quality, autoQuality, dvrQualities, dvrQuality };

    if (engine === 'dvr') {
      btn.textContent = dvrQuality ? fmtQuality(dvrQuality.name) : 'AUTO';
    } else {
      btn.textContent = autoQuality ? 'AUTO' : fmtQuality(quality?.name ?? '?');
    }

    if (!popup.hidden) renderPopup(popup, _s);
  });

  return wrap;
}

function renderPopup(popup, s) {
  const items = buildItems(s);

  const existing = Array.from(popup.querySelectorAll('.kt-popup-item'));
  if (!popup.hidden && existing.length === items.length) {
    items.forEach((item, i) => {
      const el = existing[i];
      if (el.textContent !== item.label) el.textContent = item.label;
      const shouldBeActive = item.active;
      if (el.classList.contains('kt-active') !== shouldBeActive) {
        el.classList.toggle('kt-active', shouldBeActive);
      }
      el.onclick = e => { e.stopPropagation(); item.onClick(); popup.hidden = true; };
    });
    return;
  }
  popup.innerHTML = '';
  items.forEach(({ label, active, onClick }) => {
    popup.appendChild(makeItem(label, active, onClick, popup));
  });
}

function buildItems(s) {
  if (s.engine === 'dvr') {
    return [
      { label: 'Auto', active: s.dvrQuality === null, onClick: () => setQuality('auto') },
      ...(s.dvrQualities || []).map(q => ({
        label:   fmtQuality(q.name),
        active:  s.dvrQuality?.index === q.index,
        onClick: () => setQuality(q),
      })),
    ];
  }
  return [
    { label: 'Auto', active: s.autoQuality, onClick: () => setQuality('auto') },
    ...(s.qualities || []).map(q => ({
      label:   q.name,
      active:  !s.autoQuality && s.quality?.name === q.name,
      onClick: () => setQuality(q),
    })),
  ];
}

function makeItem(label, active, onClick, popup) {
  const item = document.createElement('button');
  item.className = 'kt-popup-item' + (active ? ' kt-active' : '');
  item.textContent = label;
  item.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
    popup.hidden = true;
  });
  return item;
}

// ── ui\speed.js ──




const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function createSpeedBtn() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-speed-btn';
  btn.title = 'Speed';
  btn.textContent = '1×';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-speed-popup';
  popup.hidden = true;

  RATES.forEach(r => {
    const item = document.createElement('button');
    item.className = 'kt-popup-item';
    item.dataset.rate = r;
    item.textContent = r === 1 ? '1× (normal)' : r + '×';
    item.addEventListener('click', e => {
      e.stopPropagation();
      setRate(r);
      popup.hidden = true;
    });
    popup.appendChild(item);
  });

  setupPopupToggle(btn, popup);

  document.body.appendChild(popup);
  wrap.append(btn);

  subscribe(({ rate }) => {
    btn.textContent = rate === 1 ? '1×' : rate + '×';
    popup.querySelectorAll('.kt-popup-item[data-rate]').forEach(item => {
      item.classList.toggle('kt-active', Number(item.dataset.rate) === rate);
    });
  });

  return wrap;
}


// ── ui\fullscreen.js ──

function createFullscreenBtn() {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-fs';
  btn.title = 'Fullscreen (f)';
  btn.innerHTML = svgExpand();
  btn.addEventListener('click', toggleFullscreen);

  subscribe(({ fullscreen }) => {
    btn.innerHTML = fullscreen ? svgCompress() : svgExpand();
    btn.title = fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
  });

  return btn;
}

function svgExpand() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
}
function svgCompress() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;
}


// ── ui\info.js ──

// ── intercept Kick's own current-viewers fetch ────────────────────────────────
// Instead of making our own viewer count requests, we sniff Kick's native fetch
// and read the response — zero extra network requests.

let _onViewerCount = null; // callback set by createInfo

(function interceptViewerFetch() {
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    const res = await _origFetch.apply(this, args);
    if (url.includes('current-viewers') && _onViewerCount) {
      res.clone().json().then(data => {
        if (Array.isArray(data) && data[0]?.viewers != null) {
          _onViewerCount(data[0].viewers);
        }
      }).catch(() => {});
    }
    return res;
  };
})();

function createInfo() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-info';

  const live = document.createElement('span');
  live.className = 'kt-live-badge';
  live.textContent = '● LIVE';

  const viewers = document.createElement('span');
  viewers.className = 'kt-viewers';

  const uptime = document.createElement('span');
  uptime.className = 'kt-uptime';

  wrap.append(viewers, uptime);

  let pollTimer     = null;
  let uptimeTimer   = null;
  let startDate     = null;
  // Hook into the fetch interceptor
  _onViewerCount = (count) => {
    viewers.textContent = fmtViewers(count) + ' watching';
  };

  // ── uptime ticker ──────────────────────────────────────────────────────────

  function _startUptimeTicker(start) {
    // Validate the date
    if (!start || !isFinite(start.getTime())) return;
    // No-op if same start time already ticking
    if (startDate && start.getTime() === startDate.getTime() && uptimeTimer) return;

    startDate = start;
    clearInterval(uptimeTimer);

    const tick = () => {
      if (state.engine === 'dvr') {
        // In DVR mode: show elapsed from stream start to current playback position
        const posSec = Math.max(0, state.uptimeSec - state.dvrBehindLive);
        uptime.textContent = fmtDuration(posSec);
      } else {
        uptime.textContent = fmtUptime(startDate);
      }
      setState({ uptimeSec: Math.floor((Date.now() - startDate.getTime()) / 1000) });
    };

    tick(); // immediate — seekbar appears right away
    uptimeTimer = setInterval(tick, 1000);
  }

  function _stopUptimeTicker() {
    clearInterval(uptimeTimer);
    uptimeTimer = null;
    startDate   = null;
  }

  // ── offline ────────────────────────────────────────────────────────────────

  function applyOffline() {
    live.textContent    = '● OFFLINE';
    live.classList.add('kt-offline');
    viewers.textContent = '';
    uptime.textContent  = '';
    _stopUptimeTicker();
    // If user is currently watching a DVR rewind, don't yank vodId out from
    // under them mid-session — let them finish. The controller handles exit.
    // Only reset fields info.js owns — controller.js owns the DVR state fields.
    if (state.engine !== 'dvr') {
      setState({
        vodId:           null,
        streamStartTime: null,
        uptimeSec:       0,
      });
    }
  }

  // ── polling ────────────────────────────────────────────────────────────────

  async function initPoll() {
    if (!state.username) return;
    try {
      const data = await fetchChannelInit(state.username);
      if (data.isLive === null) return;

      if (data.title       !== null) setState({ title: data.title });
      if (data.displayName !== null) setState({ displayName: data.displayName });
      if (data.avatar      !== null) setState({ avatar: data.avatar });

      live.textContent = data.isLive ? '● LIVE' : '● OFFLINE';
      live.classList.toggle('kt-offline', !data.isLive);

      if (!data.isLive) { applyOffline(); return; }

      setState({
        vodId:           data.vodId     ?? null,
        streamStartTime: data.startTime ?? null,
      });

      // viewer count is handled by the fetch interceptor
      if (data.startTime) _startUptimeTicker(new Date(data.startTime));
    } catch (e) {
      console.warn('[KickTiny] initPoll error:', e.message);
    }
  }

  async function poll() {
    // Just refresh metadata — viewer count comes from intercepted Kick fetch
    if (!state.username) return;
    try { await initPoll(); } catch (e) { console.warn('[KickTiny] poll error:', e.message); }
  }

  // ── polling lifecycle ──────────────────────────────────────────────────────

  function _startPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    initPoll();
    pollTimer = setInterval(poll, 60_000);
  }

  function _stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ── live badge click ───────────────────────────────────────────────────────

  live.addEventListener('click', () => {
    if (!state.atLiveEdge) seekToLive();
  });

  // ── subscriptions ──────────────────────────────────────────────────────────

  subscribe(({ username, atLiveEdge, engine, dvrBehindLive, uptimeSec }) => {
    live.classList.toggle('kt-behind', !atLiveEdge);
    live.title = atLiveEdge ? '' : 'Jump to live';
    if (username && !pollTimer) _startPolling();

    // Update uptime display immediately on engine switch or DVR position change
    if (startDate) {
      if (engine === 'dvr') {
        const posSec = Math.max(0, uptimeSec - dvrBehindLive);
        uptime.textContent = fmtDuration(posSec);
      } else {
        uptime.textContent = fmtUptime(startDate);
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!state.username) return;
    if (document.hidden) {
      _stopPolling();
      // Pause the uptime ticker while tab is hidden — no point ticking
      // setState 60 times/min and re-rendering all subscribers for nothing
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    } else {
      // Resume ticker from stored startDate (don't lose the start time)
      if (startDate) _startUptimeTicker(startDate);
      _startPolling();
    }
  });

  return { live, wrap };
}


// ── ui\seekbar.js ──




function createSeekbar() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-seekbar';

  const track = document.createElement('div');
  track.className = 'kt-seekbar-track';

  // Progress region
  const prog = document.createElement('div');
  prog.className = 'kt-seekbar-prog';

  const thumb = document.createElement('div');
  thumb.className = 'kt-seekbar-thumb';

  const tip = document.createElement('div');
  tip.className = 'kt-seekbar-tip';

  track.append(prog, thumb);
  wrap.append(track, tip);

  let _dragging        = false;
  let _uptimeSec       = 0;
  // When dragging from IVS mode, we track the target here and only
  // trigger the async DVR entry once on mouseup (not every mousemove)
  let _pendingBehindSec = null;

  // ── rendering ──────────────────────────────────────────────────────────────

  function render(uiPos, uptimeSec) {
    if (uptimeSec <= 0) {
      prog.style.width = '0%';
      thumb.style.left = '0%';
      return;
    }
    const pct = Math.min(1, Math.max(0, uiPos / uptimeSec)) * 100;
    prog.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  }

  // ── tooltip ────────────────────────────────────────────────────────────────

  function showTip(e) {
    if (_uptimeSec <= 0) return;
    const rect  = track.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const uiPos = pct * _uptimeSec;
    const behind = _uptimeSec - uiPos;

    tip.textContent = behind <= 30 ? 'LIVE' : '-' + fmtDuration(behind);

    tip.style.display = 'block';

    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    // Position tip above the track. offsetTop gives track's top edge inside wrap.
    // We want tip's bottom edge to be 6px above the track's top edge.
    tip.style.bottom = (wrap.offsetHeight - track.offsetTop + 6) + 'px';
    // Horizontal: clamp within wrap width (accounting for horizontal padding)
    const hPad = rect.left - wRect.left; // = 10px (left padding)
    let left = hPad + (e.clientX - rect.left) - tipW / 2;
    left = Math.max(0, Math.min(wRect.width - tipW, left));
    tip.style.left = `${left}px`;
  }

  function hideTip() {
    if (!_dragging) tip.style.display = 'none';
  }

  // ── seek logic ─────────────────────────────────────────────────────────────

  function pctFromEvent(e) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function seekFromEvent(e) {
    if (_uptimeSec <= 0) return;

    const pct              = pctFromEvent(e);
    const uiPos     = pct * _uptimeSec;
    const behindSec = _uptimeSec - uiPos;

    render(uiPos, _uptimeSec);

    if (behindSec <= 30) {
      if (state.engine === 'dvr') dvrSeekToLive();
      _pendingBehindSec = null;
      return;
    }

    if (state.engine === 'dvr') {
      dvrSeekToBehindLive(behindSec);
      _pendingBehindSec = null;
      return;
    }

    _pendingBehindSec = behindSec;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  wrap.addEventListener('mouseenter', e => showTip(e));
  wrap.addEventListener('mousemove',  e => showTip(e));
  wrap.addEventListener('mouseleave', () => hideTip());

  wrap.addEventListener('mousedown', e => {
    _dragging = true;
    seekFromEvent(e);
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!_dragging) return;
    showTip(e);
    seekFromEvent(e);
  });

  document.addEventListener('mouseup', () => {
    if (!_dragging) return;
    _dragging = false;
    tip.style.display = 'none';

    // Fire DVR entry once, on release, if we dragged from IVS into the past
    if (_pendingBehindSec !== null && state.engine !== 'dvr') {
      const behind = _pendingBehindSec;
      _pendingBehindSec = null;
      enterDvrAtBehindLive(behind);
    } else {
      _pendingBehindSec = null;
    }
  });

  // ── state subscription ────────────────────────────────────────────────────

  subscribe(({ uptimeSec, dvrBehindLive, engine }) => {
    wrap.style.display = uptimeSec > 0 ? 'block' : 'none';
    if (uptimeSec <= 0) return;

    _uptimeSec = uptimeSec;

    if (_dragging) return;

    if (engine === 'ivs') {
      render(uptimeSec, uptimeSec);
    } else {
      render(Math.max(0, uptimeSec - dvrBehindLive), uptimeSec);
    }
  });

  wrap.style.display = 'none';
  return wrap;
}

// ── ui\bar.js ──









function createBar() {
  const bar = document.createElement('div');
  bar.className = 'kt-bar';

  const seekbar = createSeekbar();

  const controls = document.createElement('div');
  controls.className = 'kt-controls';

  const { live, wrap: infoWrap } = createInfo();

  const left = document.createElement('div');
  left.className = 'kt-bar-left';
  left.append(createPlayBtn(), live, createVolumeCtrl(), infoWrap);

  const right = document.createElement('div');
  right.className = 'kt-bar-right';
  right.append(createSpeedBtn(), createQualityBtn(), createFullscreenBtn());

  controls.append(left, right);
  bar.append(seekbar, controls);
  return bar;
}

function initBarHover(root, bar, container, topBar) {
  let hideTimer = null;
  let _lastPlaying = state.playing;

  function hide() {
    bar.classList.remove('kt-bar-visible');
    if (topBar) topBar.classList.remove('kt-top-bar-visible');
    root.classList.add('kt-idle');
    container.classList.add('kt-idle');
  }

  function show() {
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
    root.classList.remove('kt-idle');
    container.classList.remove('kt-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (state.playing) hide();
    }, 3000);
  }

  let _moveRaf = 0;
  container.addEventListener('mousemove', () => {
    if (_moveRaf) return;
    _moveRaf = requestAnimationFrame(() => { show(); _moveRaf = 0; });
  });

  container.addEventListener('mouseleave', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      bar.classList.remove('kt-bar-visible');
      if (topBar) topBar.classList.remove('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
    }, 500);
  });

  bar.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
  });

  if (topBar) {
    topBar.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      topBar.classList.add('kt-top-bar-visible');
      bar.classList.add('kt-bar-visible');
    });
  }

  // Only react to actual changes in playing state — not every setState call.
  // The position poll (500ms) and uptime ticker (1s) call setState constantly,
  // which would otherwise call show() on every tick and reset the hide timer forever.
  subscribe(({ playing }) => {
    if (playing === _lastPlaying) return;
    _lastPlaying = playing;

    if (!playing) {
      // Paused — show bars permanently until user plays again
      clearTimeout(hideTimer);
      bar.classList.add('kt-bar-visible');
      if (topBar) topBar.classList.add('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
    } else {
      // Started playing — begin auto-hide countdown
      show();
    }
  });
}

// ── ui\overlay.js ──

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'kt-overlay';
  overlay.innerHTML = `
    <button class="kt-overlay-btn" title="Play (k)">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>
    </button>
  `;

  subscribe(({ alive, playing, buffering }) => {
    overlay.classList.toggle('kt-overlay-hidden', !alive || playing || buffering);
  });

  return overlay;
}


// ── ui\topbar.js ──


function createTopBar() {
  const bar = document.createElement('div');
  bar.className = 'kt-top-bar';

  const channelLink = document.createElement('a');
  channelLink.className = 'kt-channel-link';
  channelLink.target = '_blank';
  channelLink.rel = 'noopener noreferrer';

  const title = document.createElement('div');
  title.className = 'kt-stream-title';

  const avatar = document.createElement('img');
  avatar.className = 'kt-avatar';
  avatar.alt = '';
  avatar.draggable = false;

  const channelWrap = document.createElement('div');
  channelWrap.className = 'kt-channel-wrap';
  channelWrap.appendChild(avatar);
  channelWrap.appendChild(channelLink);

  bar.append(channelWrap, title);

  let _ready = false;
  subscribe(({ username, displayName, avatar: avatarUrl, title: stateTitle }) => {
    if (username && !_ready) {
      _ready = true;
      channelLink.href = `https://www.kick.com/${username}`;
    }
    if (displayName && channelLink.textContent !== displayName) {
      channelLink.textContent = displayName;
    }
    if (avatarUrl && avatar.src !== avatarUrl) {
      avatar.src = avatarUrl;
    }
    if (stateTitle && stateTitle !== title.textContent) {
      title.textContent = stateTitle;
    }
  });

  return bar;
}


// ── main.js ──








const CSS = `:root{--kt-black:#0d0d0d;--kt-white:#f0f0f0;--kt-green:#4fc724;--kt-dim:rgba(255,255,255,0.55);--kt-bar-h:48px;--kt-radius:5px;--kt-font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--kt-size:13px;--kt-trans:0.2s ease}#kt-root{position:absolute;inset:0;z-index:9999;pointer-events:none;font-family:var(--kt-font);font-size:var(--kt-size);color:var(--kt-white);user-select:none;-webkit-user-select:none}#kt-root.kt-idle{cursor:none}.kt-idle,.kt-idle *{cursor:none !important}.kt-top-bar{position:absolute;top:0;left:0;right:0;padding:10px 14px;display:flex;flex-direction:column;gap:2px;background:linear-gradient(to bottom,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.5) 60%,transparent 100%);pointer-events:all;opacity:0;transition:opacity var(--kt-trans)}.kt-top-bar-visible{opacity:1}.kt-channel-wrap{display:flex;align-items:center;gap:8px}.kt-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1.5px solid rgba(255,255,255,0.2)}.kt-channel-link{font-size:15px;font-weight:700;color:var(--kt-white);text-decoration:none;line-height:1.2;pointer-events:auto}.kt-channel-link:hover{color:var(--kt-green)}.kt-stream-title{font-size:13px;color:var(--kt-white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;padding-bottom:2px}.kt-bar{position:absolute;bottom:0;left:0;right:0;display:flex;flex-direction:column;padding:0;gap:0;background:linear-gradient(to top,rgba(0,0,0,0.75) 0%,transparent 100%);pointer-events:all;opacity:0;transition:opacity var(--kt-trans);overflow:visible}.kt-bar-visible{opacity:1}.kt-controls{height:var(--kt-bar-h);display:flex;align-items:stretch;justify-content:space-between;padding:0 10px;gap:6px;overflow:visible}.kt-bar-left,.kt-bar-right{display:flex;align-items:center;gap:4px;overflow:visible}.kt-seekbar{width:100%;padding:10px 10px 4px;box-sizing:border-box;cursor:pointer;position:relative}.kt-seekbar-track{position:relative;height:3px;border-radius:2px;background:rgba(255,255,255,0.25);transition:height var(--kt-trans)}.kt-seekbar:hover .kt-seekbar-track{height:5px}.kt-seekbar-unavail{position:absolute;right:0;left:auto;top:0;height:100%;width:0%;border-radius:0 2px 2px 0;pointer-events:none;z-index:0;background:repeating-linear-gradient( -45deg,rgba(255,255,255,0.08) 0px,rgba(255,255,255,0.08) 3px,rgba(255,255,255,0.03) 3px,rgba(255,255,255,0.03) 6px )}.kt-seekbar-prog{position:absolute;left:0;top:0;height:100%;width:0%;background:var(--kt-green);border-radius:2px;pointer-events:none;z-index:1}.kt-seekbar-thumb{position:absolute;top:50%;left:0%;width:13px;height:13px;border-radius:50%;background:#fff;transform:translate(-50%,-50%) scale(0);transition:transform 0.15s ease;pointer-events:none;z-index:2}.kt-seekbar:hover .kt-seekbar-thumb{transform:translate(-50%,-50%) scale(1)}.kt-seekbar-tip{position:absolute;display:none;background:rgba(18,18,18,0.9);color:var(--kt-white);font-size:11px;font-weight:600;padding:3px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;user-select:none}.kt-seekbar-tip.kt-tip-unavail{opacity:0.6;background:rgba(18,18,18,0.7)}.kt-btn:focus-visible,.kt-popup-item:focus-visible,.kt-channel-link:focus-visible,.kt-overlay-btn:focus-visible{outline:2px solid var(--kt-green);outline-offset:2px}.kt-btn{background:none;border:none;padding:0 8px;height:32px;min-width:32px;align-self:center;cursor:pointer;color:var(--kt-white);display:flex;align-items:center;justify-content:center;border-radius:var(--kt-radius);transition:color var(--kt-trans),background var(--kt-trans);line-height:0}.kt-btn:hover{color:var(--kt-green);background:rgba(255,255,255,0.08)}.kt-btn svg{width:20px;height:20px}@keyframes kt-spin{to{transform:rotate(360deg)}}.kt-spin{animation:kt-spin 0.8s linear infinite}.kt-vol-wrap{display:flex;align-items:center;align-self:center;height:32px;gap:4px}.kt-vol-clip{display:flex;align-items:center;align-self:stretch;overflow:hidden;max-width:0;transition:max-width var(--kt-trans)}.kt-vol-wrap:hover .kt-vol-clip,.kt-vol-clip:focus-within{max-width:74px}.kt-vol-slider{-webkit-appearance:none;appearance:none;width:70px;flex-shrink:0;margin-left:4px;height:20px;padding:0;border-radius:2px;background:transparent;outline:none;cursor:pointer;display:block}.kt-vol-slider::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:rgba(255,255,255,0.3)}.kt-vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:var(--kt-green);cursor:pointer}.kt-vol-slider::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--kt-green);cursor:pointer;border:none}.kt-vol-slider::-moz-range-track{height:3px;border-radius:2px;background:rgba(255,255,255,0.3)}.kt-vol-slider::-moz-range-progress{height:3px;border-radius:2px;background:var(--kt-green)}.kt-info{display:flex;align-items:center;align-self:center;gap:8px;padding:0 6px;height:32px}.kt-live-badge{background:#b30906;color:#fff;font-size:10px;font-weight:600;letter-spacing:0.05em;padding:0 10px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--kt-radius);line-height:1;transition:background var(--kt-trans)}.kt-live-badge.kt-offline{background:#555}.kt-live-badge.kt-behind{background:#555;cursor:pointer}.kt-live-badge.kt-behind:hover{background:#eb0400}.kt-viewers,.kt-uptime{color:var(--kt-dim);font-size:12px;white-space:nowrap;line-height:1}.kt-popup-wrap{position:relative;align-self:stretch;display:flex;align-items:center}.kt-popup{position:fixed;min-width:120px;overflow-y:auto;background:rgba(18,18,18,0.97);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:6px;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,0.6);font-family:var(--kt-font);pointer-events:all;cursor:default}.kt-popup[hidden]{display:none}.kt-popup-item{display:block;width:100%;padding:7px 12px;text-align:left;background:none;border:none;color:var(--kt-white);font-size:var(--kt-size);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;white-space:nowrap;border-radius:6px;transition:color 0.2s ease,background 0.2s ease}.kt-popup-item:hover{color:var(--kt-white);background:rgba(255,255,255,0.1)}.kt-popup-item.kt-active{color:var(--kt-green)}.kt-qual-btn,.kt-speed-btn{font-size:12px;font-weight:600;padding:0 10px;height:28px;min-width:unset;letter-spacing:0.02em}.kt-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;transition:opacity var(--kt-trans)}.kt-overlay-hidden{opacity:0}.kt-overlay-btn{pointer-events:auto;background:rgba(0,0,0,0.5);border:none;border-radius:50%;width:60px;height:60px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--kt-white);transition:transform var(--kt-trans),background var(--kt-trans)}.kt-overlay-hidden .kt-overlay-btn{pointer-events:none}.kt-overlay-btn:hover{transform:scale(1.1);background:rgba(83,252,24,0.25);color:var(--kt-green)}.kt-overlay-btn svg{width:32px;height:32px}`;

function injectStyles(css) {
  const style = document.createElement('style');
  style.id = 'kt-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function getUsername() {
  return location.pathname.replace(/^\//, '').split('/')[0] || '';
}

function hideNativeControls() {
  const style = document.createElement('style');
  style.textContent = `.z-controls { display: none !important; }`;
  document.head.appendChild(style);
}

function createRoot(container) {
  const root = document.createElement('div');
  root.id = 'kt-root';
  container.appendChild(root);
  return root;
}

function waitForContainer(maxAttempts = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const c = document.querySelector('.aspect-video-responsive')
        || document.querySelector('div[class*="aspect-video"]');
      if (c) { resolve(c); return; }
      if (++attempts >= maxAttempts) { reject(new Error('[KickTiny] Container not found')); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

let _initialized = false;
async function init() {
  if (_initialized) return;
  _initialized = true;
  try {
    const container = await waitForContainer();
    injectStyles(CSS);
    hideNativeControls();
    const username = getUsername();
    setState({ username });

    const root   = createRoot(container);
    const topBar = createTopBar();
    const bar    = createBar();

    root.appendChild(createOverlay());
    root.appendChild(topBar);
    root.appendChild(bar);

    initBarHover(root, bar, container, topBar);

    let _clickTimer = null;
    container.addEventListener('click', e => {
      if (bar.contains(e.target) || topBar.contains(e.target)) return;
      if (_clickTimer) {
        clearTimeout(_clickTimer);
        _clickTimer = null;
        toggleFullscreen();
      } else {
        _clickTimer = setTimeout(() => {
          _clickTimer = null;
          togglePlay();
        }, 250);
      }
    });

    initAdapter();
    bindKeys();

    // Pre-create the DVR video element and load hls.js in the background.
    // No URL is fetched here — DVR init happens lazily when the user seeks.
    setupDvrContainer(container).catch(e => {
      console.warn('[KickTiny DVR] Container setup failed:', e.message);
    });

    console.log('[KickTiny] Initialized for', username || 'unknown');
  } catch (e) {
    console.warn(e.message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();