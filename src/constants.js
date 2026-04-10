// ── constants.js ──────────────────────────────────────────────────────────────
// Single source of truth for every magic number in KickTiny.
// Import this module wherever a numeric literal would otherwise appear.

// ── live-edge thresholds ──────────────────────────────────────────────────────
/** IVS live-latency (seconds) below which we consider playback at the live edge */
export const LIVE_EDGE_LATENCY_SEC    = 3.5;
/** DVR behindLive (seconds) below which we consider playback at the live edge */
export const LIVE_EDGE_BEHIND_SEC     = 30;

// ── UI timers ─────────────────────────────────────────────────────────────────
/** Milliseconds before the control bar auto-hides after the mouse stops moving */
export const CONTROLS_HIDE_DELAY_MS   = 3_000;
/** Milliseconds after the mouse leaves the bar before it fades */
export const CONTROLS_LEAVE_DELAY_MS  = 500;
/** Milliseconds between clicks to count as a double-click (fullscreen toggle) */
export const DOUBLE_CLICK_WINDOW_MS   = 250;
/** Milliseconds between channel-info poll requests */
export const POLL_INTERVAL_MS         = 60_000;
/** Milliseconds to debounce saving volume to localStorage */
export const VOLUME_SAVE_DEBOUNCE_MS  = 300;

// ── IVS adapter ───────────────────────────────────────────────────────────────
/** Milliseconds between retries when searching for the IVS player in the React tree */
export const ADAPTER_RETRY_INTERVAL_MS = 500;
/** Maximum number of IVS player extraction retries before giving up */
export const ADAPTER_MAX_RETRIES       = 40;
/** Milliseconds between live-latency samples (used for atLiveEdge updates) */
export const LATENCY_POLL_INTERVAL_MS  = 1_000;

// ── DVR controller ────────────────────────────────────────────────────────────
/** Maximum milliseconds to wait for the HLS seekable window to become available */
export const SEEKABLE_WAIT_MS          = 8_000;
/** Milliseconds before JWT expiry at which we pre-fetch a fresh VOD URL */
export const EXPIRY_LEAD_MS            = 2 * 60_000;
/** Fallback refresh interval (ms) when no JWT expiry can be parsed from the URL */
export const FALLBACK_REFRESH_MS       = 50 * 60_000;
/** Milliseconds between catch-up segment extrapolation attempts */
export const CATCH_UP_INTERVAL_MS      = 12_500;
/** Seconds from the seekable end at which catch-up mode activates */
export const NEAR_END_THRESHOLD_SEC    = 60;
/** Milliseconds between DVR position-poll ticks */
export const POSITION_POLL_INTERVAL_MS = 500;

// ── error recovery ────────────────────────────────────────────────────────────
/** IVS recoverable-error codes that trigger a full page reload */
export const RECONNECT_CODES           = new Set([-2, -3]);
/** Maximum times we re-apply a saved quality preference before giving up */
export const MAX_REAPPLY_ATTEMPTS      = 3;
/** Maximum page-reload attempts for transient IVS errors before giving up */
export const MAX_RELOAD_ATTEMPTS       = 3;
