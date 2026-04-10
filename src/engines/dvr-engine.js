// ── engines/dvr-engine.js ────────────────────────────────────────────────────
// HLS.js DVR controller. Extracted from dvr/controller.js.
// Receives store and api as constructor parameters — no global imports.
//
// Usage:
//   const dvr = createDvrEngine(store, api);
//   await dvr.setupContainer(container);
//   await dvr.enter(behindSec);
//   dvr.seekToBehindLive(60);
//   dvr.exit();
//   dvr.destroy();

import { createManifestBuilder, SYNTHETIC_URL } from './manifest-builder.js';
import {
  LIVE_EDGE_BEHIND_SEC,
  SEEKABLE_WAIT_MS,
  EXPIRY_LEAD_MS,
  FALLBACK_REFRESH_MS,
  CATCH_UP_INTERVAL_MS,
  NEAR_END_THRESHOLD_SEC,
  POSITION_POLL_INTERVAL_MS,
} from '../constants.js';

export function createDvrEngine(store, api) {
  let _Hls          = null;
  let _hls          = null;
  let _dvrVideo     = null;
  let _nativeVideo  = null;
  let _posTimer     = null;
  let _expiryTimer  = null;
  let _catchUpTimer = null;
  let _refreshing   = false;
  let _manifestOffset = 0;

  const _mb = createManifestBuilder();

  // ── hls.js loader ──────────────────────────────────────────────────────────

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

  // ── custom hls.js loader (serves synthetic manifest) ───────────────────────

  function _buildCustomLoader(DefaultLoader) {
    return class SyntheticLoader extends DefaultLoader {
      load(context, config, callbacks) {
        if (context.url === SYNTHETIC_URL) {
          const data = _mb.generate();
          const now  = performance.now();
          setTimeout(() => callbacks.onSuccess(
            { data, url: SYNTHETIC_URL },
            {
              aborted: false, loaded: data.length, total: data.length, retry: 0,
              trequest: now, tfirst: now, tload: now, chunkCount: 0, bwEstimate: Infinity,
              loading: { start: now, first: now, end: now },
              parsing: { start: now, end: now },
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
      console.log('[KickTiny DVR] Manifest parsed —', data.levels.length, 'level(s),', _mb.segmentCount(), 'segments');
      store.setState({ dvrAvailable: true });
    });
    _hls.on(_Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      console.error('[KickTiny DVR] Fatal error:', data.details);
      _hls.recoverMediaError();
    });
  }

  function _destroyHls() {
    if (_hls) { _hls.destroy(); _hls = null; }
  }

  // ── snapshot fetch ─────────────────────────────────────────────────────────

  async function _fetchAndMergeSnapshot(snapshotUrl) {
    try {
      const res  = await fetch(snapshotUrl);
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const text = await res.text();

      if (text.includes('#EXT-X-STREAM-INF')) {
        const qualities = _mb.parseQualities(text);
        if (qualities.length) store.setState({ dvrQualities: qualities });

        const s          = store.getState();
        const variantUrl = _mb.pickVariant(text, snapshotUrl, s.quality?.name ?? null);
        const varRes     = await fetch(variantUrl);
        if (!varRes.ok) throw new Error(`variant playlist ${varRes.status}`);
        return _mb.merge(await varRes.text(), variantUrl);
      }
      return _mb.merge(text, snapshotUrl);
    } catch (e) {
      console.warn('[KickTiny DVR] Snapshot fetch failed:', e.message);
      return 0;
    }
  }

  // ── seekable window ────────────────────────────────────────────────────────

  async function _waitForSeekable(timeoutMs = SEEKABLE_WAIT_MS) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (_dvrVideo?.seekable?.length > 0) {
        const i   = _dvrVideo.seekable.length - 1;
        const end = _dvrVideo.seekable.end(i), start = _dvrVideo.seekable.start(i);
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

  // ── JWT expiry ─────────────────────────────────────────────────────────────

  function _getTokenExpiryMs(url) {
    try {
      const jwt   = new URL(url).searchParams.get('init');
      if (!jwt) return null;
      const parts = jwt.split('.');
      if (parts.length < 2) return null;
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const payload = JSON.parse(atob(b64));
      return payload?.exp ? payload.exp * 1000 : null;
    } catch { return null; }
  }

  function _scheduleExpiryRefresh(url) {
    clearTimeout(_expiryTimer);
    const expMs = _getTokenExpiryMs(url);
    const delay = expMs
      ? Math.max(5000, expMs - Date.now() - EXPIRY_LEAD_MS)
      : FALLBACK_REFRESH_MS;
    if (expMs) console.log('[KickTiny DVR] Token expires in', Math.round((expMs - Date.now()) / 1000), 's — refresh in', Math.round(delay / 1000), 's');
    _expiryTimer = setTimeout(() => {
      if (store.getState().engine === 'dvr' && !_refreshing) _fetchAndExtendManifest();
    }, delay);
  }

  async function _fetchAndExtendManifest() {
    if (_refreshing || !store.getState().vodId) return;
    _refreshing = true;
    console.log('[KickTiny DVR] Fetching fresh VOD URL (expiry refresh)');
    const newUrl = await api.fetchVodPlaybackUrl(store.getState().vodId);
    if (newUrl) { await _fetchAndMergeSnapshot(newUrl); _scheduleExpiryRefresh(newUrl); }
    _refreshing = false;
  }

  // ── catch-up timer (segment extrapolation) ─────────────────────────────────

  function _startCatchUpTimer() {
    if (_catchUpTimer) return;
    console.log('[KickTiny DVR] Entering catch-up mode (extrapolation)');
    _mb.extrapolate();
    _catchUpTimer = setInterval(() => {
      if (store.getState().engine !== 'dvr') { _stopCatchUpTimer(); return; }
      const win = _getSeekableWindow();
      if (win && _mb.nearEnd(_dvrVideo.currentTime, win.end)) _mb.extrapolate();
    }, CATCH_UP_INTERVAL_MS);
  }

  function _stopCatchUpTimer() {
    if (!_catchUpTimer) return;
    clearInterval(_catchUpTimer); _catchUpTimer = null;
    console.log('[KickTiny DVR] Exiting catch-up mode');
  }

  // ── position poll ──────────────────────────────────────────────────────────

  function _startPositionPoll() {
    _stopPositionPoll();
    _posTimer = setInterval(() => {
      if (!_dvrVideo || store.getState().engine !== 'dvr') { _stopPositionPoll(); return; }
      const win            = _getSeekableWindow();
      const manifestOffset = win ? Math.max(0, store.getState().uptimeSec - win.end) : _manifestOffset;
      const behindLive     = win ? Math.max(0, (win.end - _dvrVideo.currentTime) + manifestOffset) : 0;
      const windowSec      = win ? Math.max(0, win.end - win.start) : 0;

      store.setState({ dvrBehindLive: behindLive, dvrWindowSec: windowSec, atLiveEdge: behindLive <= LIVE_EDGE_BEHIND_SEC });

      if (win) {
        const secsFromEnd = win.end - _dvrVideo.currentTime;
        if (secsFromEnd < NEAR_END_THRESHOLD_SEC) {
          _startCatchUpTimer();
        } else if (secsFromEnd > NEAR_END_THRESHOLD_SEC * 2 && _catchUpTimer) {
          _stopCatchUpTimer();
        }
      }
    }, POSITION_POLL_INTERVAL_MS);
  }

  function _stopPositionPoll() { clearInterval(_posTimer); _posTimer = null; }

  // ── quality switch ─────────────────────────────────────────────────────────

  async function _switchVariant(q) {
    if (!store.getState().vodId) return;
    const savedPos = _dvrVideo?.currentTime ?? 0;
    const vodUrl   = await api.fetchVodPlaybackUrl(store.getState().vodId);
    if (!vodUrl) return;

    const res  = await fetch(vodUrl);
    if (!res.ok) { console.warn('[KickTiny DVR] variant manifest fetch failed:', res.status); return; }
    const text = await res.text();
    if (!text.includes('#EXT-X-STREAM-INF')) return;

    const variantUrl = _mb.pickVariant(text, vodUrl, q.name);
    if (!variantUrl || variantUrl === vodUrl) return;

    console.log('[KickTiny DVR] Switching to variant:', q.name);
    _mb.reset();
    const varRes = await fetch(variantUrl);
    if (!varRes.ok) { console.warn('[KickTiny DVR] variant fetch failed:', varRes.status); return; }
    _mb.merge(await varRes.text(), variantUrl);
    _scheduleExpiryRefresh(vodUrl);
    _destroyHls(); _createHlsInstance();

    const onReady = () => { _dvrVideo.currentTime = savedPos; _dvrVideo.play().catch(() => {}); };
    if (_dvrVideo.readyState >= 1) onReady();
    else _dvrVideo.addEventListener('loadedmetadata', onReady, { once: true });

    store.setState({ dvrQuality: q });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function _returnToLiveUi() {
    if (_dvrVideo) _dvrVideo.style.display = 'none';
    if (_nativeVideo) _nativeVideo.style.visibility = 'visible';
  }

  // ── PlaybackEngine interface ───────────────────────────────────────────────

  async function setupContainer(container) {
    if (_dvrVideo) return;
    _nativeVideo = container.querySelector('video');
    if (!_nativeVideo) { console.warn('[KickTiny DVR] No native video found'); return; }
    const cs = window.getComputedStyle(container);
    if (cs.position === 'static') container.style.position = 'relative';
    _dvrVideo = document.createElement('video');
    _dvrVideo.playsInline = true;
    _dvrVideo.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;z-index:2;background:#000';
    container.appendChild(_dvrVideo);
    _dvrVideo.addEventListener('playing',      () => { if (store.getState().engine === 'dvr') store.setState({ playing: true,  buffering: false }); });
    _dvrVideo.addEventListener('pause',        () => { if (store.getState().engine === 'dvr') store.setState({ playing: false }); });
    _dvrVideo.addEventListener('waiting',      () => { if (store.getState().engine === 'dvr') store.setState({ buffering: true }); });
    _dvrVideo.addEventListener('volumechange', () => {
      if (store.getState().engine === 'dvr') store.setState({ volume: Math.round(_dvrVideo.volume * 100), muted: _dvrVideo.muted });
    });
    console.log('[KickTiny DVR] Container ready');
  }

  async function enter(behindSec) {
    // Preconditions checked by engine-manager before calling
    const s         = store.getState();
    const wasVolume = s.volume;
    const wasMuted  = s.muted;
    store.setState({ buffering: true });

    if (!_Hls) {
      try { _Hls = await _loadHlsJs(); } catch (e) {
        console.warn('[KickTiny DVR] hls.js load failed:', e.message);
        store.setState({ buffering: false }); throw e;
      }
      if (!_Hls.isSupported()) {
        store.setState({ buffering: false });
        throw new Error('hls.js not supported');
      }
    }

    _nativeVideo.style.visibility = 'hidden';
    _dvrVideo.style.display  = 'block';
    _dvrVideo.volume         = wasVolume / 100;
    _dvrVideo.muted          = wasMuted;
    _dvrVideo.playbackRate   = s.rate;

    const url = await api.fetchVodPlaybackUrl(s.vodId);
    if (!url) { store.setState({ buffering: false }); throw new Error('Could not fetch VOD URL'); }

    _mb.reset();
    const appended = await _fetchAndMergeSnapshot(url);
    if (appended === 0) { store.setState({ buffering: false }); throw new Error('No segments in snapshot'); }

    _destroyHls(); _createHlsInstance();

    const win = await _waitForSeekable();
    if (!win) { store.setState({ buffering: false }); throw new Error('Seekable window never available'); }

    _manifestOffset = Math.max(0, s.uptimeSec - win.end);
    const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - _manifestOffset)));
    console.log('[KickTiny DVR] Seekable', win.start.toFixed(1), '–', win.end.toFixed(1),
      '| offset', _manifestOffset.toFixed(1), '→ seeking to', target.toFixed(1));
    _dvrVideo.currentTime = target;

    const trueBehind = Math.max(0, win.end - target) + _manifestOffset;
    store.setState({
      engine:        'dvr',
      buffering:     false,
      dvrAvailable:  true,
      dvrWindowSec:  Math.max(0, win.end - win.start),
      dvrBehindLive: trueBehind,
      atLiveEdge:    trueBehind <= LIVE_EDGE_BEHIND_SEC,
    });

    _startPositionPoll();
    _scheduleExpiryRefresh(url);
    _dvrVideo.play().catch(() => {});

    // Match IVS quality selection if possible
    const st = store.getState();
    if (st.quality !== null && st.dvrQualities?.length) {
      const match = st.dvrQualities.find(q => q.name === st.quality?.name)
        || st.dvrQualities.find(q => q.name.replace(/\d+$/, '') === st.quality?.name.replace(/\d+$/, ''));
      if (match) store.setState({ dvrQuality: match });
    }

    console.log('[KickTiny DVR] DVR mode active');
  }

  function exit() {
    if (!_dvrVideo || !_nativeVideo) return;
    _dvrVideo.pause();
    _destroyHls();
    _returnToLiveUi();
    clearTimeout(_expiryTimer); _expiryTimer = null;
    _stopPositionPoll();
    _stopCatchUpTimer();
    _manifestOffset = 0;
    store.setState({ engine: 'ivs', atLiveEdge: true, dvrBehindLive: 0, dvrWindowSec: 0, buffering: false });
    console.log('[KickTiny DVR] Exited DVR mode');
  }

  function play()  { _dvrVideo?.play().catch(() => {}); }
  function pause() { _dvrVideo?.pause(); }

  function setVolume(pct) {
    if (!_dvrVideo) return;
    _dvrVideo.volume = pct / 100;
    if (pct > 0) _dvrVideo.muted = false;
    store.setState({ volume: pct, muted: _dvrVideo.muted });
  }

  function setMuted(m) {
    if (!_dvrVideo) return;
    _dvrVideo.muted = m;
    store.setState({ muted: m });
  }

  function setRate(r) {
    if (!_dvrVideo) return;
    _dvrVideo.playbackRate = r;
    store.setState({ rate: r });
  }

  function setQuality(q) {
    if (!_hls) return;
    if (q === 'auto') {
      const qs  = store.getState().dvrQualities || [];
      const mid = qs[Math.floor(qs.length / 2)];
      if (mid) _switchVariant(mid);
      store.setState({ dvrQuality: null });
    } else {
      const target = typeof q === 'object' ? q : (store.getState().dvrQualities?.find(x => x.index === q));
      if (target) _switchVariant(target);
    }
  }

  function seekToBehindLive(behindSec) {
    if (!_dvrVideo) return;
    const win = _getSeekableWindow();
    if (!win) return;
    const manifestOffset = Math.max(0, store.getState().uptimeSec - win.end);
    const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - manifestOffset)));
    _dvrVideo.currentTime = target;
  }

  function getVideo() { return _dvrVideo; }

  function destroy() {
    _destroyHls();
    _stopPositionPoll();
    _stopCatchUpTimer();
    clearTimeout(_expiryTimer); _expiryTimer = null;
  }

  return {
    setupContainer, enter, exit, destroy,
    play, pause, setVolume, setMuted, setRate,
    setQuality, seekToBehindLive,
    seekToLive: exit,  // unified interface alias
    getVideo,
  };
}
