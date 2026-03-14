import { subscribe, state } from '../state.js';
import { dvrSeek, dvrSeekToLive, enterDvrMode } from '../dvr/controller.js';
import { fmtDuration } from '../utils/format.js';

export function createSeekbar() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-seekbar';

  const track = document.createElement('div');
  track.className = 'kt-seekbar-track';

  const prog = document.createElement('div');
  prog.className = 'kt-seekbar-prog';

  const thumb = document.createElement('div');
  thumb.className = 'kt-seekbar-thumb';

  const tip = document.createElement('div');
  tip.className = 'kt-seekbar-tip';

  track.append(prog, thumb);
  wrap.append(track, tip);

  let _dragging = false;
  let _duration  = 0;

  // ── rendering ─────────────────────────────────────────────────────────────

  function render(pos, dur) {
    if (dur <= 0) { prog.style.width = '100%'; thumb.style.left = '100%'; return; }
    const pct = Math.min(1, pos / dur) * 100;
    prog.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  }

  // ── tooltip ───────────────────────────────────────────────────────────────

  function showTip(e) {
    if (_duration <= 0) return;
    const rect   = track.getBoundingClientRect();
    const wRect  = wrap.getBoundingClientRect();
    const pct    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const behind = _duration - pct * _duration;

    tip.textContent    = behind <= 3 ? 'LIVE' : '-' + fmtDuration(behind);
    tip.style.display  = 'block';

    const tipW  = tip.offsetWidth;
    const trackOffsetInWrap = rect.left - wRect.left;
    let left = trackOffsetInWrap + (e.clientX - rect.left) - tipW / 2;
    left = Math.max(0, Math.min(wRect.width - tipW, left));
    tip.style.left = `${left}px`;
  }

  function hideTip() {
    if (!_dragging) tip.style.display = 'none';
  }

  // ── seek logic ────────────────────────────────────────────────────────────

  function pctFromEvent(e) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function seekFromEvent(e) {
    if (_duration <= 0) return;
    const target = pctFromEvent(e) * _duration;
    const behind = _duration - target;

    render(target, _duration);

    if (behind <= 3) {
      dvrSeekToLive();
    } else if (state.engine !== 'dvr') {
      enterDvrMode(target);
    } else {
      dvrSeek(target);
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

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
  });

  // ── state subscription ────────────────────────────────────────────────────

  subscribe(({ dvrAvailable, dvrDuration, dvrPosition, engine }) => {
    const usable = dvrAvailable && dvrDuration > 0;
    wrap.style.display = usable ? 'block' : 'none';
    if (!usable) return;

    _duration = dvrDuration;

    if (_dragging) return;

    if (engine === 'ivs') {
      render(_duration, _duration);
    } else {
      render(dvrPosition, dvrDuration);
    }
  });

  wrap.style.display = 'none';
  return wrap;
}