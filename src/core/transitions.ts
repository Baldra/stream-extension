import type { LiveChannelInfo, PollOutcome, ProviderId } from './provider';

export interface TransitionContext {
  providerId: ProviderId;
  accountId: string;
  /** Channels first observed in a previous successful poll, before this one. */
  previouslyLiveChannelIds: string[];
  /**
   * Channels that already have a last known successful state, live or offline.
   *
   * A channel in this set whose last state was not live is a genuine
   * offline-to-online flip and raises an event. A channel outside it is being
   * seen for the first time, so it is only recorded.
   */
  observedChannelIds: string[];
}

export interface WentLiveEvent {
  kind: 'went_live';
  providerId: ProviderId;
  accountId: string;
  info: LiveChannelInfo;
}

export interface WentOfflineEvent {
  kind: 'went_offline';
  providerId: ProviderId;
  accountId: string;
  channelId: string;
}

export type TransitionEvent = WentLiveEvent | WentOfflineEvent;

export interface DiffTransitionsInput {
  context: TransitionContext;
  outcome: PollOutcome;
  liveByChannelId: Map<string, LiveChannelInfo>;
}

/**
 * Pure diff between the last known live set and this poll's result (task 3.4).
 *
 * Two rules come straight from the live-detection spec:
 *  - a channel that was already live produces no event, so polling cannot
 *    re-notify;
 *  - a channel first observed already live produces no event, because there was
 *    no offline-to-online transition to report.
 */
export function diffTransitions({ context, outcome, liveByChannelId }: DiffTransitionsInput): TransitionEvent[] {
  const events: TransitionEvent[] = [];
  const previouslyLive = new Set(context.previouslyLiveChannelIds);
  const observed = new Set(context.observedChannelIds);

  for (const info of outcome.live) {
    if (previouslyLive.has(info.channelId)) continue;
    if (!observed.has(info.channelId)) continue;
    events.push({
      kind: 'went_live',
      providerId: context.providerId,
      accountId: context.accountId,
      info,
    });
  }

  for (const channelId of outcome.wentOffline) {
    events.push({
      kind: 'went_offline',
      providerId: context.providerId,
      accountId: context.accountId,
      channelId,
    });
  }

  return events;
}

/** The live set to persist after a successful poll. */
export function nextLiveState(liveByChannelId: Map<string, LiveChannelInfo>): string[] {
  return [...liveByChannelId.keys()];
}
