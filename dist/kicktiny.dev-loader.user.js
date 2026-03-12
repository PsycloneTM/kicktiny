// ==UserScript==
// @name         KickTiny Dev Loader
// @namespace    https://github.com/reda777/kicktiny
// @version      1.0.0
// @description  Loads KickTiny from local dev server — install once, never update
// @author       Reda777
// @match        https://player.kick.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

// Install this once. The real script is fetched fresh from localhost on every
// page load, so you only need to reload the tab to see your latest build.
// Start the dev server with: node bundle.cjs --watch

(function () {
  GM_xmlhttpRequest({
    method: 'GET',
    url: 'http://localhost:7653/kicktiny.user.js',
    onload(res) {
      if (res.status === 200) {
        // eval runs in the userscript sandbox, not subject to page CSP
        // eslint-disable-next-line no-eval
        (0, eval)(res.responseText);
      } else {
        console.warn('[KickTiny Dev] Server responded', res.status);
      }
    },
    onerror() {
      console.warn('[KickTiny Dev] Could not reach localhost:7653 — is the dev server running?');
    },
  });
})();
