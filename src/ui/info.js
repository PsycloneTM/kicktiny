import { subscribe, state, setState } from '../state.js';
import { fmtViewers, fmtUptime } from '../utils/format.js';
import { fetchChannelInit, fetchViewerCount } from '../api.js';
import { initDvr } from '../dvr/discovery.js';
import { seekToLive } from '../actions.js';

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

    if (data.isLive === null) return;
    if (data.title !== null) setState({ title: data.title });
    if (data.displayName !== null) setState({ displayName: data.displayName });
    if (data.avatar !== null) setState({ avatar: data.avatar });

    live.textContent = data.isLive ? '● LIVE' : '● OFFLINE';
    live.classList.toggle('kt-offline', !data.isLive);

    if (!data.isLive) { applyOffline(); return; }
    if (data.vodId !== null) initDvr(data.vodId);

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
      initPoll();
      pollTimer = setInterval(poll, 30_000);
    }
  });

  return wrap;
}
