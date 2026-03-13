import { subscribe } from '../state.js';

export function createTopBar() {
  const bar = document.createElement('div');
  bar.className = 'kt-top-bar';

  const channelLink = document.createElement('a');
  channelLink.className = 'kt-channel-link';
  channelLink.target = '_blank';
  channelLink.rel = 'noopener noreferrer';

  const title = document.createElement('div');
  title.className = 'kt-stream-title';

  const channelWrap = document.createElement('div');
  channelWrap.appendChild(channelLink);

  bar.append(channelWrap, title);

  let _ready = false;
  subscribe(({ username, displayName, title: stateTitle }) => {
    if (username && !_ready) {
      _ready = true;
      channelLink.href = `https://www.kick.com/${username}`;
    }
    if (displayName && channelLink.textContent !== displayName) {
      channelLink.textContent = displayName;
    }
    if (stateTitle && stateTitle !== title.textContent) {
      title.textContent = stateTitle;
    }
  });

  return bar;
}
