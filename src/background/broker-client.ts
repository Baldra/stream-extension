import type { BrokerClient } from '../core/accounts';
import { TokenRefreshError } from '../core/tokens';
import { createLogger } from '../core/logging';

const logger = createLogger('broker-client');

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
    logger.debug('post', { provider: body.provider, path });
    let response: Response;
    try {
      response = await doFetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logger.error('post failed', { provider: body.provider, path, err });
      throw opaque(String(body.provider ?? ''), 'broker_unreachable');
    }

    let envelope: BrokerEnvelope<T>;
    try {
      envelope = (await response.json()) as BrokerEnvelope<T>;
    } catch (err) {
      logger.error('invalid response', { provider: body.provider, path, err });
      throw opaque(String(body.provider ?? ''), 'broker_invalid_response');
    }

    if (!response.ok || !envelope?.ok) {
      const reason = String(envelope?.oauthError ?? envelope?.error ?? 'broker_error');
      logger.error('broker error', { provider: body.provider, path, reason });
      throw opaque(String(body.provider ?? ''), reason);
    }
    logger.debug('post ok', { provider: body.provider, path });
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
