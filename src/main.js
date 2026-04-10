// ── main.js ───────────────────────────────────────────────────────────────────
// Entry point — wiring only. Creates the core services, wires them together,
// and mounts the UI. No business logic lives here.

import { createStore }             from './store.js';
import { loadPrefs, savePrefs }    from './prefs.js';
import { fetchChannelInit, fetchVodPlaybackUrl } from './api.js';
import { createEngineManager }     from './engine-manager.js';
import { createActions }           from './actions.js';
import { createViewerInterceptor } from './services/viewer-interceptor.js';
import { createBar, initBarHover } from './ui/bar.js';
import { createOverlay }           from './ui/overlay.js';
import { createTopBar }            from './ui/topbar.js';

const CSS = '__SKIN_CSS__';

function injectStyles(css) {
  const style = document.createElement('style');
  style.id = 'kt-styles'; style.textContent = css;
  document.head.appendChild(style);
}

function hideNativeControls() {
  const style = document.createElement('style');
  style.textContent = '.z-controls { display: none !important; }';
  document.head.appendChild(style);
}

function getUsername() {
  return location.pathname.replace(/^\//, '').split('/')[0] || '';
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

let _initialized = false;

async function init() {
  if (_initialized) return;
  _initialized = true;
  try {
    const container = await waitForContainer();

    // ── Core services ───────────────────────────────────────────────────────
    const store   = createStore();
    const prefs   = { load: loadPrefs, save: savePrefs };
    const api     = { fetchChannelInit, fetchVodPlaybackUrl };
    const viewer  = createViewerInterceptor();

    // ── Engine layer ────────────────────────────────────────────────────────
    const engines = createEngineManager(store, prefs, api);

    // ── Actions — the only thing UI touches ────────────────────────────────
    const actions = createActions(store, engines, prefs);

    // ── UI ──────────────────────────────────────────────────────────────────
    injectStyles(CSS);
    hideNativeControls();
    store.setState({ username: getUsername() });

    const root   = createRoot(container);
    const topBar = createTopBar(store);
    const bar = createBar(store, actions, viewer, api);
    const overlay = createOverlay(store, actions);

    root.append(overlay, topBar, bar);
    initBarHover(root, bar, container, topBar, store);

    // ── Double-click: single click = play/pause, double = fullscreen ───────
    let _clickTimer = null;
    container.addEventListener('click', e => {
      if (bar.contains(e.target) || topBar.contains(e.target)) return;
      if (_clickTimer) {
        clearTimeout(_clickTimer); _clickTimer = null;
        actions.toggleFullscreen();
      } else {
        _clickTimer = setTimeout(() => {
          _clickTimer = null;
          actions.togglePlay();
        }, actions.DOUBLE_CLICK_WINDOW_MS);
      }
    });

    // ── Init engines (IVS extraction + DVR container setup) ────────────────
    await engines.init(container);
    actions.bindKeys();

    console.log('[KickTiny] Initialized for', getUsername() || 'unknown');
  } catch (e) {
    console.warn('[KickTiny] init error:', e.message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
