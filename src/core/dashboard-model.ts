import { ONGOING_FAILURE_ATTEMPTS } from './constants';
import type { Clock } from './clock';
import type { ProviderAdapter, ProviderId } from './provider';
import { dashboardChannelKey, type DashboardAccountRow, type DashboardChannelRow } from './dashboard';
import type { Repository } from './repository';
import type { NotificationHistoryEntry } from './state';

/**
 * The cross-provider dashboard model (group 11).
 *
 * The spec requires one list spanning every platform and account, so this reads
 * the whole persisted document rather than one provider's slice. It stays pure
 * with respect to provider identity: labels and stream urls come from the
 * adapters through the registry.
 */
export interface DashboardAccountView extends DashboardAccountRow {
  platformLabel: string;
  channels: DashboardChannelView[];
  /** Last successful poll, if there has been one. */
  lastPolledAt?: number;
  /**
   * True when live state is no longer being verified, either because polls keep
   * failing or because nothing has been checked recently enough to trust.
   */
  notUpdating: boolean;
  /** Why the account is not updating, for a specific message. */
  notUpdatingReason?: 'failing' | 'never_polled' | 'overdue';
}

export interface DashboardChannelView {
  key: string;
  providerId: ProviderId;
  platformLabel: string;
  accountId: string;
  channelId: string;
  displayName: string;
  isLive: boolean;
  streamUrl: string;
  title?: string;
  viewers?: number;
  startedAt?: number;
  /** A live entry recorded during a failing poll; its state is unverified. */
  unverified: boolean;
}

export interface DashboardViewModel {
  accounts: DashboardAccountView[];
  /** Live across all providers, most-watched first. */
  live: DashboardChannelView[];
  history: NotificationHistoryEntry[];
  hasHistory: boolean;
  lastCheckedAt?: number;
  /** Providers with at least one account that is not updating. */
  notUpdatingPlatforms: Array<{ providerId: ProviderId; platformLabel: string }>;
}

export interface DashboardModelDeps {
  repository: Repository;
  registry: { get(providerId: ProviderId): ProviderAdapter; all(): ProviderAdapter[] };
  clock: Clock;
  /** A live entry older than this is treated as unverified rather than current. */
  staleAfterMs?: number;
  historyLimit?: number;
}

const platformLabel = (adapter: ProviderAdapter): string => adapter.displayName;

export async function buildDashboardModel(deps: DashboardModelDeps): Promise<DashboardViewModel> {
  const now = deps.clock.now();
  const staleAfterMs = deps.staleAfterMs ?? 3 * 60_000;
  const [accounts, channels, liveRows, history] = await Promise.all([
    deps.repository.accounts(),
    deps.repository.channels(),
    readAllLive(deps.repository),
    deps.repository.history(deps.historyLimit ?? 50),
  ]);

  const accountsView: DashboardAccountView[] = accounts.map((account) => {
    const adapter = deps.registry.get(account.providerId);
    const own = channels.filter(
      (c) => c.providerId === account.providerId && c.accountId === account.accountId && !c.locallyRemoved,
    );
    const ownLive = liveRows.filter(
      (l) => l.providerId === account.providerId && l.accountId === account.accountId,
    );

    const channelsView: DashboardChannelView[] = own.map((channel) => {
      const row = ownLive.find((l) => l.channelId === channel.providerChannelId);
      const failing = (account.consecutivePollFailures ?? 0) >= ONGOING_FAILURE_ATTEMPTS;
      return {
        key: dashboardChannelKey(account.providerId, account.accountId, channel.providerChannelId),
        providerId: account.providerId,
        platformLabel: platformLabel(adapter),
        accountId: account.accountId,
        channelId: channel.providerChannelId,
        displayName: channel.handle,
        isLive: row !== undefined,
        streamUrl: adapter.publicStreamUrl({
          channelId: channel.providerChannelId,
          displayName: channel.handle,
          accountId: account.accountId,
        }),
        ...(row ? { title: row.title, viewers: row.viewers, startedAt: row.startedAt } : {}),
        // A live entry recorded while polls are failing describes a stream that may
        // have ended minutes ago, so it is shown but flagged as unverified.
        unverified: row !== undefined && failing,
      };
    });

    const failing = (account.consecutivePollFailures ?? 0) >= ONGOING_FAILURE_ATTEMPTS;
    const overdue =
      account.lastPolledAt !== undefined && now - account.lastPolledAt > staleAfterMs;

    return {
      providerId: account.providerId,
      accountId: account.accountId,
      displayName: account.displayName,
      platformLabel: platformLabel(adapter),
      requiresReconnection: account.requiresReconnection,
      trackedCount: channelsView.length,
      liveCount: channelsView.filter((c) => c.isLive).length,
      channels: channelsView,
      ...(account.lastPolledAt !== undefined ? { lastPolledAt: account.lastPolledAt } : {}),
      notUpdating: failing || overdue,
      ...(failing
        ? { notUpdatingReason: 'failing' as const }
        : account.lastPolledAt === undefined
          ? { notUpdatingReason: 'never_polled' as const }
          : overdue
            ? { notUpdatingReason: 'overdue' as const }
            : {}),
    };
  });

  const liveView = accountsView
    .flatMap((account) => account.channels.filter((c) => c.isLive).map((c) => ({ ...c, accountRef: account })))
    .sort(
      (a, b) =>
        (b.viewers ?? 0) - (a.viewers ?? 0) ||
        a.displayName.localeCompare(b.displayName) ||
        a.key.localeCompare(b.key),
    )
    .map(({ accountRef: _accountRef, ...row }) => row as DashboardChannelView);

  const notUpdatingPlatforms = deps.registry
    .all()
    .map((adapter) => ({
      providerId: adapter.id,
      platformLabel: platformLabel(adapter),
      accounts: accountsView.filter((a) => a.providerId === adapter.id && a.notUpdating),
    }))
    .filter((entry) => entry.accounts.length > 0)
    .map(({ providerId, platformLabel: label }) => ({ providerId, platformLabel: label }));

  return {
    accounts: accountsView,
    live: liveView,
    history,
    hasHistory: history.length > 0,
    ...(() => {
      const times = accountsView.map((a) => a.lastPolledAt).filter((t): t is number => t !== undefined);
      return times.length > 0 ? { lastCheckedAt: Math.max(...times) } : {};
    })(),
    notUpdatingPlatforms,
  };
}

/**
 * The live rows for every account. `liveState` is account-scoped, so the document
 * is read through the repository's own accessor rather than iterating an unknown
 * set of account ids.
 */
async function readAllLive(repository: Repository): Promise<Awaited<ReturnType<Repository['liveState']>>> {
  const state = await repository.read();
  return state.live;
}
