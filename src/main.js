import { initAdapter } from './adapter.js';
import { bindKeys } from './actions.js';
import { setState } from './state.js';
import { createBar, initBarHover } from './ui/bar.js';
import { createOverlay } from './ui/overlay.js';
import { createTopBar } from './ui/topbar.js';

const CSS = '__SKIN_CSS__';

function injectStyles(css) {
  const style = document.createElement('style');
  style.id = 'kt-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function getUsername() {
  return location.pathname.replace(/^\//, '').split('?')[0] || '';
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

async function init() {
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
