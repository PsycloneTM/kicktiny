#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const isDev = process.argv.includes('--dev');
const SRC = path.resolve(__dirname, 'src');

// Read all files in order of dependency
const visited = new Set();
const chunks = [];

function readModule(filePath) {
  if (visited.has(filePath)) return;
  visited.add(filePath);
  
  let code = fs.readFileSync(filePath, 'utf8');
  
  // Resolve imports
  const importRe = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    const dep = m[1];
    if (dep.startsWith('.')) {
      let depPath = path.resolve(path.dirname(filePath), dep);
      if (!depPath.endsWith('.js')) depPath += '.js';
      readModule(depPath);
    }
  }
  
  // Strip import statements and export keywords
  code = code.replace(/^import\s+.*?\s+from\s+['"][^'"]+['"]\s*;?\n?/gm, '');
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

const HEADER = `// ==UserScript==
// @name         KickTiny
// @namespace    https://github.com/reda777/kicktiny
// @version      0.1.0
// @description  Custom player overlay for Kick.com embeds
// @author       Reda777
// @match        https://player.kick.com/*
// @updateURL    https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @downloadURL  https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @supportURL   https://github.com/reda777/kicktiny
// @grant        none
// @run-at       document-start
// ==/UserScript==

`;

let bundle = chunks.join('\n');

// Replace CSS placeholder
const escapedCss = cssMin.replace(/`/g, '\\`').replace(/\$/g, '\\$');
bundle = bundle.replace("'__SKIN_CSS__'", `\`${escapedCss}\``);

// Wrap in IIFE
bundle = `(function() {\n'use strict';\n${bundle}\n})();`;

const output = HEADER + bundle;
fs.mkdirSync(path.join(__dirname, 'dist'), {recursive:true});
fs.writeFileSync(path.join(__dirname, 'dist', 'kicktiny.user.js'), output, 'utf8');
console.log(`✓ Built dist/kicktiny.user.js (${Math.round(output.length/1024)}KB)`);
