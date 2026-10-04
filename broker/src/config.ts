/**
 * Broker configuration, read from the environment. Client secrets exist here and
 * nowhere else -- design.md decision 1. Nothing in this module may be imported by
 * the extension bundle.
 */
export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface BrokerConfig {
  port: number;
  /** Origins permitted to call the broker. The extension origin is the only one. */
  allowedOrigins: string[];
  /** Redirect URIs the broker will accept in an exchange request. */
  allowedRedirectUris: string[];
  providers: Record<string, ProviderCredentials>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const requireVar = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`missing required environment variable: ${name}`);
  return value;
};

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const providers: Record<string, ProviderCredentials> = {
    twitch: {
      clientId: requireVar(env, 'TWITCH_CLIENT_ID'),
      clientSecret: requireVar(env, 'TWITCH_CLIENT_SECRET'),
    },
    kick: {
      clientId: requireVar(env, 'KICK_CLIENT_ID'),
      clientSecret: requireVar(env, 'KICK_CLIENT_SECRET'),
    },
  };

  const allowedOrigins = splitList(env.ALLOWED_ORIGINS ?? '');
  if (allowedOrigins.length === 0) {
    throw new ConfigError('missing required environment variable: ALLOWED_ORIGINS');
  }

  const allowedRedirectUris = splitList(env.ALLOWED_REDIRECT_URIS ?? '');
  if (allowedRedirectUris.length === 0) {
    throw new ConfigError('missing required environment variable: ALLOWED_REDIRECT_URIS');
  }

  // 0 is valid and means "bind an ephemeral port", which is how the test suite
  // avoids colliding with an already-running instance.
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`invalid PORT: ${env.PORT}`);
  }

  return { port, allowedOrigins, allowedRedirectUris, providers };
}
