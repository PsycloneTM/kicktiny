import { setRate, toggleCatchUp } from '../actions.js';
import { subscribe, state } from '../state.js';
import { setupPopupToggle } from './popup.js';

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function createSpeedBtn() {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-speed-btn';
  btn.title = 'Speed';
  btn.textContent = '1×';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-speed-popup';
  popup.hidden = true;

  // Build speed items
  RATES.forEach(r => {
    const item = document.createElement('button');
    item.className = 'kt-popup-item';
    item.dataset.rate = r;
    item.textContent = r === 1 ? '1× (normal)' : r + '×';
    item.addEventListener('click', e => {
      e.stopPropagation();
      setRate(r);
      popup.hidden = true;
    });
    popup.appendChild(item);
  });

  // Catch-up button
  const catchBtn = document.createElement('button');
  catchBtn.className = 'kt-popup-item kt-catchup-item';
  catchBtn.dataset.catchup = 'true';
  catchBtn.title = 'Skip to live (l)';
  catchBtn.textContent = '⚡ Live catchup';
  catchBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleCatchUp();
    popup.hidden = true;
  });
  popup.appendChild(catchBtn);

  setupPopupToggle(btn, popup);

  document.body.appendChild(popup);
  wrap.append(btn);

  subscribe(({ rate, catching }) => {
    btn.textContent = catching ? '⚡' : (rate === 1 ? '1×' : rate + '×');
    popup.querySelectorAll('.kt-popup-item[data-rate]').forEach(item => {
      item.classList.toggle('kt-active', Number(item.dataset.rate) === rate);
    });
    const cu = popup.querySelector('[data-catchup]');
    if (cu) cu.classList.toggle('kt-active', catching);
  });

  return wrap;
}
