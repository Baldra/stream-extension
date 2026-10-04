const SENSITIVE_KEYS = new Set([
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'code',
  'code_verifier',
  'codeVerifier',
  'state',
  'password',
  'auth_token',
  'authToken',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v));
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k)) {
        if (k === 'state' || k === 'stateValue') {
          if (typeof v === 'string' && v.length > 0) {
            out[k] = `${v.substring(0, 8)}...`;
          } else {
            out[k] = '[redacted]';
          }
        } else {
          out[k] = '[redacted]';
        }
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return value;
}

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'object' ? JSON.stringify(sanitize(a)) : String(a)))
    .join(' ');
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(context?: string): Logger {
  const prefix = context ? `[${context}]` : '';
  return {
    debug: (...args: unknown[]) => console.debug(prefix, format(args)),
    info: (...args: unknown[]) => console.info(prefix, format(args)),
    warn: (...args: unknown[]) => console.warn(prefix, format(args)),
    error: (...args: unknown[]) => console.error(prefix, format(args)),
  };
}

export const logger = createLogger();
