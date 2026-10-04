import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig, type BrokerConfig } from './config';
import {
  exchangeAuthorizationCode,
  issueAppToken,
  refreshAccessToken,
  revokeToken,
  type BrokerResult,
} from './handlers';
import { APP_TOKEN_PROVIDERS } from './providers';

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // No credential ever reaches a log sink; only the status and a failure class.
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A token exchange body is a few hundred bytes; cap it so the broker cannot be
    // used as an unbounded buffer.
    if (size > 16 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('request body is not valid JSON');
  }
};

export interface CreateBrokerOptions {
  config: BrokerConfig;
  fetchImpl?: typeof fetch;
}

export function createBroker({ config, fetchImpl = fetch }: CreateBrokerOptions): {
  server: Server;
  listen: () => Promise<number>;
} {
  const deps = { config, fetch: fetchImpl };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      json(res, 400, { ok: false, error: 'invalid_request', message: 'request could not be read' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, providers: Object.keys(config.providers) });
      return;
    }

    // Path is resolved before method so an unknown route reports 404 rather than
    // 405; a 405 on a path that does not exist is misleading to the caller.
    const route: string | null =
      url.pathname === '/oauth/exchange'
        ? 'exchange'
        : url.pathname === '/oauth/app-token'
          ? 'app-token'
          : url.pathname === '/oauth/refresh'
            ? 'refresh'
            : url.pathname === '/oauth/revoke'
              ? 'revoke'
              : null;
    if (!route) {
      json(res, 404, { ok: false, error: 'invalid_request', message: 'unknown path' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'invalid_request', message: 'method not allowed' });
      return;
    }

    const body = (await readBody(req)) as Record<string, unknown>;

    let result: BrokerResult<unknown>;
    if (route === 'exchange') {
      result = await exchangeAuthorizationCode(
        {
          provider: String(body.provider ?? ''),
          code: String(body.code ?? ''),
          redirectUri: String(body.redirectUri ?? ''),
          codeVerifier: typeof body.codeVerifier === 'string' ? body.codeVerifier : undefined,
        },
        { origin },
        deps,
      );
    } else if (route === 'refresh') {
      result = await refreshAccessToken(
        {
          provider: String(body.provider ?? ''),
          refreshToken: String(body.refreshToken ?? ''),
        },
        { origin },
        deps,
      );
    } else if (route === 'revoke') {
      result = await revokeToken(
        {
          provider: String(body.provider ?? ''),
          token: String(body.token ?? ''),
        },
        { origin },
        deps,
      );
    } else {
      const providerId = String(body.provider ?? '');
      if (!APP_TOKEN_PROVIDERS[providerId]) {
        json(res, 400, {
          ok: false,
          error: 'unknown_provider',
          message: 'provider does not offer an application-level grant',
          provider: providerId,
        });
        return;
      }
      result = await issueAppToken(providerId, { origin }, deps, (id) => APP_TOKEN_PROVIDERS[id]!.tokenEndpoint);
    }

    if (!result.ok) {
      json(res, result.error === 'unauthorized_caller' ? 403 : 400, result);
      return;
    }
    json(res, 200, result);
  }

  return {
    server,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(config.port, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : config.port);
        });
      }),
  };
}

export { loadConfig };
