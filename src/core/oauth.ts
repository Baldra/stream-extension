import type { ProviderId } from './provider';

export const OAUTH_ENDPOINTS: Record<string, string> = {
  twitch: 'https://id.twitch.tv/oauth2/authorize',
  kick: 'https://id.kick.com/oauth/authorize',
};

/**
 * The minimal scope set each platform permits (task 5.1).
 *
 * Twitch needs `user:read:follows` to read the follow list; the followed-streams
 * endpoint is covered by the same scope. Kick's channel and livestream endpoints
 * are public, so the only thing the extension asks for is the ability to
 * identify the connecting user -- granted without any scope -- and nothing else.
 * Requesting more would violate least privilege.
 */
export const REQUIRED_SCOPES: Record<string, string[]> = {
  twitch: ["user:read:follows"],
  kick: ["user:read channel:read"],
};

export interface AuthorizationRequestInput {
  providerId: ProviderId;
  clientId: string;
  redirectUri: string;
  /** Fresh, unguessable, single-use value binding the response to this attempt. */
  state: string;
  /** Present only for providers that require PKCE. */
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
}

export function buildAuthorizationUrl(input: AuthorizationRequestInput): string {
  const endpoint = OAUTH_ENDPOINTS[input.providerId];
  if (!endpoint) throw new Error(`no authorization endpoint for provider ${input.providerId}`);

  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);

  const scopes = REQUIRED_SCOPES[input.providerId] ?? [];
  if (scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '));
  }

  if (input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', input.codeChallengeMethod ?? 'S256');
  }
  return url.toString();
}

export const scopesFor = (providerId: ProviderId): string[] => [...(REQUIRED_SCOPES[providerId] ?? [])];
