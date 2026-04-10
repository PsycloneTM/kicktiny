#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');

const isDev  = process.argv.includes('--dev') || process.argv.includes('--watch');
const isWatch = process.argv.includes('--watch');
const DEV_PORT = 7653;
const SRC  = path.resolve(__dirname, 'src');
const DIST = path.resolve(__dirname, 'dist');

// ── bundler ────────────────────────────────────────────────────────────────

function build() {
  const visited = new Set();
  const chunks  = [];

  function readModule(filePath) {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    let code = fs.readFileSync(filePath, 'utf8');

    const importRe = /^import\b[\s\S]*?from\s+['"]([^'"]+)['"]\s*;[ \t]*\n?/gm;
    let m;
    while ((m = importRe.exec(code)) !== null) {
      const dep = m[1];
      if (dep.startsWith('.')) {
        let depPath = path.resolve(path.dirname(filePath), dep);
        if (!depPath.endsWith('.js')) depPath += '.js';
        readModule(depPath);
      }
    }

    code = code.replace(importRe, '');
    code = code.replace(/^export\s+default\s+/gm, 'var _default = ');
    code = code.replace(/^export\s+(async\s+function|function|class|const|let|var)\s+/gm, '$1 ');
    code = code.replace(/^export\s*\{[^}]*\}\s*;?\n?/gm, '');

    chunks.push(`\n// ── ${path.relative(SRC, filePath)} ──\n` + code);
  }

  readModule(path.join(SRC, 'main.js'));

  const cssRaw = fs.readFileSync(path.join(SRC, 'skin.css'), 'utf8');
  const cssMin = cssRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>~+])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();

  const version = isDev ? '0.0.0-dev' : require('./package.json').version;

  const HEADER = `// ==UserScript==
// @name         KickTiny
// @namespace    https://github.com/reda777/kicktiny
// @version      ${version}
// @description  Custom player overlay for Kick.com embeds with DVR
// @author       Reda777
// @match        https://player.kick.com/*
// @updateURL    https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @downloadURL  https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @supportURL   https://github.com/reda777/kicktiny
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==

`;

  let bundle = chunks.join('\n');
  const escapedCss = cssMin.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  bundle = bundle.replace("'__SKIN_CSS__'", `\`${escapedCss}\``);
  bundle = `(function() {\n'use strict';\n${bundle}\n})();`;

  const output = HEADER + bundle;
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'kicktiny.user.js'), output, 'utf8');
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ✓ Built dist/kicktiny.user.js (${Math.round(output.length / 1024)}KB)`);
}

// ── dev server ─────────────────────────────────────────────────────────────

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/kicktiny.user.js') {
      try {
        const file = fs.readFileSync(path.join(DIST, 'kicktiny.user.js'));
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(file);
      } catch {
        res.writeHead(404);
        res.end('Not found — run build first');
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[dev] Port ${DEV_PORT} already in use — is another instance running?`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(DEV_PORT, '127.0.0.1', () => {
    console.log(`[dev] Serving on http://localhost:${DEV_PORT}/kicktiny.user.js`);
  });
}

// ── watcher ────────────────────────────────────────────────────────────────

function startWatcher() {
  let debounce = null;
  fs.watch(SRC, { recursive: true }, (event, filename) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log(`[watch] ${filename} changed`);
      try { build(); } catch (e) { console.error('[build error]', e.message); }
    }, 80);
  });
  console.log('[watch] Watching src/ for changes...');
}

// ── dev loader userscript ──────────────────────────────────────────────────

function writeDevLoader() {
  const loader = `// ==UserScript==
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
    url: 'http://localhost:${DEV_PORT}/kicktiny.user.js',
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
      console.warn('[KickTiny Dev] Could not reach localhost:${DEV_PORT} — is the dev server running?');
    },
  });
})();
`;

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'kicktiny.dev-loader.user.js'), loader, 'utf8');
  console.log('✓ Wrote dist/kicktiny.dev-loader.user.js');
}

// ── entry ──────────────────────────────────────────────────────────────────

build();

if (isWatch) {
  writeDevLoader();
  startServer();
  startWatcher();
}
