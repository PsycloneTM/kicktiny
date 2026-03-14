import { fetchDvrUrl } from '../api.js';

export const dvr = {
  vodId:      null,
  url:        null,
  ready:      false,
  loading:    false,
  error:      null,  
  _listeners: [],
};

export function onDvrReady(fn) {
  if (dvr.ready) { fn(dvr.url); return; }
  dvr._listeners.push(fn);
}

function notifyReady() {
  dvr.ready = true;
  dvr.loading = false;
  dvr._listeners.forEach(fn => fn(dvr.url));
  dvr._listeners = [];
}

export async function initDvr(vodId) {
  if (dvr.ready && dvr.vodId === vodId) return;
  if (dvr.loading) return;

  dvr.loading = true;
  dvr.error   = null;
  dvr.vodId   = vodId;

  const url = await fetchDvrUrl(vodId);

  if (!url) {
    dvr.loading = false;
    dvr.error   = 'fetchDvrUrl returned null';
    console.warn('[KickTiny DVR] Could not get DVR URL — will retry on next poll');
    dvr.vodId = null;
    return;
  }

  dvr.url = url;
  console.log('[KickTiny DVR] Ready:', url);
  notifyReady();
}