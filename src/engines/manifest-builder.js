// ── engines/manifest-builder.js ──────────────────────────────────────────────
// Owns the segment array and all synthetic HLS manifest logic.
// Pure module — no store dependency, no side-effects.
// The DVR engine owns a single instance and delegates all manifest work here.

import { NEAR_END_THRESHOLD_SEC } from '../constants.js';

export const SYNTHETIC_URL = 'https://kt.local/dvr.m3u8';

export function createManifestBuilder() {
  let _segments       = [];
  let _lastSegUrl     = '';
  let _targetDuration = 10;

  // ── public API ─────────────────────────────────────────────────────────────

  function reset() {
    _segments   = [];
    _lastSegUrl = '';
  }

  function generate() {
    let out = _buildHeader();
    for (const seg of _segments) {
      if (seg.discontinuity) out += '#EXT-X-DISCONTINUITY\n';
      if (seg.pdt)           out += seg.pdt + '\n';
      out += seg.duration + '\n';
      out += seg.url + '\n';
    }
    return out;
  }

  // Merge incoming playlist text into the segment array.
  // Returns the number of new segments added (0 = nothing new).
  function merge(text, baseUrl) {
    const cleaned  = text.replace(/#EXT-X-ENDLIST.*/g, '');
    const incoming = _parse(cleaned, baseUrl);
    if (!incoming.length) return 0;

    let startIdx = 0;
    if (_lastSegUrl) {
      let overlapIdx = -1;
      for (let i = incoming.length - 1; i >= 0; i--) {
        if (incoming[i].url === _lastSegUrl) {
          overlapIdx = i;
          break;
        }
      }
      startIdx = overlapIdx >= 0 ? overlapIdx + 1 : 0;
    }

    const newSegs = incoming.slice(startIdx);
    if (!newSegs.length) return 0;

    _segments.push(...newSegs);
    _lastSegUrl = _segments[_segments.length - 1].url;
    console.log('[KickTiny DVR] Merged', newSegs.length, 'new segments, total:', _segments.length,
      '\n  tail:', _lastSegUrl.split('/').slice(-1)[0]);
    return newSegs.length;
  }

  // Append the next predicted segment by incrementing the last URL's sequence number.
  // Zero network requests — used during catch-up mode.
  function extrapolate() {
    if (!_segments.length) return false;
    const last  = _segments[_segments.length - 1];
    const match = last.url.match(/^(.*\/)(\d+)\.ts$/);
    if (!match) {
      console.warn('[KickTiny DVR] Cannot extrapolate — URL pattern not recognised');
      return false;
    }

    const url = `${match[1]}${parseInt(match[2], 10) + 1}.ts`;
    let pdt = null;
    if (last.pdt) {
      const m = last.pdt.match(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/);
      if (m) {
        const nextMs = new Date(m[1]).getTime() + _targetDuration * 1000;
        pdt = `#EXT-X-PROGRAM-DATE-TIME:${new Date(nextMs).toISOString()}`;
      }
    }
    _segments.push({ duration: last.duration, url, pdt, discontinuity: false });
    _lastSegUrl = url;
    console.log('[KickTiny DVR] Extrapolated next segment:', url.split('/').slice(-1)[0]);
    return true;
  }

  // Pick the best variant URL from a multivariant playlist, optionally honouring
  // a preferred quality name (falls back to middle-bandwidth variant).
  function pickVariant(text, baseUrl, preferredName) {
    const lines   = text.split('\n');
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
      const res  = t.match(/RESOLUTION=\d+x(\d+)/);
      const bw   = t.match(/BANDWIDTH=(\d+)/);
      const name = t.match(/VIDEO="([^"]+)"/);
      const url  = lines[i + 1]?.trim();
      if (!url || url.startsWith('#')) continue;
      streams.push({
        url:       url.startsWith('http') ? url : new URL(url, baseUrl).href,
        height:    res  ? parseInt(res[1], 10)  : 0,
        bandwidth: bw   ? parseInt(bw[1], 10)   : 0,
        name:      name ? name[1]           : '',
      });
    }
    if (!streams.length) return baseUrl;

    if (preferredName) {
      let m = streams.find(s => s.name === preferredName);
      if (!m) {
        const stripped = preferredName.replace(/\d+$/, '');
        m = streams.find(s => s.name.replace(/\d+$/, '') === stripped);
      }
      if (m) { console.log('[KickTiny DVR] Picked variant:', m.name); return m.url; }
    }

    const sorted = [...streams].sort((a, b) => b.bandwidth - a.bandwidth);
    const pick   = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
    console.log('[KickTiny DVR] No quality match, picking middle variant:', pick.name);
    return pick.url;
  }

  // Parse quality options from a multivariant playlist. Returns sorted array.
  function parseQualities(text) {
    const lines   = text.split('\n');
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
      const name = t.match(/VIDEO="([^"]+)"/);
      const bw   = t.match(/BANDWIDTH=(\d+)/);
      if (name) streams.push({ name: name[1], index: streams.length, bandwidth: bw ? parseInt(bw[1], 10) : 0 });
    }
    if (!streams.length) return [];
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    streams.forEach((s, i) => { s.index = i; });
    return streams;
  }

  // True when playback is close enough to the seekable end to warrant extrapolation.
  function nearEnd(currentTime, seekableEnd) {
    return isFinite(seekableEnd) && (seekableEnd - currentTime) < NEAR_END_THRESHOLD_SEC;
  }

  // ── getters ────────────────────────────────────────────────────────────────

  function segmentCount()   { return _segments.length; }
  function getLastSegUrl()  { return _lastSegUrl; }
  function targetDuration() { return _targetDuration; }

  // ── private ────────────────────────────────────────────────────────────────

  function _buildHeader() {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      `#EXT-X-TARGETDURATION:${_targetDuration}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ].join('\n') + '\n';
  }

  function _parse(text, baseUrl) {
    const lines  = text.split('\n');
    const result = [];
    let duration = null, pdt = null, discontinuity = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-TARGETDURATION:')) { _targetDuration = parseInt(t.split(':')[1], 10) || _targetDuration; continue; }
      if (t === '#EXT-X-DISCONTINUITY')            { discontinuity = true; continue; }
      if (t.startsWith('#EXT-X-PROGRAM-DATE-TIME:')){ pdt = t; continue; }
      if (t.startsWith('#EXTINF:'))                 { duration = t; continue; }
      if (duration && t && !t.startsWith('#')) {
        const url = t.startsWith('http') ? t : new URL(t, baseUrl).href;
        result.push({ duration, url, pdt, discontinuity });
        duration = null; pdt = null; discontinuity = false;
      }
    }
    return result;
  }

  return {
    reset, generate, merge, extrapolate,
    pickVariant, parseQualities, nearEnd,
    segmentCount, getLastSegUrl, targetDuration,
  };
}
