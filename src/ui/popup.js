let _popupGlobalsBound = false;
function bindPopupGlobals() {
  if (_popupGlobalsBound) return;
  _popupGlobalsBound = true;
  document.addEventListener('click', () => {
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
}

export function openPopup(popup, triggerBtn) {
  popup.hidden = false;
  popup.style.visibility = 'hidden';
  const rect = triggerBtn.getBoundingClientRect();
  const vw = window.innerWidth;
  const popupW = popup.offsetWidth || 120;
  const popupH = popup.offsetHeight || 100;

  const availableH = rect.top - 8 - 4;
  const maxH = Math.max(80, availableH);
  popup.style.maxHeight = maxH + 'px';

  let top = rect.top - Math.min(popupH, maxH) - 8;
  if (top < 4) top = 4;

  let left = rect.right - popupW;
  if (left < 4) left = 4;
  if (left + popupW > vw - 4) left = vw - popupW - 4;

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.style.visibility = '';
}

export function setupPopupToggle(btn, popup, onOpen) {
  bindPopupGlobals();
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!popup.hidden) { popup.hidden = true; return; }
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
    if (onOpen) onOpen();
    openPopup(popup, btn);
  });
}
