/**
 * Chrome's `chrome.alarms` minimum periodInMinutes is 1 minute (Chrome 120+; the
 * older 30-second floor was removed). We poll at exactly that floor because the
 * MV3 service worker can be terminated at any moment, so a faster cadence would
 * mean holding a socket open -- which costs battery and buys nothing, since a
 * terminated worker loses the socket anyway. Notification latency is therefore
 * bounded by this period; see design.md decision 2.
 */
export const MIN_CHROME_VERSION = 116;

export const POLL_PERIOD_MINUTES = 1;

export const POLL_PERIOD_MS = POLL_PERIOD_MINUTES * 60_000;

export const ALARM_NAME = 'poll-live-status';

/**
 * Kick refresh tokens use a sliding window; Twitch refresh tokens are rotated.
 * Either way, renewing before expiry avoids a 401 landing mid-poll, which the
 * user would experience as a silently missed notification. See design.md decision 5.
 */
export const TOKEN_RENEWAL_SKEW_MS = 15 * 60_000;

/** Notification history is bounded so storage cannot grow without limit. */
export const NOTIFICATION_HISTORY_LIMIT = 200;

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/**
 * Consecutive failures before a problem is shown to the user. Below this it is
 * treated as a transient blip, so a single 500 never raises a "broken" banner.
 */
export const ONGOING_FAILURE_ATTEMPTS = 3;
