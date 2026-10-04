import { describe, expect, it, vi } from 'vitest';
import { createBrokerHttpClient } from '../src/background/broker-client';
import { TokenRefreshError } from '../src/core/tokens';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (fetchImpl: Mock, baseUrl = 'https://broker.example/') =>
  createBrokerHttpClient({ baseUrl, fetchImpl: fetchImpl as unknown as typeof fetch });

/** A vi.fn() with the call recording the assertions need. */
type Mock = ReturnType<typeof vi.fn>;

describe('broker http client', () => {
  it('posts the exchange to the single configured origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ ok: true, provider: 'twitch', data: { access_token: 'at-1', expires_in: 7200 } }),
    );

    const result = await client(fetchImpl).exchange({
      provider: 'twitch',
      code: 'code-1',
      redirectUri: 'https://ext.chromiumapp.org/',
      codeVerifier: 'verifier-1',
    });

    expect(result).toEqual({ access_token: 'at-1', expires_in: 7200 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://broker.example/oauth/exchange');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'twitch',
      code: 'code-1',
      redirectUri: 'https://ext.chromiumapp.org/',
      codeVerifier: 'verifier-1',
    });
  });

  it('never sends a client secret, because it has none', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ ok: true, provider: 'twitch', data: { access_token: 'at-2', expires_in: 7200 } }),
    );

    await client(fetchImpl).refresh({ provider: 'twitch', refreshToken: 'rt-1' });

    const sent = JSON.stringify(fetchImpl.mock.calls);
    expect(sent).not.toMatch(/client_secret/i);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      provider: 'twitch',
      refreshToken: 'rt-1',
    });
  });

  it('sends the access token for revocation under the field the broker expects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true, data: { revoked: true } }));

    await client(fetchImpl).revoke({ provider: 'twitch', accessToken: 'at-1' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://broker.example/oauth/revoke');
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'twitch', token: 'at-1' });
  });

  it('treats a forwarded invalid_grant as permanent, so the account is flagged', async () => {
    // Only a refusal the platform will keep repeating may put an account into
    // "needs reconnection", so the code has to survive the broker hop.
    const fetchImpl = vi.fn().mockResolvedValue(
      json(
        {
          ok: false,
          error: 'platform_rejected',
          oauthError: 'invalid_grant',
          message: 'platform rejected the renewal (400)',
        },
        400,
      ),
    );

    await expect(client(fetchImpl).refresh({ provider: 'twitch', refreshToken: 'rt-1' })).rejects.toMatchObject(
      { reason: 'invalid_grant' },
    );
  });

  it('treats an unclassified platform rejection as temporary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ ok: false, error: 'platform_rejected', message: 'platform unavailable' }, 503),
    );

    await expect(client(fetchImpl).refresh({ provider: 'twitch', refreshToken: 'rt-1' })).rejects.toMatchObject(
      { reason: 'temporarily_unavailable' },
    );
  });

  it('treats an unreachable broker as temporary, so the account is not flagged', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const error = await client(fetchImpl)
      .refresh({ provider: 'twitch', refreshToken: 'rt-1' })
      .then(() => undefined)
      .catch((e: unknown) => e as TokenRefreshError);

    // Flagging the account as needing reconnection over a network blip would make
    // the user reconnect for no reason.
    expect(error?.reason).toBe('temporarily_unavailable');
    expect(error?.message).not.toContain('rt-1');
  });

  it('does not leak a submitted token into an error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    const error = await client(fetchImpl)
      .refresh({ provider: 'twitch', refreshToken: 'super-secret-refresh-token' })
      .then(() => undefined)
      .catch((e: unknown) => e as Error);

    expect(error?.message).not.toContain('super-secret-refresh-token');
  });

  it('rejects a non-JSON response rather than trusting it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(client(fetchImpl).refresh({ provider: 'twitch', refreshToken: 'rt-1' })).rejects.toThrow(
      /broker_invalid_response/,
    );
  });
});
