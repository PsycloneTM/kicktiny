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
  const popupWidth = popup.offsetWidth || 120;
  let left = rect.right - popupWidth;
  if (left < 4) left = 4;
  popup.style.left = left + 'px';
  popup.style.top = (rect.top - popup.offsetHeight - 8) + 'px';
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
