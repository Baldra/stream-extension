import type { AccountCredentials, ProviderId } from './provider';

/**
 * The persisted state model (task 4.1). Channel identity is
 * `(providerId, providerChannelId)`; the handle is display-only and is expected
 * to go stale on rename.
 */
export interface PersistedAccount {
  accountId: string;
  providerId: ProviderId;
  displayName: string;
  credentials: AccountCredentials;
  /** Set once renewal has permanently failed; cleared by a successful reconnect. */
  requiresReconnection: boolean;
  /** Set when a disconnect revoked upstream credentials, for user messaging. */
  revokedUpstream?: boolean;
  /**
   * The platform's own id for this user, e.g. Twitch's numeric user id.
   *
   * Helix will not accept a login in place of an id, and the access token is not a
   * source for it, so it is resolved once at connect time and kept. It is also the
   * only stable account identity that does not change when the token rotates.
   */
  providerUserId?: string;
  /** When a poll last completed successfully, from the injected clock. */
  lastPolledAt?: number;
  /**
   * Consecutive failed polls. Non-zero means the last known live state for this
   * account is no longer being verified, which the dashboard must say rather than
   * present stale entries as current.
   */
  consecutivePollFailures?: number;
}

export interface PersistedChannel {
  providerId: ProviderId;
  providerChannelId: string;
  /** Display only. Never an identity component. */
  handle: string;
  accountId: string;
  trackedAt: number;
  /** How the channel came to be tracked. */
  source: 'follow_import' | 'manual';
  /**
   * Locally removed but still present upstream. A later follow import must not
   * resurrect it (task 6.4).
   */
  locallyRemoved?: boolean;
  /**
   * When a successful poll last gave a definitive answer for this channel.
   *
   * This is what separates "last known state was offline" from "never observed",
   * which the live set alone cannot express: a channel absent from `live` is
   * either offline or unknown. Only a channel with this stamp can produce a
   * newly-live event (live-detection spec, requirement "Detect a stream that
   * just started").
   */
  lastObservedAt?: number;
}

export interface PersistedLiveState {
  providerId: ProviderId;
  accountId: string;
  channelId: string;
  title: string;
  viewers?: number;
  /** Absolute epoch milliseconds, from the injected clock. */
  startedAt?: number;
  thumbnailUrl?: string;
  /** Absolute epoch milliseconds of the poll that first observed this stream. */
  wentLiveAt: number;
  /** Whether the user has already been notified for this stream. */
  notified: boolean;
}

export interface PersistedSettings {
  /**
   * Per-platform notification switch. A platform is on unless explicitly turned
   * off, so a new platform is never silently muted.
   */
  notificationsDisabled: ProviderId[];
  /**
   * Whether the user has explicitly enabled the unofficial follow import.
   *
   * It is false by default and is never turned on implicitly: the undocumented
   * endpoints it uses are unsupported, and a default install must not reach them.
   */
  unofficialFollowImportEnabled: boolean;
}

export interface NotificationHistoryEntry {
  entryId: string;
  providerId: ProviderId;
  accountId: string;
  channelId: string;
  displayName: string;
  title: string;
  wentLiveAt: number;
  streamUrl: string;
}

export interface PersistedState {
  schemaVersion: number;
  settings: PersistedSettings;
  accounts: PersistedAccount[];
  channels: PersistedChannel[];
  live: PersistedLiveState[];
  history: NotificationHistoryEntry[];
}

export const CURRENT_SCHEMA_VERSION = 3;

export const emptyState = (): PersistedState => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  settings: { notificationsDisabled: [], unofficialFollowImportEnabled: false },
  accounts: [],
  channels: [],
  live: [],
  history: [],
});
