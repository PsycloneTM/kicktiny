// ==UserScript==
// @name         KickTiny
// @namespace    https://github.com/reda777/kicktiny
// @version      0.1.6
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
  alive: false,
  playing: false,
  buffering: false,
  qualities: [],
  quality: null,
  autoQuality: true,
  volume: 50,
  muted: false,
  fullscreen: false,
  rate: 1,
  atLiveEdge: true,
  username: '',
  displayName: '',
  avatar: '',
  viewers: null,
  uptime: null,
  title: null,
  error: null,
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

// IVS event string literals — validated against Kick's embedded IVS 1.49 player
const EV = {
  STATE_CHANGED:         'PlayerStateChanged',
  QUALITY_CHANGED:       'PlayerQualityChanged',
  VOLUME_CHANGED:        'PlayerVolumeChanged',
  MUTED_CHANGED:         'PlayerMutedChanged',
  PLAYBACK_RATE_CHANGED: 'PlayerPlaybackRateChanged',
  ERROR:                 'PlayerError',
  RECOVERABLE_ERROR:     'PlayerRecoverableError',
};

// IVS PlayerState string literals
const PS = {
  PLAYING:   'Playing',
  BUFFERING: 'Buffering',
};

let _player = null;
let _boundPlayer = null; // guard against duplicate onPlayerReady binding
let _retryTimer = null;
let _latencyTimer = null;
const MAX_RETRIES = 40;
const RETRY_INTERVAL = 500;

// Empirically, Kick's embedded IVS player gets permanently stuck on worker
// error codes -2 and -3. A page reload is the only reliable recovery.
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
  // Require a broader method surface to reduce false positives
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
  // Guard against duplicate binding if extraction somehow runs twice
  if (!p || _boundPlayer === p) return;
  _boundPlayer = p;

  // Load saved prefs before reading player state
  const prefs = loadPrefs();

  // Sync initial state from player
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

  // Apply saved prefs to player
  if (prefs.volume !== null) p.setVolume(prefs.volume / 100);
  let qualityApplied = false;
  if (prefs.quality !== null) {
    qualityApplied = applyQualityPref(p, prefs.quality);
  }

  p.addEventListener(EV.STATE_CHANGED, e => {
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
        // IVS is refusing the quality — accept what it gives us and reset
        _reapplying = false;
        _reapplyAttempts = 0;
        setState({ quality: q, autoQuality: p.isAutoQualityMode() });
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
          // Saved quality no longer in stream — accept whatever IVS gives us
          _reapplying = false;
          _reapplyAttempts = 0;
          setState({ quality: q, autoQuality: p.isAutoQualityMode() });
        }
      }
      return;
    }

    _reapplying = false;
    _reapplyAttempts = 0;
    setState({ quality: q, autoQuality: p.isAutoQualityMode() });
  });

  p.addEventListener(EV.VOLUME_CHANGED, e => {
    const vol = typeof e === 'number' ? e : (e?.volume ?? p.getVolume());
    setState({ volume: Math.round(vol * 100) });
  });

  p.addEventListener(EV.MUTED_CHANGED, e => {
    const muted = typeof e === 'boolean' ? e : (e?.muted ?? p.isMuted());
    setState({ muted });
  });

  p.addEventListener(EV.PLAYBACK_RATE_CHANGED, e => {
    const rate = typeof e === 'number' ? e : (e?.playbackRate ?? p.getPlaybackRate());
    setState({ rate });
  });

  p.addEventListener(EV.ERROR, err => {
    setState({ error: err });
    console.error('[KickTiny] IVS Error:', err);
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

  // Retry quality pref if qualities were empty at init
  setTimeout(() => {
    const qs = p.getQualities();
    if (qs && qs.length) {
      if (state.qualities.length === 0) setState({ qualities: qs });
      if (!qualityApplied && prefs.quality !== null) {
        qualityApplied = applyQualityPref(p, prefs.quality);
      }
    }
  }, 2000);

  // Poll live edge latency every second.
  // getDuration() = live edge position, getPosition() = current position.
  // Guard against NaN/Infinity which IVS can return briefly during startup/buffering.
  clearInterval(_latencyTimer);
  _latencyTimer = setInterval(() => {
    try {
      const latency = p.getLiveLatency?.();
      if (latency == null || !isFinite(latency)) return;
      setState({ atLiveEdge: latency <= 5 });
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

// ── actions.js ──

function play() {
  if (!state.alive) return;
  getPlayer()?.play();
}

function pause() {
  if (!state.alive) return;
  getPlayer()?.pause();
}

function togglePlay() {
  if (!state.alive) return;
  state.playing ? pause() : play();
}

let _volSaveTimer = null;
function setVolume(pct) {
  const p = getPlayer();
  if (!p) return;
  const v = Math.max(0, Math.min(100, pct));
  p.setVolume(v / 100);
  if (v > 0 && p.isMuted()) p.setMuted(false);
  clearTimeout(_volSaveTimer);
  _volSaveTimer = setTimeout(() => savePrefs({ volume: v }), 300);
}

function setMuted(muted) {
  getPlayer()?.setMuted(muted);
}

function toggleMute() {
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

function setQuality(qualityObj) {
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

function setRate(r) {
  const p = getPlayer();
  if (!p) return;
  p.setPlaybackRate(Math.max(0.25, Math.min(2, r)));
}

function seekToLive() {
  const p = getPlayer();
  if (!p) return;
  const latency = p.getLiveLatency?.();
  if (latency == null || !isFinite(latency)) return;
  p.seekTo(p.getPosition() + latency);
}

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
      case 'ArrowUp': e.preventDefault(); setVolume(state.volume + 5); break;
      case 'ArrowDown': e.preventDefault(); setVolume(state.volume - 5); break;
      case 'f': toggleFullscreen(); break;
      case 'l': seekToLive(); break;
    }
  });
}


// ── ui/play.js ──

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


// ── ui/volume.js ──

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

  // Clip wrapper animates max-width for show/hide — slider stays at constant
  // 70px so the browser always has a real track for thumb position calculation.
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
    if (!_dragging) slider.value = muted ? 0 : volume; // no jitter during drag
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


// ── ui/popup.js ──
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


// ── ui/quality.js ──

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

  // Cache last state for lazy render on open
  let _q = { qualities: [], quality: null, autoQuality: true };

  setupPopupToggle(btn, popup, () => renderPopup(popup, _q.qualities, _q.quality, _q.autoQuality));

  document.body.appendChild(popup);
  wrap.append(btn);

  subscribe(({ qualities, quality, autoQuality }) => {
    _q = { qualities, quality, autoQuality };
    btn.textContent = autoQuality ? 'AUTO' : (quality?.name ?? '?');
    // Only rebuild DOM if popup is visible
    if (!popup.hidden) renderPopup(popup, qualities, quality, autoQuality);
  });

  return wrap;
}

function renderPopup(popup, qualities, current, autoQ) {
  popup.innerHTML = '';
  popup.appendChild(makeItem('Auto', autoQ, () => setQuality('auto'), popup));
  (qualities || []).forEach(q => {
    popup.appendChild(makeItem(q.name, !autoQ && current?.name === q.name, () => setQuality(q), popup));
  });
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


// ── ui/speed.js ──

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

  // Build speed items
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


// ── ui/fullscreen.js ──

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


// ── utils/format.js ──
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
  return get(`/api/v2/channels/${username}`);
}

async function fetchChannelInit(username) {
  try {
    const data = await fetchChannelInfo(username);
    const ls = data?.livestream ?? null;
    return {
      isLive: ls !== null,
      displayName: data?.user?.username ?? null,
      avatar: data?.user?.profile_pic ?? null,
      livestreamId: ls?.id ?? null,
      viewers: ls?.viewer_count ?? null,
      startTime: ls?.start_time ?? null,
      title: ls?.session_title ?? null,
    };
  } catch {
    return { isLive: null, displayName: null, avatar: null, livestreamId: null, viewers: null, startTime: null, title: null };
  }
}

async function fetchViewerCount(livestreamId) {
  try {
    const res = await fetch(
      `${BASE}/current-viewers?ids[]=${encodeURIComponent(livestreamId)}`,
      { credentials: 'omit', headers: { 'Accept': 'application/json' } },
    );
    if (!res.ok) throw new Error(`${res.status} /current-viewers`);
    const data = await res.json();
    const row = Array.isArray(data)
      ? data.find(x => x?.livestream_id === livestreamId)
      : null;
    return row?.viewers ?? null;
  } catch {
    return null;
  }
}


// ── ui/info.js ──

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

  wrap.append(live, viewers, uptime);

  let pollTimer = null;
  let uptimeTimer = null;
  let startDate = null;
  let _livestreamId = null;

  function applyOffline() {
    live.textContent = '● OFFLINE';
    live.classList.add('kt-offline');
    viewers.textContent = '';
    uptime.textContent = '';
    clearInterval(uptimeTimer);
    uptimeTimer = null;
    startDate = null;
    _livestreamId = null;
  }

  function applyStartTime(startTime) {
    if (!startTime) return;
    const newStart = new Date(startTime);
    if (!startDate || newStart.getTime() !== startDate.getTime()) {
      startDate = newStart;
      clearInterval(uptimeTimer);
      uptimeTimer = setInterval(() => { uptime.textContent = fmtUptime(startDate); }, 1000);
      uptime.textContent = fmtUptime(startDate);
    }
  }

  async function initPoll() {
    if (!state.username) return;
    const data = await fetchChannelInit(state.username);

    if (data.isLive === null) return; // network error, keep current UI

    if (data.title !== null) setState({ title: data.title });
    if (data.displayName !== null) setState({ displayName: data.displayName });
    if (data.avatar !== null) setState({ avatar: data.avatar });

    live.textContent = data.isLive ? '● LIVE' : '● OFFLINE';
    live.classList.toggle('kt-offline', !data.isLive);

    if (!data.isLive) { applyOffline(); return; }

    _livestreamId = data.livestreamId;
    if (data.viewers !== null) viewers.textContent = fmtViewers(data.viewers) + ' watching';
    applyStartTime(data.startTime);
  }

  async function poll() {
    if (!state.username) return;

    if (!_livestreamId) {
      await initPoll();
      return;
    }

    const count = await fetchViewerCount(_livestreamId);

    if (count === null) {
      await initPoll();
      return;
    }

    viewers.textContent = fmtViewers(count) + ' watching';
  }

  live.addEventListener('click', () => {
    if (!state.atLiveEdge) seekToLive();
  });

  subscribe(({ username, atLiveEdge }) => {
    live.classList.toggle('kt-behind', !atLiveEdge);
    live.title = atLiveEdge ? '' : 'Jump to live';
    if (username && !pollTimer) {
      initPoll();
      pollTimer = setInterval(poll, 30_000);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!state.username) return;
    clearInterval(pollTimer);
    pollTimer = null;
    if (!document.hidden) {
      initPoll(); // re-sync title/start time after tab was hidden
      pollTimer = setInterval(poll, 30_000);
    }
  });

  return wrap;
}


// ── ui/bar.js ──

function createBar() {
  const bar = document.createElement('div');
  bar.className = 'kt-bar';

  const left = document.createElement('div');
  left.className = 'kt-bar-left';
  left.append(createPlayBtn(), createVolumeCtrl(), createInfo());

  const right = document.createElement('div');
  right.className = 'kt-bar-right';
  right.append(createSpeedBtn(), createQualityBtn(), createFullscreenBtn());

  bar.append(left, right);
  return bar;
}

function initBarHover(root, bar, container, topBar) {
  let hideTimer = null;

  const show = () => {
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
    root.classList.remove('kt-idle');
    container.classList.remove('kt-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (state.playing) {
        bar.classList.remove('kt-bar-visible');
        if (topBar) topBar.classList.remove('kt-top-bar-visible');
        root.classList.add('kt-idle');
        container.classList.add('kt-idle');
      }
    }, 3000);
  };

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

  subscribe(({ playing }) => {
    if (!playing) {
      bar.classList.add('kt-bar-visible');
      if (topBar) topBar.classList.add('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
      clearTimeout(hideTimer);
    } else {
      show();
    }
  });
}


// ── ui/overlay.js ──

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


// ── ui/topbar.js ──

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

const CSS = `:root{--kt-black:#0d0d0d;--kt-white:#f0f0f0;--kt-green:#53fc18;--kt-dim:rgba(255,255,255,0.55);--kt-bar-h:48px;--kt-radius:5px;--kt-font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--kt-size:13px;--kt-trans:0.2s ease}#kt-root{position:absolute;inset:0;z-index:9999;pointer-events:none;font-family:var(--kt-font);font-size:var(--kt-size);color:var(--kt-white);user-select:none;-webkit-user-select:none}#kt-root.kt-idle{cursor:none}.kt-idle,.kt-idle *{cursor:none !important}.kt-top-bar{position:absolute;top:0;left:0;right:0;padding:10px 14px;display:flex;flex-direction:column;gap:2px;background:linear-gradient(to bottom,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.5) 60%,transparent 100%);opacity:0;transition:opacity var(--kt-trans)}.kt-top-bar-visible{opacity:1}.kt-channel-wrap{display:flex;align-items:center;gap:8px}.kt-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1.5px solid rgba(255,255,255,0.2)}.kt-channel-link{font-size:15px;font-weight:700;color:var(--kt-white);text-decoration:none;line-height:1.2;pointer-events:auto}.kt-channel-link:hover{color:var(--kt-green)}.kt-stream-title{font-size:13px;color:var(--kt-white);white-space:nowrap;overflow-x:hidden;text-overflow:ellipsis;line-height:1.3}.kt-bar{position:absolute;bottom:0;left:0;right:0;height:var(--kt-bar-h);display:flex;align-items:center;justify-content:space-between;padding:0 10px;gap:6px;background:linear-gradient(to top,rgba(0,0,0,0.75) 0%,transparent 100%);pointer-events:all;opacity:0;transition:opacity var(--kt-trans);overflow:visible}.kt-bar-visible{opacity:1}.kt-bar-left,.kt-bar-right{display:flex;align-items:center;gap:4px;overflow:visible}.kt-btn{background:none;border:none;padding:0 6px;align-self:stretch;cursor:pointer;color:var(--kt-white);display:flex;align-items:center;justify-content:center;border-radius:var(--kt-radius);transition:color var(--kt-trans),background var(--kt-trans);line-height:0}.kt-btn:hover{color:var(--kt-green);background:rgba(255,255,255,0.08)}.kt-btn svg{width:20px;height:20px}@keyframes kt-spin{to{transform:rotate(360deg)}}.kt-spin{animation:kt-spin 0.8s linear infinite}.kt-vol-wrap{display:flex;align-items:center;align-self:stretch;gap:4px}.kt-vol-clip{display:flex;align-items:center;align-self:stretch;overflow:hidden;max-width:0;transition:max-width var(--kt-trans)}.kt-vol-wrap:hover .kt-vol-clip,.kt-vol-clip:focus-within{max-width:74px}.kt-vol-slider{-webkit-appearance:none;appearance:none;width:70px;flex-shrink:0;margin-left:4px;height:3px;border-radius:2px;background:rgba(255,255,255,0.3);outline:none;cursor:pointer}.kt-vol-slider::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:rgba(255,255,255,0.3)}.kt-vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:var(--kt-green);cursor:pointer}.kt-vol-slider::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--kt-green);cursor:pointer;border:none}.kt-info{display:flex;align-items:center;align-self:stretch;gap:6px;padding:0 4px}.kt-live-badge{background:#eb0400;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.05em;padding:0 8px;align-self:stretch;display:flex;align-items:center;border-radius:var(--kt-radius);line-height:1;transition:background var(--kt-trans)}.kt-live-badge.kt-offline{background:#555}.kt-live-badge.kt-behind{background:#555;cursor:pointer}.kt-live-badge.kt-behind:hover{background:#eb0400}.kt-viewers,.kt-uptime{color:var(--kt-dim);font-size:12px;white-space:nowrap}.kt-popup-wrap{position:relative;align-self:stretch;display:flex;align-items:center}.kt-popup{position:fixed;min-width:120px;overflow-y:auto;background:rgba(18,18,18,0.97);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:6px;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,0.6);font-family:var(--kt-font)}.kt-popup[hidden]{display:none}.kt-popup-item{display:block;width:100%;padding:7px 12px;text-align:left;background:none;border:none;color:var(--kt-white);font-size:var(--kt-size);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;white-space:nowrap;border-radius:6px;transition:color 0.2s ease,background 0.2s ease}.kt-popup-item:hover{color:var(--kt-white);background:rgba(255,255,255,0.1)}.kt-popup-item.kt-active{color:var(--kt-green)}.kt-qual-btn,.kt-speed-btn{font-size:12px;font-weight:600;padding:6px 8px;letter-spacing:0.02em}.kt-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:all;transition:opacity var(--kt-trans)}.kt-overlay-hidden{opacity:0;pointer-events:none}.kt-overlay-btn{background:rgba(0,0,0,0.5);border:none;border-radius:50%;width:60px;height:60px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--kt-white);transition:transform var(--kt-trans),background var(--kt-trans)}.kt-overlay-btn:hover{transform:scale(1.1);background:rgba(83,252,24,0.25);color:var(--kt-green)}.kt-overlay-btn svg{width:32px;height:32px}`;

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
    setState({ username: getUsername() });

    const root = createRoot(container);
    const topBar = createTopBar();
    const bar = createBar();

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

    console.log('[KickTiny] Initialized for', getUsername() || 'unknown');
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