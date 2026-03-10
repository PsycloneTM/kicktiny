export const KEYS = {
  quality: 'kt.quality',
  volume:  'kt.volume',
};

export function loadPrefs() {
  return {
    quality: localStorage.getItem(KEYS.quality) || null,
    volume:  localStorage.getItem(KEYS.volume) !== null
               ? Number(localStorage.getItem(KEYS.volume)) : null,
  };
}

export function savePrefs(patch) {
  if ('quality' in patch) {
    if (patch.quality === null) localStorage.removeItem(KEYS.quality);
    else localStorage.setItem(KEYS.quality, patch.quality);
  }
  if ('volume' in patch) {
    localStorage.setItem(KEYS.volume, String(patch.volume));
  }
}
