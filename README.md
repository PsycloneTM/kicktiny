# KickTiny

A custom player overlay for Kick.com embeds. Replaces the native controls with a clean, keyboard-friendly UI while keeping the original IVS player underneath.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/)
2. Open the link below to install the script directly:

```
https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `k` or `Space` | Play / Pause |
| `m` | Toggle mute |
| `f` | Toggle fullscreen |
| `l` | Live catchup (2× speed) |
| `↑` | Volume +5% |
| `↓` | Volume -5% |

## Build from Source

Requires Node.js — no other dependencies.

```bash
git clone https://github.com/reda777/kicktiny
cd kicktiny
npm run build
# -> dist/kicktiny.user.js
```
