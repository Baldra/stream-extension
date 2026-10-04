import { ALARM_NAME, ONGOING_FAILURE_ATTEMPTS, POLL_PERIOD_MS } from './constants';
import { Backoff, classifyFailure, isBackoffWorthy } from './backoff';
import type { Clock } from './clock';
import { pollAccount } from './polling';
import { diffTransitions, nextLiveState, type TransitionEvent } from './transitions';
import type { ProviderRegistry } from './registry';
import { accountKey, type Repository } from './repository';
import type { LiveChannelInfo, ProviderId } from './provider';
import type { PersistedAccount, PersistedChannel } from './state';
import type { Scheduler } from './scheduler';
import type { AccountManager } from './accounts';

export interface WentLiveNotice {
  providerId: ProviderId;
  accountId: string;
  channelId: string;
  displayName: string;
  title: string;
  viewers?: number;
  thumbnailUrl?: string;
  category?: string;
  streamUrl: string;
  wentLiveAt: number;
}

export interface PollReport {
  events: TransitionEvent[];
  /** Channels recorded as live by this poll, per account. */
  liveByAccount: Array<{ providerId: ProviderId; accountId: string; channelIds: string[] }>;
  failures: Array<{ providerId: ProviderId; accountId: string; reason: string }>;
  ongoingFailures: Array<{ providerId: ProviderId; accountId: string; attempts: number }>;
  /** True when at least one account's live state was left untouched by failure. */
  anyFailed: boolean;
}

export interface DetectionDeps {
  registry: ProviderRegistry;
  repository: Repository;
  accounts: AccountManager;
  scheduler: Scheduler;
  clock: Clock;
  backoff?: Backoff;
  /** Public stream url for a notification, resolved per provider. */
  streamUrlFor(providerId: ProviderId, channelId: string, displayName: string): string;
  onWentLive?: (notice: WentLiveNotice) => void | Promise<void>;
}



/**
 * The live-detection engine (group 9).
 *
 * It is deliberately free of provider ids: every decision comes from the adapter
 * contract, so adding a platform requires no change here.
 */
export class LiveDetectionService {
  readonly backoff: Backoff;
  #started = false;

  constructor(private readonly deps: DetectionDeps) {
    this.backoff = deps.backoff ?? new Backoff();
  }

  /**
   * Schedules only when there is something to poll (task 9.1). Polling with no
   * tracked channels would spend the user's quota for no result.
   */
  async syncSchedule(): Promise<boolean> {
    const accounts = await this.deps.repository.accounts();
    const anyTracked = await this.hasTrackedChannels(accounts);
    if (anyTracked && !this.#started) {
      this.deps.scheduler.start(POLL_PERIOD_MS, async () => {
        await this.pollAll();
      });
      this.#started = true;
      return true;
    }
    if (!anyTracked && this.#started) {
      this.deps.scheduler.stop();
      this.#started = false;
      return true;
    }
    return false;
  }

  async hasTrackedChannels(accounts: PersistedAccount[]): Promise<boolean> {
    for (const account of accounts) {
      const channels = await this.deps.repository.channels(account.providerId, account.accountId);
      if (channels.some((c) => !c.locallyRemoved)) return true;
    }
    return false;
  }

  get isScheduled(): boolean {
    return this.#started;
  }

  /**
   * Fans out across every provider and account (task 9.2). Each account is polled
   * independently so one failure cannot block the others, and each provider's own
   * batching applies inside its adapter.
   */
  async pollAll(): Promise<PollReport> {
    const report: PollReport = {
      events: [],
      liveByAccount: [],
      failures: [],
      ongoingFailures: [],
      anyFailed: false,
    };

    const accounts = await this.deps.repository.accounts();
    for (const account of accounts) {
      if (account.requiresReconnection) continue;
      const key = accountKey(account.providerId, account.accountId);

      // Respect the cooling-off window; no request is made at all (task 9.6).
      if (this.backoff.isCoolingDown(key, this.deps.clock.now())) {
        // A suppressed retry is only worth telling the user about once the
        // failures have stopped looking transient.
        if (this.backoff.isOngoingFailure(key, ONGOING_FAILURE_ATTEMPTS)) {
          report.ongoingFailures.push({
            providerId: account.providerId,
            accountId: account.accountId,
            attempts: this.backoff.attemptsFor(key),
          });
        }
        continue;
      }

      const result = await this.pollOne(account, report);
      if (result === 'failed') report.anyFailed = true;
      else if (result) report.events.push(...result);
    }
    return report;
  }

  /**
   * Polls one account. Returns the transition events on success, 'failed' when the
   * account's state was deliberately left untouched, and undefined when it had
   * nothing to do.
   */
  private async pollOne(account: PersistedAccount, report: PollReport): Promise<TransitionEvent[] | 'failed' | undefined> {
    const key = accountKey(account.providerId, account.accountId);
    const adapter = this.deps.registry.get(account.providerId);

    const tracked: PersistedChannel[] = (await this.deps.repository.channels(
      account.providerId,
      account.accountId,
    )).filter((c) => !c.locallyRemoved);

    if (tracked.length === 0) {
      // Nothing tracked: clear any stale live state rather than leaving it to
      // suggest the channel is still live.
      await this.deps.repository.replaceLiveState(account.providerId, account.accountId, []);
      return undefined;
    }

    // Renewal runs ahead of the query (task 9.7), so a token about to expire never
    // turns a poll into a spurious auth failure.
    let usable = account;
    try {
      const credentials = await this.deps.accounts.credentialsFor(account);
      usable = { ...account, credentials };
    } catch {
      // The account manager has already recorded the state change; nothing to poll.
      report.failures.push({
        providerId: account.providerId,
        accountId: account.accountId,
        reason: 'credentials',
      });
      report.anyFailed = true;
      return 'failed';
    }

    const previousRows = await this.deps.repository.liveRows(account.providerId, account.accountId);
    const previouslyLive = previousRows.map((row) => row.channelId);
    // A channel with no last known state cannot produce a transition: it is only
    // being seen for the first time (live-detection spec).
    const observedChannelIds = tracked.filter((c) => c.lastObservedAt !== undefined).map((c) => c.providerChannelId);

    try {
      const result = await pollAccount({
        adapter,
        account: usable,
        trackedChannelIds: tracked.map((c) => c.providerChannelId),
        previouslyLiveChannelIds: previouslyLive,
      });

      const events = diffTransitions({
        context: {
          providerId: account.providerId,
          accountId: account.accountId,
          previouslyLiveChannelIds: previouslyLive,
          observedChannelIds,
        },
        outcome: result.outcome,
        liveByChannelId: result.liveByChannelId,
      });

      // Only now, after a fully successful poll, is live state mutated (task 9.5).
      const now = this.deps.clock.now();
      // The stamp covers every channel with a known state, so a partial answer does
      // not make an already-observed channel look brand new next time.
      const nowObserved = [...new Set([...observedChannelIds, ...result.observedChannelIds])];
      // Only a channel the platform actually answered for this poll may change
      // state. One it could not resolve is unknown, not offline, so its previous row
      // is carried over untouched instead of being deleted.
      // A channel the provider listed as live is answered for, even if it also
      // carried a warning about that channel; only a channel that is neither in the
      // answer nor claimed live has to keep its previous row.
      const answered = new Set([...result.observedChannelIds, ...result.liveByChannelId.keys()]);
      const unresolvedRows = previousRows.filter((row) => !answered.has(row.channelId));
      const previousById = new Map(previousRows.map((row) => [row.channelId, row]));

      await this.deps.repository.applySuccessfulPoll({
        providerId: account.providerId,
        accountId: account.accountId,
        at: now,
        observedChannelIds: nowObserved,
        liveRows: [
          ...unresolvedRows,
          ...[...result.liveByChannelId.values()].map((info) => {
            const previous = previousById.get(info.channelId);
            return {
              providerId: account.providerId,
              accountId: account.accountId,
              channelId: info.channelId,
              title: info.title,
              viewers: info.viewers,
              startedAt: info.startedAt,
              thumbnailUrl: info.thumbnailUrl,
              wentLiveAt: now,
              // A stream that was already live keeps the flag set when its
              // notification was shown; only a brand new stream starts unnotified.
              notified: previous !== undefined,
            };
          }),
        ],
      });

      this.backoff.succeed(key);
      await this.deps.repository.putAccount({
        ...account,
        lastPolledAt: now,
        consecutivePollFailures: 0,
      });
      report.liveByAccount.push({
        providerId: account.providerId,
        accountId: account.accountId,
        channelIds: nextLiveState(result.liveByChannelId),
      });

      const handleFor = new Map(tracked.map((c) => [c.providerChannelId, c.handle]));
      for (const event of events) {
        if (event.kind !== 'went_live') continue;
        await this.emitWentLive(event.providerId, event.accountId, event.info, handleFor, now);
      }

      return events;
    } catch (error) {
      const now = this.deps.clock.now();
      const reason = classifyFailure(error);
      if (isBackoffWorthy(reason)) {
        this.backoff.fail(key, now, error);
      }
      // The live state is left untouched, but the fact that it is no longer being
      // verified is recorded, so the dashboard can say so instead of showing a
      // stale entry as if it were current.
      await this.deps.repository.putAccount({
        ...account,
        consecutivePollFailures: (account.consecutivePollFailures ?? 0) + 1,
      });
      report.failures.push({
        providerId: account.providerId,
        accountId: account.accountId,
        reason,
      });
      // State is left exactly as it was: no false offline, no lost live channel.
      return 'failed';
    }
  }

  private async emitWentLive(
    providerId: ProviderId,
    accountId: string,
    info: LiveChannelInfo,
    handleFor: Map<string, string>,
    now: number,
  ): Promise<void> {
    const displayName = handleFor.get(info.channelId) ?? info.displayName;
    await this.deps.onWentLive?.({
      providerId,
      accountId,
      channelId: info.channelId,
      displayName,
      title: info.title,
      viewers: info.viewers,
      ...(info.thumbnailUrl ? { thumbnailUrl: info.thumbnailUrl } : {}),
      ...(info.category ? { category: info.category } : {}),
      streamUrl: this.deps.streamUrlFor(providerId, info.channelId, displayName),
      wentLiveAt: now,
    });
  }

  /** Test hook: the alarm name this service is scheduled under. */
  static readonly alarmName = ALARM_NAME;
}
