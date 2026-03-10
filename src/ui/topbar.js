import { subscribe, state } from '../state.js';
import { fetchViewers } from '../api.js';

export function createTopBar() {
  const bar = document.createElement('div');
  bar.className = 'kt-top-bar';

  const channelLink = document.createElement('a');
  channelLink.className = 'kt-channel-link';
  channelLink.target = '_blank';
  channelLink.rel = 'noopener noreferrer';

  const title = document.createElement('div');
  title.className = 'kt-stream-title';

  bar.append(channelLink, title);

  subscribe(({ username }) => {
    if (!username) return;
    channelLink.href = `https://www.kick.com/${username}`;
    channelLink.textContent = username;
  });

  async function fetchTitle() {
    if (!state.username) return;
    try {
      const data = await fetchViewers(state.username);
      if (data.title) title.textContent = data.title;
    } catch (_) {}
  }

  subscribe(({ alive, username }) => {
    if (alive && username) fetchTitle();
  });

  return bar;
}
