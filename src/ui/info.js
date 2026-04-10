import { fmtViewers, fmtUptime, fmtDuration } from '../utils/format.js';
import { POLL_INTERVAL_MS } from '../constants.js';

export function createInfo(store, actions, viewerInterceptor, api) {
  const wrap    = document.createElement('div');  wrap.className    = 'kt-info';
  const live    = document.createElement('span'); live.className    = 'kt-live-badge'; live.textContent = '● LIVE';
  const viewers = document.createElement('span'); viewers.className = 'kt-viewers';
  const uptime  = document.createElement('span'); uptime.className  = 'kt-uptime';

  wrap.append(viewers, uptime);

  let pollTimer   = null;
  let uptimeTimer = null;
  let startDate   = null;

  // Register viewer-count callback immediately — no null-callback window
  const _unsubViewers = viewerInterceptor.onViewerCount(count => {
    viewers.textContent = fmtViewers(count) + ' watching';
  });

  // ── uptime ticker ────────────────────────────────────────────────────────

  function _startUptimeTicker(start) {
    if (!start || !isFinite(start.getTime())) return;
    if (startDate && start.getTime() === startDate.getTime() && uptimeTimer) return;
    startDate = start;
    clearInterval(uptimeTimer);
    const tick = () => {
      const s = store.getState();
      if (s.engine !== 'dvr') {
        uptime.textContent = fmtUptime(startDate);
      }
      store.setState({ uptimeSec: Math.floor((Date.now() - startDate.getTime()) / 1000) });
      if (store.getState().username && !pollTimer) _startPolling();
    };
    tick();
    uptimeTimer = setInterval(tick, 1000);
  }

  function _stopUptimeTicker() { clearInterval(uptimeTimer); uptimeTimer = null; startDate = null; }

  // ── offline ──────────────────────────────────────────────────────────────

  function _applyOffline() {
    live.textContent = '● OFFLINE';
    live.classList.add('kt-offline');
    viewers.textContent = '';
    uptime.textContent  = '';
    _stopUptimeTicker();
    if (store.getState().engine !== 'dvr') {
      store.setState({ vodId: null, streamStartTime: null, uptimeSec: 0 });
    }
  }

  // ── polling ──────────────────────────────────────────────────────────────

  async function _poll() {
    const s = store.getState();
    if (!s.username) return;
    try {
      const data = await api.fetchChannelInit(s.username);
      if (data.isLive === null) return;

      if (data.title       !== null) store.setState({ title: data.title });
      if (data.displayName !== null) store.setState({ displayName: data.displayName });
      if (data.avatar      !== null) store.setState({ avatar: data.avatar });

      live.textContent = data.isLive ? '● LIVE' : '● OFFLINE';
      live.classList.toggle('kt-offline', !data.isLive);

      if (!data.isLive) { _applyOffline(); return; }

      if (data.viewers !== null) {
        store.setState({ viewers: data.viewers });
        viewers.textContent = fmtViewers(data.viewers) + ' watching';
      }
      store.setState({ vodId: data.vodId ?? null, streamStartTime: data.startTime ?? null });
      if (data.startTime) {
        let ts = data.startTime;
        if (!ts.includes('T')) ts = ts.replace(' ', 'T');
        if (!/[Zz]$/.test(ts) && !/[+-]\d{2}:?\d{2}$/.test(ts)) ts += 'Z';
        _startUptimeTicker(new Date(ts));
      }
    } catch (e) { console.warn('[KickTiny] poll error:', e.message); }
  }

  function _startPolling() { clearInterval(pollTimer); _poll(); pollTimer = setInterval(_poll, POLL_INTERVAL_MS); }
  function _stopPolling()  { clearInterval(pollTimer); pollTimer = null; }

  // ── live badge ───────────────────────────────────────────────────────────

  live.addEventListener('click', () => { if (!store.getState().atLiveEdge) actions.seekToLive(); });

  store.select(
  s => ({
    username: s.username,
    atLiveEdge: s.atLiveEdge,
    engine: s.engine,
    dvrBehindLive: s.dvrBehindLive,
    uptimeSec: s.uptimeSec
  }),
  ({ username, atLiveEdge, engine, dvrBehindLive, uptimeSec }) => {
    live.classList.toggle('kt-behind', !atLiveEdge);
    live.title = atLiveEdge ? '' : 'Jump to live';
    if (username && !pollTimer) _startPolling();
    if (startDate) {
      uptime.textContent = engine === 'dvr'
        ? fmtDuration(Math.max(0, uptimeSec - Math.round(dvrBehindLive)))
        : fmtUptime(startDate);
    }
  }
);

  document.addEventListener('visibilitychange', () => {
    if (!store.getState().username) return;
    if (document.hidden) {
      _stopPolling();
      clearInterval(uptimeTimer); uptimeTimer = null;
    } else {
      if (startDate) _startUptimeTicker(startDate);
      _startPolling();
    }
  });

  return { live, wrap, destroy: _unsubViewers };
}
