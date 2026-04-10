export function createTopBar(store) {
  const bar = document.createElement('div');
  bar.className = 'kt-top-bar';

  const channelLink = document.createElement('a');
  channelLink.className = 'kt-channel-link';
  channelLink.target = '_blank'; channelLink.rel = 'noopener noreferrer';

  const title = document.createElement('div');
  title.className = 'kt-stream-title';

  const avatar = document.createElement('img');
  avatar.className = 'kt-avatar'; avatar.alt = ''; avatar.draggable = false;

  const channelWrap = document.createElement('div');
  channelWrap.className = 'kt-channel-wrap';
  channelWrap.append(avatar, channelLink);
  bar.append(channelWrap, title);

  let _ready = false;
  store.select(
    s => ({ username: s.username, displayName: s.displayName, avatar: s.avatar, title: s.title }),
    ({ username, displayName, avatar: avatarUrl, title: stateTitle }) => {
      if (username && !_ready) {
        _ready = true;
        channelLink.href = `https://www.kick.com/${username}`;
      }
      if (displayName && channelLink.textContent !== displayName) channelLink.textContent = displayName;
      if (avatarUrl  && avatar.src !== avatarUrl)                 avatar.src = avatarUrl;
      if (stateTitle && stateTitle !== title.textContent)         title.textContent = stateTitle;
  });

  return bar;
}
