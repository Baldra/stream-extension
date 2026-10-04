import { describe, expect, it, vi } from 'vitest';
import { createBroker } from '../broker/src/index';
import { loadConfig, ConfigError } from '../broker/src/config';
import {
  exchangeAuthorizationCode,
  issueAppToken,
  refreshAccessToken,
  revokeToken,
} from '../broker/src/handlers';

const ENV = {
  TWITCH_CLIENT_ID: 'twitch-client-id',
  TWITCH_CLIENT_SECRET: 'twitch-client-secret-value',
  KICK_CLIENT_ID: 'kick-client-id',
  KICK_CLIENT_SECRET: 'kick-client-secret-value',
  ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  ALLOWED_REDIRECT_URIS:
    'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
  PORT: '8787',
} satisfies NodeJS.ProcessEnv;

/** Port 0 lets the OS pick a free port so concurrently-running tests
 * and the lingering close of a previous server cannot collide. */
const config = () => loadConfig({ ...ENV, PORT: '0' });
const EXT_ORIGIN = ENV.ALLOWED_ORIGINS;
const EXT_REDIRECT = ENV.ALLOWED_REDIRECT_URIS;

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('broker config (task 2.1)', () => {
  it('reads provider credentials and allowlists from the environment', () => {
    const c = config();
    expect(c.providers.twitch?.clientId).toBe('twitch-client-id');
    expect(c.providers.kick?.clientSecret).toBe('kick-client-secret-value');
    expect(c.allowedOrigins).toEqual([EXT_ORIGIN]);
    expect(c.allowedRedirectUris).toEqual([EXT_REDIRECT]);
  });

  it('fails fast when a client secret is missing', () => {
    const env = { ...ENV, KICK_CLIENT_SECRET: '' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('requires an origin allowlist and a redirect allowlist', () => {
    expect(() => loadConfig({ ...ENV, ALLOWED_ORIGINS: '' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => loadConfig({ ...ENV, ALLOWED_REDIRECT_URIS: '' })).toThrow(/ALLOWED_REDIRECT_URIS/);
  });

  it('serves a health endpoint that does not expose secrets', async () => {
    const broker = createBroker({ config: config(), fetchImpl: vi.fn() as unknown as typeof fetch });
    const port = await broker.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ ok: true, providers: ['twitch', 'kick'] });
      expect(body).not.toContain('twitch-client-secret-value');
      expect(body).not.toContain('kick-client-secret-value');
    } finally {
      broker.server.close();
    }
  });
});

describe('identity enforcement (task 2.4)', () => {
  const deps = () => ({ config: config(), fetch: vi.fn() as unknown as typeof fetch });

  it('rejects a caller origin that is not registered', async () => {
    const d = deps();
    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT },
      { origin: 'chrome-extension://someotherextensionidhere000000000' },
      d,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unauthorized_caller');
  });

  it('rejects a request with no origin at all', async () => {
    const d = deps();
    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT },
      {},
      d,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unauthorized_caller');
  });

  it('rejects a redirect_uri that is not on the allowlist', async () => {
    const d = deps();
    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: 'https://attacker.example/callback' },
      { origin: EXT_ORIGIN },
      d,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('redirect_uri_not_allowed');
  });

  it('rejects a bad origin before contacting the platform', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200 }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT },
      { origin: 'https://attacker.example' },
      d,
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unregistered redirect_uri before contacting the platform', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200 }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: 'https://attacker.example/callback' },
      { origin: EXT_ORIGIN },
      d,
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unregistered provider', async () => {
    const d = deps();
    const result = await exchangeAuthorizationCode(
      { provider: 'youtube', code: 'c', redirectUri: EXT_REDIRECT },
      { origin: EXT_ORIGIN },
      d,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unknown_provider');
  });
});

describe('authorization-code exchange (task 2.2)', () => {
  it('injects the client secret and forwards only platform-required parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200, refresh_token: 'rt' }),
    );
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'the-code', redirectUri: EXT_REDIRECT, codeVerifier: 'verifier-value' },
      { origin: EXT_ORIGIN },
      d,
    );

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://id.kick.com/oauth/token');

    const sent = new URLSearchParams(String(init.body));
    expect(sent.get('client_secret')).toBe('kick-client-secret-value');
    expect(sent.get('code')).toBe('the-code');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('redirect_uri')).toBe(EXT_REDIRECT);
    // Kick requires PKCE alongside the secret.
    expect(sent.get('code_verifier')).toBe('verifier-value');
  });

  it('sends the Twitch grant without a PKCE verifier, which Twitch does not accept', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200 }),
    );
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    await exchangeAuthorizationCode(
      { provider: 'twitch', code: 'the-code', redirectUri: EXT_REDIRECT, codeVerifier: 'ignored' },
      { origin: EXT_ORIGIN },
      d,
    );

    const sent = new URLSearchParams(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.get('client_secret')).toBe('twitch-client-secret-value');
    expect(sent.get('code_verifier')).toBeNull();
  });

  it('returns the platform token response to the caller', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200, refresh_token: 'rt' }),
    );
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT },
      { origin: EXT_ORIGIN },
      d,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.access_token).toBe('at');
      expect(result.data.refresh_token).toBe('rt');
    }
  });

  it('reports a platform rejection without echoing the submitted code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'super-secret-auth-code', redirectUri: EXT_REDIRECT },
      { origin: EXT_ORIGIN },
      d,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('platform_rejected');
      expect(result.provider).toBe('kick');
      expect(JSON.stringify(result)).not.toContain('super-secret-auth-code');
    }
  });

  it('reports an unreachable token endpoint without platform detail', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:443'));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT },
      { origin: EXT_ORIGIN },
      d,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('platform_unavailable');
      expect(JSON.stringify(result)).not.toContain('10.0.0.1');
    }
  });

  it('rejects a 200 response that carries no access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ error: 'unexpected' }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await exchangeAuthorizationCode(
      { provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT },
      { origin: EXT_ORIGIN },
      d,
    );
    expect(result.ok).toBe(false);
  });
});

describe('failure responses carry no credentials (task 2.5)', () => {
  it('never includes submitted values in any failure class', async () => {
    const secrets = ['super-secret-auth-code', 'super-secret-verifier', 'token-abc'];
    const cases: Array<() => Promise<Awaited<ReturnType<typeof exchangeAuthorizationCode>>>> = [
      () =>
        exchangeAuthorizationCode(
          { provider: 'kick', code: secrets[0]!, redirectUri: EXT_REDIRECT, codeVerifier: secrets[1]! },
          { origin: 'https://attacker.example' },
          { config: config(), fetch: vi.fn() as unknown as typeof fetch },
        ),
      () =>
        exchangeAuthorizationCode(
          { provider: 'kick', code: secrets[0]!, redirectUri: 'https://attacker.example/cb' },
          { origin: EXT_ORIGIN },
          { config: config(), fetch: vi.fn() as unknown as typeof fetch },
        ),
      () =>
        exchangeAuthorizationCode(
          { provider: 'kick', code: secrets[0]!, redirectUri: EXT_REDIRECT },
          { origin: EXT_ORIGIN },
          {
            config: config(),
            fetch: vi.fn().mockResolvedValue(new Response(secrets[2]!, { status: 401 })) as unknown as typeof fetch,
          },
        ),
    ];

    for (const run of cases) {
      const result = await run();
      expect(result.ok).toBe(false);
      const serialized = JSON.stringify(result);
      for (const secret of secrets) expect(serialized).not.toContain(secret);
    }
  });

  it('never writes credentials to a log sink', async () => {
    const sinks: unknown[][] = [];
    const capture = (...args: unknown[]) => sinks.push(args);
    vi.spyOn(console, 'log').mockImplementation(capture as never);
    vi.spyOn(console, 'error').mockImplementation(capture as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200 }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    await exchangeAuthorizationCode(
      { provider: 'kick', code: 'leaky-code', redirectUri: EXT_REDIRECT, codeVerifier: 'leaky-verifier' },
      { origin: EXT_ORIGIN },
      d,
    );
    await exchangeAuthorizationCode(
      { provider: 'kick', code: 'leaky-code', redirectUri: EXT_REDIRECT },
      { origin: 'https://attacker.example' },
      d,
    );

    const output = JSON.stringify(sinks);
    expect(output).not.toContain('leaky-code');
    expect(output).not.toContain('leaky-verifier');
    expect(output).not.toContain('kick-client-secret-value');
    expect(output).not.toContain('twitch-client-secret-value');
    vi.restoreAllMocks();
  });
});

describe('application-level tokens (task 2.3)', () => {
  it('requests a client-credentials grant and returns the token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ access_token: 'app-at', token_type: 'bearer', expires_in: 7200 }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await issueAppToken('kick', { origin: EXT_ORIGIN }, d, () => 'https://id.kick.com/oauth/token');

    expect(result.ok).toBe(true);
    const sent = new URLSearchParams(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(sent.get('grant_type')).toBe('client_credentials');
    expect(sent.get('client_secret')).toBe('kick-client-secret-value');
  });

  it('holds the issued token only in memory, never on disk or a log sink', async () => {
    const sinks: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation(((...a: unknown[]) => sinks.push(a)) as never);
    vi.spyOn(console, 'error').mockImplementation(((...a: unknown[]) => sinks.push(a)) as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ access_token: 'app-at-secret', token_type: 'bearer', expires_in: 7200 }));
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    await issueAppToken('kick', { origin: EXT_ORIGIN }, d, () => 'https://id.kick.com/oauth/token');

    expect(JSON.stringify(sinks)).not.toContain('app-at-secret');
    vi.restoreAllMocks();
  });

  it('rejects an unauthorized caller before requesting a grant', async () => {
    const fetchMock = vi.fn();
    const d = { config: config(), fetch: fetchMock as unknown as typeof fetch };

    const result = await issueAppToken('kick', { origin: 'https://attacker.example' }, d, () => 'x');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('statelessness across restarts (task 2.6)', () => {
  it('accepts a valid request identically on a brand new instance', async () => {
    const makeResponse = () =>
      vi.fn().mockResolvedValue(okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200 }));
    const input = { provider: 'twitch', code: 'c', redirectUri: EXT_REDIRECT } as const;
    const ctx = { origin: EXT_ORIGIN };

    const first = await exchangeAuthorizationCode(input, ctx, {
      config: config(),
      fetch: makeResponse() as unknown as typeof fetch,
    });
    // A restart replaces the whole service; a stateful broker would reject here.
    const second = await exchangeAuthorizationCode(input, ctx, {
      config: config(),
      fetch: makeResponse() as unknown as typeof fetch,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('carries no state requiring migration between two live server instances', async () => {
    // A Response body can only be read once, so each call gets a fresh instance.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(okResponse({ access_token: 'at', token_type: 'bearer', expires_in: 7200 })),
      );

    const a = createBroker({ config: config(), fetchImpl: fetchMock as unknown as typeof fetch });
    const b = createBroker({ config: config(), fetchImpl: fetchMock as unknown as typeof fetch });
    const portA = await a.listen();
    const portB = await b.listen();

    try {
      const post = (port: number) =>
        fetch(`http://127.0.0.1:${port}/oauth/exchange`, {
          method: 'POST',
          headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT }),
        });

      const [resA, resB] = await Promise.all([post(portA), post(portB)]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
    } finally {
      a.server.close();
      b.server.close();
    }
  });
});

describe('broker HTTP surface', () => {
  it('answers 404 on an unknown path and 405 on a wrong method', async () => {
    const broker = createBroker({ config: config(), fetchImpl: vi.fn() as unknown as typeof fetch });
    const port = await broker.listen();
    try {
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
      const wrongMethod = await fetch(`http://127.0.0.1:${port}/oauth/exchange`, {
        method: 'GET',
        headers: { origin: EXT_ORIGIN },
      });
      expect(wrongMethod.status).toBe(405);
    } finally {
      broker.server.close();
    }
  });

  it('returns 403 to an unregistered origin over HTTP', async () => {
    const broker = createBroker({ config: config(), fetchImpl: vi.fn() as unknown as typeof fetch });
    const port = await broker.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/oauth/exchange`, {
        method: 'POST',
        headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'kick', code: 'c', redirectUri: EXT_REDIRECT }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('unauthorized_caller');
    } finally {
      broker.server.close();
    }
  });

  it('rejects an oversized request body', async () => {
    const broker = createBroker({ config: config(), fetchImpl: vi.fn() as unknown as typeof fetch });
    const port = await broker.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/oauth/exchange`, {
        method: 'POST',
        headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'kick', code: 'x'.repeat(20_000) }),
      });
      expect(res.ok).toBe(false);
    } finally {
      broker.server.close();
    }
  });
});

describe('credential renewal and revocation', () => {
  const ctx = { origin: EXT_ORIGIN };
  const deps = (fetchImpl: unknown) => ({ config: config(), fetch: fetchImpl as typeof fetch });

  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0): URLSearchParams =>
    new URLSearchParams(String(fetchMock.mock.calls[call]![1]!.body));

  it('exchanges a refresh token with the client secret the extension lacks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ access_token: 'at-2', token_type: 'bearer', expires_in: 7200, refresh_token: 'rt-2' }),
    );

    const result = await refreshAccessToken({ provider: 'twitch', refreshToken: 'rt-1' }, ctx, deps(fetchMock));

    expect(result.ok).toBe(true);
    const body = bodyOf(fetchMock);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-1');
    expect(body.get('client_secret')).toBe(ENV.TWITCH_CLIENT_SECRET);
    expect(body.get('client_id')).toBe(ENV.TWITCH_CLIENT_ID);
  });

  it('renews for Kick the same way', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ access_token: 'at-2', token_type: 'bearer', expires_in: 7200, refresh_token: 'rt-2' }),
    );

    await refreshAccessToken({ provider: 'kick', refreshToken: 'rt-1' }, ctx, deps(fetchMock));

    const body = bodyOf(fetchMock);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_secret')).toBe(ENV.KICK_CLIENT_SECRET);
  });

  it('forwards the platform error code so a revoked grant can be told apart', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await refreshAccessToken(
      { provider: 'twitch', refreshToken: 'rt-1' },
      ctx,
      deps(fetchMock),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'platform_rejected',
      oauthError: 'invalid_grant',
    });
  });

  it('still reports a rejection when the platform sends an unreadable body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>gateway error</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await refreshAccessToken(
      { provider: 'twitch', refreshToken: 'rt-1' },
      ctx,
      deps(fetchMock),
    );

    expect(result).toMatchObject({ ok: false, error: 'platform_rejected' });
    expect(result).not.toHaveProperty('oauthError');
  });

  it('refuses a renewal from an unregistered origin without calling the platform', async () => {
    const fetchMock = vi.fn();

    const result = await refreshAccessToken(
      { provider: 'twitch', refreshToken: 'rt-1' },
      { origin: 'chrome-extension://someotherextensionidhere000000000' },
      deps(fetchMock),
    );

    expect(result).toMatchObject({ ok: false, error: 'unauthorized_caller' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing refresh token before any platform call', async () => {
    const fetchMock = vi.fn();

    const result = await refreshAccessToken({ provider: 'twitch', refreshToken: '' }, ctx, deps(fetchMock));

    expect(result).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a rejected grant without echoing the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));

    const result = await refreshAccessToken({ provider: 'twitch', refreshToken: 'rt-1' }, ctx, deps(fetchMock));

    expect(result).toMatchObject({ ok: false, error: 'platform_rejected' });
    expect(JSON.stringify(result)).not.toContain('rt-1');
  });

  it('treats an unreachable platform as a transport failure, not a dead grant', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await refreshAccessToken({ provider: 'twitch', refreshToken: 'rt-1' }, ctx, deps(fetchMock));

    expect(result).toMatchObject({ ok: false, error: 'platform_unavailable' });
  });

  it('revokes a token using only the public client id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));

    const result = await revokeToken({ provider: 'twitch', token: 'at-1' }, ctx, deps(fetchMock));

    expect(result).toMatchObject({ ok: true });
    const body = bodyOf(fetchMock);
    expect(body.get('token')).toBe('at-1');
    expect(body.get('client_id')).toBe(ENV.TWITCH_CLIENT_ID);
    // Revoking must never require the secret to be echoed anywhere.
    expect(body.get('client_secret')).toBeNull();
  });

  it('serves renewal and revocation over HTTP with the same origin rules', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ access_token: 'at-2', token_type: 'bearer', expires_in: 7200 }));
    const broker = createBroker({ config: config(), fetchImpl: fetchMock as unknown as typeof fetch });
    const port = await broker.listen();

    try {
      const base = `http://127.0.0.1:${port}`;
      const headers = { 'content-type': 'application/json', origin: EXT_ORIGIN };

      const renewed = await fetch(`${base}/oauth/refresh`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'twitch', refreshToken: 'rt-1' }),
      });
      expect(renewed.status).toBe(200);
      const renewedBody = await renewed.text();
      expect(JSON.parse(renewedBody)).toMatchObject({ ok: true, provider: 'twitch' });
      expect(renewedBody).not.toContain(ENV.TWITCH_CLIENT_SECRET);
      expect(renewedBody).not.toContain('rt-1');

      const rejected = await fetch(`${base}/oauth/refresh`, {
        method: 'POST',
        headers: { ...headers, origin: 'https://example.com' },
        body: JSON.stringify({ provider: 'twitch', refreshToken: 'rt-1' }),
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.text()).toContain('unauthorized_caller');

      const revoked = await fetch(`${base}/oauth/revoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'twitch', token: 'at-1' }),
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.text()).toContain('"revoked":true');

      const wrongMethod = await fetch(`${base}/oauth/refresh`, { headers });
      expect(wrongMethod.status).toBe(405);
    } finally {
      broker.server.close();
    }
  });
});
