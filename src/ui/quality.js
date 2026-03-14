import { setQuality } from '../actions.js';
import { subscribe } from '../state.js';
import { setupPopupToggle } from './popup.js';

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

  let _s = {
    engine: 'ivs',
    qualities: [], quality: null, autoQuality: true,
    dvrQualities: [], dvrQuality: null,
  };

  setupPopupToggle(btn, popup, () => renderPopup(popup, _s));

  document.body.appendChild(popup);
  wrap.append(btn);

  subscribe(({ engine, qualities, quality, autoQuality, dvrQualities, dvrQuality }) => {
    _s = { engine, qualities, quality, autoQuality, dvrQualities, dvrQuality };

    if (engine === 'dvr') {
      btn.textContent = dvrQuality ? dvrQuality.name : 'AUTO';
    } else {
      btn.textContent = autoQuality ? 'AUTO' : (quality?.name ?? '?');
    }

    if (!popup.hidden) renderPopup(popup, _s);
  });

  return wrap;
}

function renderPopup(popup, s) {
  const items = buildItems(s);

  const existing = Array.from(popup.querySelectorAll('.kt-popup-item'));
  if (!popup.hidden && existing.length === items.length) {
    items.forEach((item, i) => {
      const el = existing[i];
      if (el.textContent !== item.label) el.textContent = item.label;
      const shouldBeActive = item.active;
      if (el.classList.contains('kt-active') !== shouldBeActive) {
        el.classList.toggle('kt-active', shouldBeActive);
      }
      el.onclick = e => { e.stopPropagation(); item.onClick(); popup.hidden = true; };
    });
    return;
  }
  popup.innerHTML = '';
  items.forEach(({ label, active, onClick }) => {
    popup.appendChild(makeItem(label, active, onClick, popup));
  });
}

function buildItems(s) {
  if (s.engine === 'dvr') {
    return [
      { label: 'Auto', active: s.dvrQuality === null, onClick: () => setQuality('auto') },
      ...(s.dvrQualities || []).map(q => ({
        label:   q.name,
        active:  s.dvrQuality?.index === q.index,
        onClick: () => setQuality(q),
      })),
    ];
  }
  return [
    { label: 'Auto', active: s.autoQuality, onClick: () => setQuality('auto') },
    ...(s.qualities || []).map(q => ({
      label:   q.name,
      active:  !s.autoQuality && s.quality?.name === q.name,
      onClick: () => setQuality(q),
    })),
  ];
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