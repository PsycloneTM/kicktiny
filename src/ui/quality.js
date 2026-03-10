import { setQuality } from '../actions.js';
import { subscribe } from '../state.js';
import { setupPopupToggle, openPopup } from './popup.js';

export function createQualityBtn() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-qual-btn';
  btn.title = 'Quality';
  btn.textContent = 'AUTO';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-qual-popup';
  popup.hidden = true;

  // Cache last state for lazy render on open
  let _q = { qualities: [], quality: null, autoQuality: true };

  setupPopupToggle(btn, popup, () => renderPopup(popup, _q.qualities, _q.quality, _q.autoQuality));

  document.body.appendChild(popup);
  wrap.append(btn);

  subscribe(({ qualities, quality, autoQuality }) => {
    _q = { qualities, quality, autoQuality };
    btn.textContent = autoQuality ? 'AUTO' : (quality?.name ?? '?');
    // Only rebuild DOM if popup is visible
    if (!popup.hidden) renderPopup(popup, qualities, quality, autoQuality);
  });

  return wrap;
}

function renderPopup(popup, qualities, current, autoQ) {
  popup.innerHTML = '';
  popup.appendChild(makeItem('Auto', autoQ, () => setQuality('auto'), popup));
  (qualities || []).forEach(q => {
    popup.appendChild(makeItem(q.name, !autoQ && current?.name === q.name, () => setQuality(q), popup));
  });
}

function makeItem(label, active, onClick, popup) {
  const item = document.createElement('button');
  item.className = 'kt-popup-item' + (active ? ' kt-active' : '');
  item.textContent = label;
  item.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
    popup.hidden = true;
  });
  return item;
}
