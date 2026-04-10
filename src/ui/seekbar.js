import { fmtDuration } from '../utils/format.js';
import { LIVE_EDGE_BEHIND_SEC } from '../constants.js';

export function createSeekbar(store, actions) {
  const wrap  = document.createElement('div');  wrap.className  = 'kt-seekbar';
  const track = document.createElement('div');  track.className = 'kt-seekbar-track';
  const prog  = document.createElement('div');  prog.className  = 'kt-seekbar-prog';
  const thumb = document.createElement('div');  thumb.className = 'kt-seekbar-thumb';
  const tip   = document.createElement('div');  tip.className   = 'kt-seekbar-tip';

  track.append(prog, thumb);
  wrap.append(track, tip);

  let _dragging        = false;
  let _uptimeSec       = 0;
  let _pendingBehindSec = null; // DVR entry deferred to mouseup

  function render(uiPos, uptimeSec) {
    if (uptimeSec <= 0) { prog.style.width = '0%'; thumb.style.left = '0%'; return; }
    const pct = Math.min(1, Math.max(0, uiPos / uptimeSec)) * 100;
    prog.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  }

  function showTip(e) {
    if (_uptimeSec <= 0) return;
    const rect  = track.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const behind = _uptimeSec - pct * _uptimeSec;

    tip.textContent = behind <= LIVE_EDGE_BEHIND_SEC ? 'LIVE' : '-' + fmtDuration(behind);
    tip.style.display = 'block';

    const tipW = tip.offsetWidth;
    const hPad = rect.left - wRect.left;
    tip.style.bottom = (wrap.offsetHeight - track.offsetTop + 6) + 'px';
    let left = hPad + (e.clientX - rect.left) - tipW / 2;
    tip.style.left = `${Math.max(0, Math.min(wRect.width - tipW, left))}px`;
  }

  function hideTip() { if (!_dragging) tip.style.display = 'none'; }

  function seekFromEvent(e) {
    if (_uptimeSec <= 0) return;
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const uiPos   = pct * _uptimeSec;
    const behind  = _uptimeSec - uiPos;
    render(uiPos, _uptimeSec);

    if (behind <= LIVE_EDGE_BEHIND_SEC) {
      if (store.getState().engine === 'dvr') actions.seekToLive();
      _pendingBehindSec = null;
      return;
    }
    if (store.getState().engine === 'dvr') {
      actions.dvrSeekToBehindLive(behind);
      _pendingBehindSec = null;
      return;
    }
    _pendingBehindSec = behind;
  }

  wrap.addEventListener('mouseenter', e => showTip(e));
  wrap.addEventListener('mousemove',  e => showTip(e));
  wrap.addEventListener('mouseleave', () => hideTip());
  wrap.addEventListener('mousedown',  e => { _dragging = true; seekFromEvent(e); e.preventDefault(); });

  document.addEventListener('mousemove', e => { if (!_dragging) return; showTip(e); seekFromEvent(e); });
  document.addEventListener('mouseup', () => {
    if (!_dragging) return;
    _dragging = false;
    tip.style.display = 'none';
    if (_pendingBehindSec !== null && store.getState().engine !== 'dvr') {
      const behind = _pendingBehindSec;
      _pendingBehindSec = null;
      actions.enterDvr(behind);
    } else {
      _pendingBehindSec = null;
    }
  });

  store.select(
    s => ({ uptimeSec: s.uptimeSec, dvrBehindLive: s.dvrBehindLive, engine: s.engine }),
    ({ uptimeSec, dvrBehindLive, engine }) => {
      wrap.style.display = uptimeSec > 0 ? 'block' : 'none';
      if (uptimeSec <= 0) return;
      _uptimeSec = uptimeSec;
      if (_dragging) return;
      render(engine === 'ivs' ? uptimeSec : Math.max(0, uptimeSec - dvrBehindLive), uptimeSec);
  });

  wrap.style.display = 'none';
  return wrap;
}
