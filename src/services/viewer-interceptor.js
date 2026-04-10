// ── services/viewer-interceptor.js ───────────────────────────────────────────
// Intercepts Kick's own current-viewers fetches so we can read viewer counts
// with zero extra network requests. Isolated here so the side-effect of
// monkey-patching window.fetch is explicit and contained.
//
// Usage:
//   const viewer = createViewerInterceptor();
//   const unsub  = viewer.onViewerCount(count => setState({ viewers: count }));
//   unsub(); // stop listening

export function createViewerInterceptor() {
  const _callbacks = new Set();

  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    const res = await _origFetch.apply(this, args);

    if (url.includes('current-viewers') && _callbacks.size > 0) {
      res.clone().json().then(data => {
        if (Array.isArray(data) && data[0]?.viewers != null) {
          for (const cb of _callbacks) cb(data[0].viewers);
        }
      }).catch(() => {});
    }

    return res;
  };

  return {
    /** Register a viewer-count callback. Returns an unsubscribe function. */
    onViewerCount(cb) {
      _callbacks.add(cb);
      return () => _callbacks.delete(cb);
    },
  };
}
