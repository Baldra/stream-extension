import type { BrokerClient } from '../core/accounts';
import { TokenRefreshError } from '../core/tokens';

/**
 * The extension's only channel to the token broker.
 *
 * It speaks to one origin and sends no client secret, because the extension has
 * none to send. Every failure is mapped to an opaque class: the broker's own
 * messages are already secret-free, and a raw network error could otherwise leak
 * a request body containing a token into a log.
 */
export interface BrokerHttpOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface BrokerEnvelope<T> {
  ok: boolean;
  error?: string;
  /** The platform's OAuth error code, when the broker could read one. */
  oauthError?: string;
  message?: string;
  data?: T;
}

/**
 * A permanent grant failure is one the platform will keep refusing, so it is the
 * only kind that may put an account into "needs reconnection". Everything else,
 * including a transport failure or an unparseable answer, is temporary: the next
 * poll tries again and the account keeps working.
 */
const PERMANENT = new Set(['invalid_grant', 'invalid_client', 'missing_scope', 'unauthorized_client']);

const opaque = (provider: string, reason: string): TokenRefreshError =>
  new TokenRefreshError(
    PERMANENT.has(reason) ? 'invalid_grant' : 'temporarily_unavailable',
    `broker request failed for ${provider}: ${reason}`,
  );

export function createBrokerHttpClient(options: BrokerHttpOptions): BrokerClient {
  const { baseUrl } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw opaque(String(body.provider ?? ''), 'broker_unreachable');
    }

    let envelope: BrokerEnvelope<T>;
    try {
      envelope = (await response.json()) as BrokerEnvelope<T>;
    } catch {
      throw opaque(String(body.provider ?? ''), 'broker_invalid_response');
    }

    if (!response.ok || !envelope?.ok) {
      // The broker forwards the platform's own OAuth error code, which is what
      // distinguishes a revoked grant from a momentary failure.
      throw opaque(
        String(body.provider ?? ''),
        String(envelope?.oauthError ?? envelope?.error ?? 'broker_error'),
      );
    }
    return (envelope.data ?? (envelope as unknown)) as T;
  }

  return {
    exchange: (input) =>
      post('/oauth/exchange', {
        provider: input.provider,
        code: input.code,
        redirectUri: input.redirectUri,
        ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
      }),

    refresh: (input) => post('/oauth/refresh', { provider: input.provider, refreshToken: input.refreshToken }),

    revoke: async (input) => {
      await post<{ revoked: boolean }>('/oauth/revoke', {
        provider: input.provider,
        token: input.accessToken,
      });
    },
  };
}
