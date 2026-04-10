import { setupPopupToggle } from './popup.js';

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function createSpeedBtn(store, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-speed-btn';
  btn.title = 'Speed'; btn.textContent = '1×';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-speed-popup';
  popup.hidden = true;

  RATES.forEach(r => {
    const item = document.createElement('button');
    item.className = 'kt-popup-item';
    item.dataset.rate = r;
    item.textContent = r === 1 ? '1× (normal)' : r + '×';
    item.addEventListener('click', e => { e.stopPropagation(); actions.setRate(r); popup.hidden = true; });
    popup.appendChild(item);
  });

  setupPopupToggle(btn, popup);
  document.body.appendChild(popup);
  wrap.append(btn);

  store.select(
    s => ({ rate: s.rate }),
    ({ rate }) => {
      btn.textContent = rate === 1 ? '1×' : rate + '×';
      popup.querySelectorAll('.kt-popup-item[data-rate]').forEach(item => {
        item.classList.toggle('kt-active', Number(item.dataset.rate) === rate);
      });
    }
  );

  return wrap;
}
