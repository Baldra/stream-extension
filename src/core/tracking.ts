import { buildDashboard, dashboardChannelKey, type DashboardChannelInput } from './dashboard';
import type { ProviderId, ProviderAdapter, ProviderAccount, ResolvedChannel } from './provider';
import type { PersistedChannel, PersistedLiveState } from './state';
import type { Repository } from './repository';
import { accountKey } from './repository';
import { UnofficialImportUnavailableError } from './unofficial-import';

/** How a manual add resolved, so the UI can explain an unknown handle. */
export type AddResult =
  | { ok: true; channel: PersistedChannel; alreadyTracked: boolean }
  | { ok: false; reason: 'unknown_handle' | 'unsupported' | 'auth_required' };

export type ImportSummary = {
  added: string[];
  /** Still followed upstream but removed locally, so deliberately not re-added. */
  skippedLocallyRemoved: string[];
  updated: string[];
};

export class ChannelTracker {
  constructor(
    private readonly repository: Repository,
    private readonly clock: { now(): number },
  ) {}

  /**
   * Channel identity is `(providerId, providerChannelId)` (task 6.1). The handle is
   * display-only, so a rename updates the label and leaves identity intact.
   */
  async track(
    account: ProviderAccount,
    resolved: ResolvedChannel,
    source: PersistedChannel['source'],
  ): Promise<PersistedChannel> {
    const existing = await this.repository.channel(account.providerId, account.accountId, resolved.channelId);
    // The new record deliberately omits `locallyRemoved`: reaching `track` means
    // an explicit add or a fresh upstream follow, so the suppression is cleared.
    const channel: PersistedChannel = {
      providerId: account.providerId,
      providerChannelId: resolved.channelId,
      // Refresh the label on every sighting, so a rename propagates.
      handle: resolved.displayName,
      accountId: account.accountId,
      trackedAt: existing?.trackedAt ?? this.clock.now(),
      source,
    };

    await this.repository.putChannel(channel);
    return channel;
  }

  /**
   * Resolves a handle to a stable id via the adapter, then tracks it (task 6.2).
   * Re-adding an already-tracked handle succeeds idempotently.
   */
  async addByHandle(
    adapter: ProviderAdapter,
    account: ProviderAccount,
    handle: string,
  ): Promise<AddResult> {
    const normalized = handle.trim().replace(/^@/, '').toLowerCase();
    if (!normalized) return { ok: false, reason: 'unknown_handle' };

    const resolved = await resolveHandle(adapter, account, normalized);
    if (!resolved) return { ok: false, reason: 'unknown_handle' };

    const existing = await this.repository.channel(account.providerId, account.accountId, resolved.channelId);
    const channel = await this.track(account, resolved, 'manual');
    return { ok: true, channel, alreadyTracked: Boolean(existing) };
  }

  /** Removal succeeds even when the channel was not tracked (task 6.3). */
  async remove(account: Pick<ProviderAccount, 'providerId' | 'accountId'>, channelId: string): Promise<void> {
    await this.repository.removeChannel(account.providerId, account.accountId, channelId);
  }

  /**
   * Marks a channel as locally removed without forgetting it was followed
   * upstream, so a later import does not resurrect it (task 6.4).
   */
  async markLocallyRemoved(account: Pick<ProviderAccount, 'providerId' | 'accountId'>, channelId: string): Promise<void> {
    const channel = await this.repository.channel(account.providerId, account.accountId, channelId);
    if (!channel) return;
    await this.repository.putChannel({ ...channel, locallyRemoved: true });
  }

  /**
   * Additive-only merge (task 6.4): adds newly-followed channels, refreshes
   * handles, and never removes a channel that is no longer upstream.
   */
  async importFollowed(
    adapter: ProviderAdapter,
    account: ProviderAccount,
  ): Promise<ImportSummary> {
    const summary: ImportSummary = { added: [], skippedLocallyRemoved: [], updated: [] };

    for await (const resolved of iterateFollowed(adapter, account)) {
      const existing = await this.repository.channel(
        account.providerId,
        account.accountId,
        resolved.channelId,
      );
      if (existing?.locallyRemoved) {
        summary.skippedLocallyRemoved.push(resolved.channelId);
        continue;
      }
      if (!existing) summary.added.push(resolved.channelId);
      else if (existing.handle !== resolved.displayName) summary.updated.push(resolved.channelId);
      await this.track(account, resolved, 'follow_import');
    }
    return summary;
  }

  /**
   * Merges channels fetched by an unofficial, explicitly enabled importer.
   *
   * The guard lives here rather than in the caller so no code path can reach an
   * undocumented endpoint on its own. The merge is the same additive one as the
   * official import, and it runs only after the fetch has fully succeeded, so a
   * failure leaves the tracked set exactly as it was.
   */
  async importUnofficial(
    account: ProviderAccount,
    fetchFollowed: () => Promise<ResolvedChannel[]>,
  ): Promise<ImportSummary> {
    if (!(await this.repository.unofficialFollowImportEnabled())) {
      // Nothing is requested at all while the import is off.
      throw new UnofficialImportUnavailableError(
        'not_enabled',
        'The unofficial follow import is turned off',
      );
    }

    const resolved = await fetchFollowed();
    const summary: ImportSummary = { added: [], skippedLocallyRemoved: [], updated: [] };

    for (const channel of resolved) {
      const existing = await this.repository.channel(
        account.providerId,
        account.accountId,
        channel.channelId,
      );
      if (existing?.locallyRemoved) {
        summary.skippedLocallyRemoved.push(channel.channelId);
        continue;
      }
      if (!existing) summary.added.push(channel.channelId);
      else if (existing.handle !== channel.displayName) summary.updated.push(channel.channelId);
      await this.track(account, channel, 'follow_import');
    }
    return summary;
  }

  /** Channel ids the poll should ask about for an account. */
  async trackedIds(account: Pick<ProviderAccount, 'providerId' | 'accountId'>): Promise<string[]> {
    const channels = await this.repository.channels(account.providerId, account.accountId);
    return channels.filter((c) => !c.locallyRemoved).map((c) => c.providerChannelId);
  }

  lockKey(account: Pick<ProviderAccount, 'providerId' | 'accountId'>): string {
    return accountKey(account.providerId, account.accountId);
  }
}

/** Yields every followed channel, following cursors to exhaustion (task 6.5). */
export async function* iterateFollowed(
  adapter: ProviderAdapter,
  account: ProviderAccount,
): AsyncGenerator<ResolvedChannel, void, void> {
  let cursor: string | undefined;
  // Identifies a page we have already processed. A provider that keeps handing
  // back the same cursor would otherwise loop forever, and checking the page
  // itself (rather than only the cursor) stops the repeat from yielding
  // duplicate channels on the way out.
  const seenPages = new Set<string>();

  for (;;) {
    const page = await adapter.listFollowedChannels(account, cursor);
    const signature = JSON.stringify([page.channels.map((c) => c.channelId), page.nextCursor ?? null]);
    if (seenPages.has(signature)) return;
    seenPages.add(signature);

    for (const channel of page.channels) yield channel;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

/**
 * Handle resolution. The adapter contract has no dedicated lookup, so this uses
 * the followed listing when the platform supports it and otherwise reports the
 * handle as unknown rather than guessing an id.
 */
export async function resolveHandle(
  adapter: ProviderAdapter,
  account: ProviderAccount,
  handle: string,
): Promise<ResolvedChannel | undefined> {
  // The platform's own lookup is authoritative and works everywhere, so it is tried
  // first. Only if a provider declines to answer is the followed listing searched,
  // which is how a platform with no direct lookup can still add a channel.
  const direct = await adapter.resolveChannelByHandle(account, handle);
  if (direct) return direct;

  if (!adapter.capabilities.followedChannels) return undefined;
  for await (const channel of iterateFollowed(adapter, account)) {
    if (channel.displayName.toLowerCase() === handle) return channel;
  }
  return undefined;
}

export interface DashboardInputShape {
  providerId: ProviderId;
  accounts: PersistedAccountLike[];
  channels: PersistedChannel[];
  live: PersistedLiveState[];
  streamUrlFor: (providerId: ProviderId, channelId: string, displayName: string) => string;
  error?: string;
}

interface PersistedAccountLike {
  accountId: string;
  displayName: string;
  requiresReconnection: boolean;
}

export function toDashboardChannels(
  channels: PersistedChannel[],
  live: PersistedLiveState[],
): DashboardChannelInput[] {
  const liveByKey = new Map(live.map((row) => [row.channelId, row]));
  return channels.map((channel) => {
    const row = liveByKey.get(channel.providerChannelId);
    return {
      accountId: channel.accountId,
      channelId: channel.providerChannelId,
      displayName: channel.handle,
      isLive: Boolean(row),
      ...(row
        ? {
            info: {
              channelId: row.channelId,
              displayName: channel.handle,
              title: row.title,
              viewers: row.viewers,
              startedAt: row.startedAt,
              thumbnailUrl: row.thumbnailUrl,
            },
          }
        : {}),
    };
  });
}

export const toDashboardModel = (input: DashboardInputShape) =>
  buildDashboard({
    providerId: input.providerId,
    accounts: input.accounts,
    channels: toDashboardChannels(input.channels, input.live),
    streamUrlFor: input.streamUrlFor,
    ...(input.error ? { error: input.error } : {}),
  });

export { dashboardChannelKey };
