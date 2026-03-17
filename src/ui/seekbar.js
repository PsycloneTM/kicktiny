import { subscribe, state } from '../state.js';
import { enterDvrAtBehindLive, dvrSeekToLive, dvrSeekToBehindLive } from '../dvr/controller.js';
import { fmtDuration } from '../utils/format.js';

export function createSeekbar() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-seekbar';

  const track = document.createElement('div');
  track.className = 'kt-seekbar-track';

  // Progress region
  const prog = document.createElement('div');
  prog.className = 'kt-seekbar-prog';

  const thumb = document.createElement('div');
  thumb.className = 'kt-seekbar-thumb';

  const tip = document.createElement('div');
  tip.className = 'kt-seekbar-tip';

  track.append(prog, thumb);
  wrap.append(track, tip);

  let _dragging        = false;
  let _uptimeSec       = 0;
  // When dragging from IVS mode, we track the target here and only
  // trigger the async DVR entry once on mouseup (not every mousemove)
  let _pendingBehindSec = null;

  // ── rendering ──────────────────────────────────────────────────────────────

  function render(uiPos, uptimeSec) {
    if (uptimeSec <= 0) {
      prog.style.width = '0%';
      thumb.style.left = '0%';
      return;
    }
    const pct = Math.min(1, Math.max(0, uiPos / uptimeSec)) * 100;
    prog.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  }

  // ── tooltip ────────────────────────────────────────────────────────────────

  function showTip(e) {
    if (_uptimeSec <= 0) return;
    const rect  = track.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const uiPos = pct * _uptimeSec;
    const behind = _uptimeSec - uiPos;

    tip.textContent = behind <= 30 ? 'LIVE' : '-' + fmtDuration(behind);

    tip.style.display = 'block';

    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    // Position tip above the track. offsetTop gives track's top edge inside wrap.
    // We want tip's bottom edge to be 6px above the track's top edge.
    tip.style.bottom = (wrap.offsetHeight - track.offsetTop + 6) + 'px';
    // Horizontal: clamp within wrap width (accounting for horizontal padding)
    const hPad = rect.left - wRect.left; // = 10px (left padding)
    let left = hPad + (e.clientX - rect.left) - tipW / 2;
    left = Math.max(0, Math.min(wRect.width - tipW, left));
    tip.style.left = `${left}px`;
  }

  function hideTip() {
    if (!_dragging) tip.style.display = 'none';
  }

  // ── seek logic ─────────────────────────────────────────────────────────────

  function pctFromEvent(e) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function seekFromEvent(e) {
    if (_uptimeSec <= 0) return;

    const pct              = pctFromEvent(e);
    const uiPos     = pct * _uptimeSec;
    const behindSec = _uptimeSec - uiPos;

    render(uiPos, _uptimeSec);

    if (behindSec <= 30) {
      if (state.engine === 'dvr') dvrSeekToLive();
      _pendingBehindSec = null;
      return;
    }

    if (state.engine === 'dvr') {
      dvrSeekToBehindLive(behindSec);
      _pendingBehindSec = null;
      return;
    }

    _pendingBehindSec = behindSec;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  wrap.addEventListener('mouseenter', e => showTip(e));
  wrap.addEventListener('mousemove',  e => showTip(e));
  wrap.addEventListener('mouseleave', () => hideTip());

  wrap.addEventListener('mousedown', e => {
    _dragging = true;
    seekFromEvent(e);
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!_dragging) return;
    showTip(e);
    seekFromEvent(e);
  });

  document.addEventListener('mouseup', () => {
    if (!_dragging) return;
    _dragging = false;
    tip.style.display = 'none';

    // Fire DVR entry once, on release, if we dragged from IVS into the past
    if (_pendingBehindSec !== null && state.engine !== 'dvr') {
      const behind = _pendingBehindSec;
      _pendingBehindSec = null;
      enterDvrAtBehindLive(behind);
    } else {
      _pendingBehindSec = null;
    }
  });

  // ── state subscription ────────────────────────────────────────────────────

  subscribe(({ uptimeSec, dvrBehindLive, engine }) => {
    wrap.style.display = uptimeSec > 0 ? 'block' : 'none';
    if (uptimeSec <= 0) return;

    _uptimeSec = uptimeSec;

    if (_dragging) return;

    if (engine === 'ivs') {
      render(uptimeSec, uptimeSec);
    } else {
      render(Math.max(0, uptimeSec - dvrBehindLive), uptimeSec);
    }
  });

  wrap.style.display = 'none';
  return wrap;
}