import { subscribe, state, setState } from '../state.js';
import { fmtViewers, fmtUptime } from '../utils/format.js';
import { fetchViewers } from '../api.js';
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

  async function poll() {
    if (!state.username) return;
    const data = await fetchViewers(state.username);

    if (data.isLive === null) return;

    if (data.title !== null) setState({ title: data.title });

    live.textContent = data.isLive ? '● LIVE' : '● OFFLINE';
    live.classList.toggle('kt-offline', !data.isLive);

    if (!data.isLive) {
      viewers.textContent = '';
      uptime.textContent = '';
      clearInterval(uptimeTimer);
      uptimeTimer = null;
      startDate = null;
      return;
    }

    if (data.viewers !== null) viewers.textContent = fmtViewers(data.viewers) + ' watching';
    if (data.startTime) {
      const newStart = new Date(data.startTime);
      if (!startDate || newStart.getTime() !== startDate.getTime()) {
        startDate = newStart;
        clearInterval(uptimeTimer);
        uptimeTimer = setInterval(() => { uptime.textContent = fmtUptime(startDate); }, 1000);
        uptime.textContent = fmtUptime(startDate);
      }
    }
  }

  live.addEventListener('click', () => {
    if (!state.atLiveEdge) seekToLive();
  });

  subscribe(({ username, atLiveEdge }) => {
    live.classList.toggle('kt-behind', !atLiveEdge);
    live.title = atLiveEdge ? '' : 'Jump to live';
    if (username && !pollTimer) {
      poll();
      pollTimer = setInterval(poll, 30_000);
    }
  });

  // Pause polling when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (!state.username) return;
    clearInterval(pollTimer);
    pollTimer = null;
    if (!document.hidden) {
      poll();
      pollTimer = setInterval(poll, 30_000);
    }
  });

  return wrap;
}
