import { setupPopupToggle } from './popup.js';
import { fmtQuality } from '../utils/format.js';

export function createQualityBtn(store, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-qual-btn';
  btn.title = 'Quality'; btn.textContent = 'AUTO';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-qual-popup';
  popup.hidden = true;

  let _snap = { engine: 'ivs', qualities: [], quality: null, autoQuality: true, dvrQualities: [], dvrQuality: null };

  setupPopupToggle(btn, popup, () => _renderPopup());
  document.body.appendChild(popup);
  wrap.append(btn);

  store.select(
    s => ({ engine: s.engine, qualities: s.qualities, quality: s.quality, autoQuality: s.autoQuality, dvrQualities: s.dvrQualities, dvrQuality: s.dvrQuality }),
    snap => {
      _snap = snap;
      btn.textContent = snap.engine === 'dvr'
        ? (snap.dvrQuality ? fmtQuality(snap.dvrQuality.name) : 'AUTO')
        : (snap.autoQuality ? 'AUTO' : fmtQuality(snap.quality?.name ?? '?'));
      if (!popup.hidden) _renderPopup();
    }
  );

  function _renderPopup() {
    const items = _snap.engine === 'dvr'
      ? [
          { label: 'Auto', active: _snap.dvrQuality === null, onClick: () => actions.setQuality('auto') },
          ...(_snap.dvrQualities || []).map(q => ({
            label:   fmtQuality(q.name),
            active:  _snap.dvrQuality?.index === q.index,
            onClick: () => actions.setQuality(q),
          })),
        ]
      : [
          { label: 'Auto', active: _snap.autoQuality, onClick: () => actions.setQuality('auto') },
          ...(_snap.qualities || []).map(q => ({
            label:   q.name,
            active:  !_snap.autoQuality && _snap.quality?.name === q.name,
            onClick: () => actions.setQuality(q),
          })),
        ];

    // Diff instead of full re-render when item count is unchanged
    const existing = Array.from(popup.querySelectorAll('.kt-popup-item'));
    if (!popup.hidden && existing.length === items.length) {
      items.forEach((item, i) => {
        const el = existing[i];
        if (el.textContent !== item.label) el.textContent = item.label;
        el.classList.toggle('kt-active', item.active);
        el.onclick = e => { e.stopPropagation(); item.onClick(); popup.hidden = true; };
      });
      return;
    }
    popup.innerHTML = '';
    items.forEach(({ label, active, onClick }) => {
      const item = document.createElement('button');
      item.className = 'kt-popup-item' + (active ? ' kt-active' : '');
      item.textContent = label;
      item.addEventListener('click', e => { e.stopPropagation(); onClick(); popup.hidden = true; });
      popup.appendChild(item);
    });
  }

  return wrap;
}
