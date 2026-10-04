import type { BrokerConfig } from './config';

/**
 * The token endpoints and per-platform required parameters. Each platform needs
 * different fields: Twitch's authorization-code grant does not take a PKCE
 * verifier, while Kick requires one alongside the secret.
 */
export interface ProviderDefinition {
  id: string;
  tokenEndpoint: string;
  /** Query/body parameters that must be forwarded verbatim to the token endpoint. */
  buildExchangeParams(input: ExchangeInput, credentials: { clientId: string; clientSecret: string }): Record<string, string>;
  /**
   * Parameters for the refresh-token grant. Both platforms require the client
   * secret here, which is precisely why renewal cannot happen in the extension.
   */
  buildRefreshParams(refreshToken: string, credentials: { clientId: string; clientSecret: string }): Record<string, string>;
  label: string;
}

export interface ExchangeInput {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

export const TWITCH: ProviderDefinition = {
  id: 'twitch',
  label: 'twitch',
  tokenEndpoint: 'https://id.twitch.tv/oauth2/token',
  buildExchangeParams(input, { clientId, clientSecret }) {
    return {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: input.redirectUri,
    };
  },
  buildRefreshParams(refreshToken, { clientId, clientSecret }) {
    return {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    };
  },
};

export const KICK: ProviderDefinition = {
  id: 'kick',
  label: 'kick',
  tokenEndpoint: 'https://id.kick.com/oauth/token',
  buildExchangeParams(input, { clientId, clientSecret }) {
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: input.redirectUri,
    };
    // Kick's authorization-code grant is documented as "with PKCE": the verifier is
    // mandatory alongside the client secret, not an alternative to it.
    if (input.codeVerifier) params.code_verifier = input.codeVerifier;
    return params;
  },
  buildRefreshParams(refreshToken, { clientId, clientSecret }) {
    return {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    };
  },
};

/** Application-level (client-credentials) tokens, for anonymous public data. */
export const APP_TOKEN_PROVIDERS: Record<string, Omit<ProviderDefinition, 'buildExchangeParams' | 'buildRefreshParams'>> = {
  kick: { id: 'kick', label: 'kick', tokenEndpoint: 'https://id.kick.com/oauth/token' },
};

export function resolveProvider(id: string, config: BrokerConfig): ProviderDefinition | undefined {
  const credentials = config.providers[id];
  if (!credentials) return undefined;
  if (id === 'twitch') return TWITCH;
  if (id === 'kick') return KICK;
  return undefined;
}
