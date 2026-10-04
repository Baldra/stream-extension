import type { BrokerConfig } from './config';
import { resolveProvider, type ExchangeInput } from './providers';

export type FailureClass =
  | 'unauthorized_caller'
  | 'unknown_provider'
  | 'redirect_uri_not_allowed'
  | 'invalid_request'
  | 'platform_rejected'
  | 'platform_unavailable';

export interface BrokerFailure {
  ok: false;
  provider?: string;
  error: FailureClass;
  message: string;
  /**
   * The OAuth error code the platform returned, when it sent one. It is not a
   * secret, and the extension needs it to tell a permanent refusal such as
   * `invalid_grant` from a transient one, which decides whether an account has to
   * be reconnected.
   */
  oauthError?: string;
}

export interface BrokerSuccess<T> {
  ok: true;
  provider: string;
  data: T;
}

export type BrokerResult<T> = BrokerSuccess<T> | BrokerFailure;

export interface PlatformTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
}

export interface CallContext {
  /** Origin of the caller, from the CORS `Origin` header. */
  origin?: string;
}

export interface BrokerDeps {
  config: BrokerConfig;
  fetch: typeof fetch;
}

const fail = (
  error: FailureClass,
  message: string,
  provider?: string,
  oauthError?: string,
): BrokerFailure => ({
  ok: false,
  error,
  message,
  ...(provider ? { provider } : {}),
  ...(oauthError ? { oauthError } : {}),
});

/**
 * The OAuth error code from a token endpoint response body.
 *
 * The body is read defensively: a platform that answers with HTML or nothing at
 * all must still produce a usable failure rather than throwing.
 */
async function oauthErrorOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The extension is a public client and holds no secret of its own, so the broker's
 * defence against authorization-code injection is: require the registered
 * extension origin, then validate redirect_uri against an allowlist. Rejecting
 * before any platform call matters -- a rejected request must not reach Twitch or
 * Kick at all.
 */
export function authorizeCaller(ctx: CallContext, config: BrokerConfig): BrokerFailure | null {
  if (!ctx.origin) return fail('unauthorized_caller', 'missing caller origin');
  if (!config.allowedOrigins.includes(ctx.origin)) {
    return fail('unauthorized_caller', 'caller origin is not registered');
  }
  return null;
}

export async function exchangeAuthorizationCode(
  input: ExchangeInput & { provider: string },
  ctx: CallContext,
  deps: BrokerDeps,
): Promise<BrokerResult<PlatformTokenResponse>> {
  const callerCheck = authorizeCaller(ctx, deps.config);
  if (callerCheck) return callerCheck;

  const provider = resolveProvider(input.provider, deps.config);
  if (!provider) {
    return fail('unknown_provider', 'provider is not registered', input.provider);
  }

  if (!input.code) {
    return fail('invalid_request', 'missing authorization code', provider.id);
  }
  if (!input.redirectUri) {
    return fail('invalid_request', 'missing redirect_uri', provider.id);
  }
  if (!deps.config.allowedRedirectUris.includes(input.redirectUri)) {
    return fail('redirect_uri_not_allowed', 'redirect_uri is not registered', provider.id);
  }

  const credentials = deps.config.providers[provider.id]!;
  const params = provider.buildExchangeParams(input, credentials);

  let response: Response;
  try {
    response = await deps.fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    // Deliberately opaque: the request may have carried a code, so no platform
    // detail is echoed back.
    return fail('platform_unavailable', 'token endpoint is unreachable', provider.id);
  }

  if (!response.ok) {
    return fail(
      'platform_rejected',
      `platform rejected the exchange (${response.status})`,
      provider.id,
      await oauthErrorOf(response),
    );
  }

  const data = (await response.json()) as PlatformTokenResponse;
  if (typeof data?.access_token !== 'string') {
    return fail('platform_rejected', 'token endpoint returned no access token', provider.id);
  }

  return { ok: true, provider: provider.id, data };
}

export interface AppTokenResult {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Renews an access token.
 *
 * Both platforms require the client secret on the refresh grant, so this cannot
 * live in the extension. The submitted refresh token is used for one request and
 * dropped: nothing is written to a store or a log, and the response body never
 * echoes the submitted value back.
 */
export async function refreshAccessToken(
  input: { provider: string; refreshToken: string },
  ctx: CallContext,
  deps: BrokerDeps,
): Promise<BrokerResult<PlatformTokenResponse>> {
  const callerCheck = authorizeCaller(ctx, deps.config);
  if (callerCheck) return callerCheck;

  const provider = resolveProvider(input.provider, deps.config);
  if (!provider) return fail('unknown_provider', 'provider is not registered', input.provider);
  if (!input.refreshToken) return fail('invalid_request', 'missing refresh token', provider.id);

  const params = provider.buildRefreshParams(input.refreshToken, deps.config.providers[provider.id]!);

  let response: Response;
  try {
    response = await deps.fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    return fail('platform_unavailable', 'token endpoint is unreachable', provider.id);
  }

  if (!response.ok) {
    return fail(
      'platform_rejected',
      `platform rejected the renewal (${response.status})`,
      provider.id,
      await oauthErrorOf(response),
    );
  }

  const data = (await response.json()) as PlatformTokenResponse;
  if (typeof data?.access_token !== 'string') {
    return fail('platform_rejected', 'token endpoint returned no access token', provider.id);
  }

  return { ok: true, provider: provider.id, data };
}

/**
 * Best-effort revocation on disconnect. The account-auth spec requires the
 * credential to be discarded upstream where possible, but a platform that refuses
 * must not block the local cleanup, so revocation failures are reported without
 * being treated as a reason to keep the account connected.
 */
export async function revokeToken(
  input: { provider: string; token: string },
  ctx: CallContext,
  deps: BrokerDeps,
): Promise<BrokerResult<{ revoked: boolean }>> {
  const callerCheck = authorizeCaller(ctx, deps.config);
  if (callerCheck) return callerCheck;

  const provider = resolveProvider(input.provider, deps.config);
  if (!provider) return fail('unknown_provider', 'provider is not registered', input.provider);
  if (!input.token) return fail('invalid_request', 'missing token', provider.id);

  try {
    const response = await deps.fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: deps.config.providers[provider.id]!.clientId,
        token: input.token,
      }).toString(),
    });
    if (!response.ok) {
      return fail('platform_rejected', `platform rejected the revocation (${response.status})`, provider.id);
    }
  } catch {
    return fail('platform_unavailable', 'token endpoint is unreachable', provider.id);
  }

  return { ok: true, provider: provider.id, data: { revoked: true } };
}

/**
 * Application-level tokens live only in this function's scope. Nothing is written
 * to disk or a log sink, so a restart costs one extra token fetch and no user data.
 */
export async function issueAppToken(
  providerId: string,
  ctx: CallContext,
  deps: BrokerDeps,
  endpointFor: (providerId: string) => string,
): Promise<BrokerResult<AppTokenResult>> {
  const callerCheck = authorizeCaller(ctx, deps.config);
  if (callerCheck) return callerCheck;

  const credentials = deps.config.providers[providerId];
  if (!credentials) return fail('unknown_provider', 'provider is not registered', providerId);

  let response: Response;
  try {
    response = await deps.fetch(endpointFor(providerId), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }).toString(),
    });
  } catch {
    return fail('platform_unavailable', 'token endpoint is unreachable', providerId);
  }

  if (!response.ok) {
    return fail('platform_rejected', `platform rejected the grant (${response.status})`, providerId);
  }

  const data = (await response.json()) as AppTokenResult;
  if (typeof data?.access_token !== 'string') {
    return fail('platform_rejected', 'token endpoint returned no access token', providerId);
  }

  return { ok: true, provider: providerId, data };
}
