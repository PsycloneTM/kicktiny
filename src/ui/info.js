import { subscribe, state } from '../state.js';
import { fmtViewers, fmtUptime } from '../utils/format.js';
import { fetchViewers } from '../api.js';

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
    const online = data.viewers !== null || data.startTime !== null;
    live.textContent = online ? '● LIVE' : '● OFFLINE';
    live.classList.toggle('kt-offline', !online);
    if (!online) {
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
      // Restart uptime if stream is new or restarted
      if (!startDate || newStart.getTime() !== startDate.getTime()) {
        startDate = newStart;
        clearInterval(uptimeTimer);
        uptimeTimer = setInterval(() => { uptime.textContent = fmtUptime(startDate); }, 1000);
        uptime.textContent = fmtUptime(startDate);
      }
    }
  }

  subscribe(({ alive, username, playing }) => {
    live.style.opacity = playing ? '1' : '0.5';
    if (alive && username && !pollTimer) {
      poll();
      pollTimer = setInterval(poll, 30_000);
    }
  });

  return wrap;
}
