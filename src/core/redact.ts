/**
 * Credential-shaped keys that must never reach a log line or serialized state.
 *
 * Matched case-insensitively as substrings, because providers are inconsistent:
 * Kick calls it `code_verifier`, Twitch `client_secret`, and a stream key arrives
 * as `stream.key` nested inside a channels response. Design.md decision 9 strips
 * these at the parse boundary so they never enter application state at all; this
 * module is the second line of defence for anything that reaches a sink.
 */
const SENSITIVE_KEY_PATTERNS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'code_verifier',
  'code_challenge',
  'authorization',
  'session',
  'cookie',
  'streamkey',
  'stream_key',
  'apikey',
  'api_key',
  'password',
  'secret',
  'token',
];

export const REDACTED = '[redacted]';

const isSensitiveKey = (key: string, parentKey?: string): boolean => {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  if (SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern.replace(/[-_]/g, '')))) {
    return true;
  }
  // Kick's Get Channels response nests the broadcaster's stream key as
  // `stream.key` -- a bare `key` name that no substring rule can catch without
  // redacting every innocuous `key` field in the system. Scope it to that parent.
  return normalized === 'key' && parentKey?.toLowerCase() === 'stream';
};

/**
 * Recursively replaces credential-shaped values with a placeholder. Structure and
 * non-sensitive values are preserved so logs stay useful for debugging.
 */
export function redact<T>(value: T): unknown {
  return redactInternal(value, new WeakSet(), undefined, false);
}

/** Convenience wrapper for logging: redacts, then serializes. */
export function safeStringify(value: unknown): string {
  return JSON.stringify(redact(value));
}

/**
 * Keys that legitimately hold a secret in *application* state. The extension's
 * own OAuth tokens must survive a worker restart, so a service worker cannot poll
 * at all without them -- they are the user's credentials for their own account,
 * stored in local extension storage, and are never transmitted anywhere but the
 * platform's own API.
 */
const PERSISTENCE_EXEMPT_PARENTS = new Set(['credentials']);
const PERSISTENCE_EXEMPT_KEYS = new Set(['accesstoken', 'refreshtoken', 'refreshtokenexpiresat', 'expiresat']);

const isExemptForPersistence = (key: string, parentKey?: string): boolean => {
  if (!parentKey || !PERSISTENCE_EXEMPT_PARENTS.has(parentKey.toLowerCase())) return false;
  return PERSISTENCE_EXEMPT_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
};

/**
 * Redaction for state on its way to disk. Identical to {@link redact} except that
 * the extension's own account credentials survive, because losing them would
 * break polling. Everything else -- notably Kick's `stream.key` and any client
 * secret -- is still removed, so a platform response that leaked one cannot reach
 * persisted state (task 4.5).
 */
export function redactForPersistence<T>(value: T): T {
  return redactInternal(value, new WeakSet(), undefined, true) as T;
}

function redactInternal(
  value: unknown,
  seen: WeakSet<object>,
  parentKey: string | undefined,
  forPersistence = false,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInternal(item, seen, parentKey, forPersistence));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (forPersistence && isExemptForPersistence(key, parentKey)) {
      out[key] = entry;
      continue;
    }
    out[key] = isSensitiveKey(key, parentKey) ? REDACTED : redactInternal(entry, seen, key, forPersistence);
  }
  return out;
}
