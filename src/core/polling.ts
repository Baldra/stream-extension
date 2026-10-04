import type { LiveChannelInfo, PollOutcome, PollWarning, ProviderAdapter, ProviderAccount } from './provider';

/**
 * Warning reasons that say nothing about a channel's live state. `channel_missing`
 * is excluded because the platform has definitively answered for that channel: it
 * no longer exists, so it is certainly not live.
 */
const NON_DEFINITIVE_WARNINGS: ReadonlySet<PollWarning['reason']> = new Set([
  'scope_missing',
  'rate_limited',
  'partial',
]);

/**
 * Tracked channels a poll actually learned the state of.
 *
 * Absence from `live` is only evidence of being offline when the provider claims
 * it covered the channel. An unresolved or un-scoped channel is returned as
 * unobserved so its last known state survives untouched.
 */
export function definitiveChannelIds(outcome: PollOutcome, trackedChannelIds: string[]): string[] {
  const inconclusive = outcome.warnings.filter((w) => NON_DEFINITIVE_WARNINGS.has(w.reason));
  if (inconclusive.length === 0) return [...trackedChannelIds];
  // A batch-level warning without a channel id means nothing in it can be trusted.
  if (inconclusive.some((w) => w.channelId === undefined)) return [];
  const unresolved = new Set(inconclusive.map((w) => w.channelId as string));
  return trackedChannelIds.filter((id) => !unresolved.has(id));
}

/**
 * Provider-agnostic polling (the shared seam exercised by task 3.4). Nothing here
 * may reference a provider id: if a branch ever needs one, the contract is wrong.
 */
export interface PollRequest {
  adapter: ProviderAdapter;
  account: ProviderAccount;
  /** Channels the user actually tracks for this account, as provider ids. */
  trackedChannelIds: string[];
  /** Last known live set, used to derive went-offline ids. */
  previouslyLiveChannelIds: string[];
}

export interface PollResult {
  outcome: PollOutcome;
  liveByChannelId: Map<string, LiveChannelInfo>;
  /**
   * Tracked channels the platform gave a definitive answer for, i.e. everything
   * except the ones a provider listed as unknown. Only these may update a
   * channel's last known state.
   */
  observedChannelIds: string[];
}

export async function pollAccount(request: PollRequest): Promise<PollResult> {
  const { adapter, account, trackedChannelIds, previouslyLiveChannelIds } = request;
  const outcome = await adapter.fetchLiveStatus(account, trackedChannelIds);

  const liveByChannelId = new Map<string, LiveChannelInfo>();
  for (const info of outcome.live) liveByChannelId.set(info.channelId, info);

  // A provider may answer "live" for some channels of a batch and admit it could
  // not resolve the rest. Absence from a partial answer therefore proves nothing
  // about the unresolved channels, so they are excluded from the observed set.
  const observedChannelIds = definitiveChannelIds(outcome, trackedChannelIds);
  const observed = new Set(observedChannelIds);

  // wentOffline is derived rather than trusted from the adapter, so a provider
  // cannot report a channel as gone while it is still in the live set. A channel
  // the poll could not answer for is excluded: it may well still be streaming, and
  // claiming it ended would both fake an offline event and drop its live row.
  const stillLive = new Set(liveByChannelId.keys());
  const wentOffline = previouslyLiveChannelIds.filter(
    (id) => !stillLive.has(id) && observed.has(id),
  );

  return { outcome: { ...outcome, wentOffline }, liveByChannelId, observedChannelIds };
}
