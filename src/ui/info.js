import { subscribe, state, setState } from '../state.js';
import { fmtViewers, fmtUptime, fmtDuration } from '../utils/format.js';
import { fetchChannelInit } from '../api.js';
import { seekToLive } from '../actions.js';

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

export function createInfo() {
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
