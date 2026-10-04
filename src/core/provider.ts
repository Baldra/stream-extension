/**
 * Core provider contracts (task 3.1). Everything platform-specific lives behind
 * this boundary, so the polling, notification, and dashboard layers never branch
 * on a provider id.
 */

export type ProviderId = string;

export const AUTH_STRATEGIES = ['oauth', 'app_token'] as const;
export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

export interface AccountCredentials {
  accessToken: string;
  /** Absolute epoch milliseconds, from the injected clock -- never Date.now() directly. */
  expiresAt: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

export interface ProviderAccount {
  /** Stable, provider-scoped account key used as a map key. */
  accountId: string;
  providerId: ProviderId;
  /** Display name, e.g. the platform login. */
  displayName: string;
  /** The account whose token the user authorized. */
  credentials: AccountCredentials;
  /** The platform's own id for this user, when the platform requires one. */
  providerUserId?: string;
}

export interface ResolvedChannel {
  /** Provider-scoped channel id, stable across renames. */
  channelId: string;
  /** Current display name/slug, which the user may have since renamed. */
  displayName: string;
  /** The account that authorized this channel being visible. */
  accountId: string;
}

export interface LiveChannelInfo {
  channelId: string;
  displayName: string;
  title: string;
  /** Viewer count at poll time; undefined when the platform does not report one. */
  viewers?: number;
  /** Absolute epoch milliseconds, from the injected clock. */
  startedAt?: number;
  thumbnailUrl?: string;
  /** Game/category, where the platform reports one. Twitch does, Kick does not. */
  category?: string;
}

export interface PollOutcome {
  providerId: ProviderId;
  accountId: string;
  live: LiveChannelInfo[];
  /**
   * Identifies tracked channels the platform no longer reports as live, so
   * offline transitions can be detected without a second round trip.
   */
  wentOffline: string[];
  /**
   * Non-fatal per-channel problems (a deleted channel, one revoked scope).
   * A poll carrying these still counts as successful.
   */
  warnings: PollWarning[];
}

export interface PollWarning {
  channelId?: string;
  reason: 'channel_missing' | 'scope_missing' | 'rate_limited' | 'partial';
  message: string;
}

export interface ProviderCapabilities {
  /** True when the platform exposes an official followed-channel listing. */
  followedChannels: boolean;
  followedStreams: boolean;
  /** Kick: the manual-input substitute for an official follow listing. */
  manualChannelEntry: boolean;
  /** Kick: the optional, disabled-by-default unofficial follow importer. */
  unofficialFollowImport: boolean;
  supportsMultipleAccounts: boolean;
  /** Kick has no official realtime transport, so this is false for both platforms. */
  realtimeEvents: boolean;
}

export interface PublicStreamUrl {
  channelId: string;
  displayName: string;
  url: string;
}

/** The one interface a platform must implement. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly authStrategy: AuthStrategy;
  readonly capabilities: ProviderCapabilities;

  /** Channel entry points that do not need a network round trip. */
  publicStreamUrl(channel: ResolvedChannel): string;

  /** Lists channels the authorized account follows. Unsupported => throw. */
  listFollowedChannels(account: ProviderAccount, cursor?: string): Promise<FollowedChannelPage>;

  /**
   * Looks up one channel by the name the user typed.
   *
   * Adding a channel by handle has to work on every platform, including those with
   * no followed-channel listing to search, so this is a first-class part of the
   * contract. Returning undefined means the platform has no such channel.
   */
  resolveChannelByHandle(account: ProviderAccount, handle: string): Promise<ResolvedChannel | undefined>;

  /**
   * Live status for a bounded set of channels. Providers without a bulk endpoint
   * may fall back to a per-channel lookup; the caller must not assume batching.
   */
  fetchLiveStatus(account: ProviderAccount, channelIds: string[]): Promise<PollOutcome>;
}

export interface FollowedChannelPage {
  channels: ResolvedChannel[];
  /** Opaque cursor; undefined means the listing is exhausted. */
  nextCursor?: string;
}

export class UnsupportedCapabilityError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly capability: keyof ProviderCapabilities,
  ) {
    super(`provider ${providerId} does not support ${capability}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

export class AuthError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly reason: 'expired' | 'revoked' | 'missing_scope',
  ) {
    super(`authentication for ${providerId} is ${reason}`);
    this.name = 'AuthError';
  }
}
