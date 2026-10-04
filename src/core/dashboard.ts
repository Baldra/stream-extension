import type { LiveChannelInfo, ProviderId } from './provider';

export interface DashboardChannelRow {
  /** Composite key: a provider id alone is not unique across providers. */
  key: string;
  providerId: ProviderId;
  accountId: string;
  channelId: string;
  displayName: string;
  isLive: boolean;
  title?: string;
  viewers?: number;
  startedAt?: number;
  streamUrl: string;
}

export interface DashboardAccountRow {
  providerId: ProviderId;
  accountId: string;
  displayName: string;
  /** True when renewal permanently failed and the account needs reconnection. */
  requiresReconnection: boolean;
  trackedCount: number;
  liveCount: number;
}

export interface DashboardModel {
  accounts: DashboardAccountRow[];
  /** Sorted live-first, then by viewers descending, then by name for stability. */
  liveChannels: DashboardChannelRow[];
  error?: string;
}

export interface DashboardChannelInput {
  accountId: string;
  channelId: string;
  displayName: string;
  isLive: boolean;
  info?: LiveChannelInfo;
}

export interface BuildDashboardInput {
  providerId: ProviderId;
  accounts: Array<{ accountId: string; displayName: string; requiresReconnection: boolean }>;
  channels: DashboardChannelInput[];
  streamUrlFor: (providerId: ProviderId, channelId: string, displayName: string) => string;
  error?: string;
}

export const dashboardChannelKey = (providerId: ProviderId, accountId: string, channelId: string): string =>
  `${providerId}:${accountId}:${channelId}`;

export function buildDashboard(input: BuildDashboardInput): DashboardModel {
  const liveChannels: DashboardChannelRow[] = [];

  for (const channel of input.channels) {
    if (!channel.isLive || !channel.info) continue;
    liveChannels.push({
      key: dashboardChannelKey(input.providerId, channel.accountId, channel.channelId),
      providerId: input.providerId,
      accountId: channel.accountId,
      channelId: channel.channelId,
      displayName: channel.displayName,
      isLive: true,
      title: channel.info.title,
      viewers: channel.info.viewers,
      startedAt: channel.info.startedAt,
      streamUrl: input.streamUrlFor(input.providerId, channel.channelId, channel.displayName),
    });
  }

  liveChannels.sort(
    (a, b) =>
      (b.viewers ?? 0) - (a.viewers ?? 0) ||
      a.displayName.localeCompare(b.displayName) ||
      a.key.localeCompare(b.key),
  );

  const accounts = input.accounts.map((account) => {
    const rows = input.channels.filter((c) => c.accountId === account.accountId);
    return {
      providerId: input.providerId,
      accountId: account.accountId,
      displayName: account.displayName,
      requiresReconnection: account.requiresReconnection,
      trackedCount: rows.length,
      liveCount: rows.filter((c) => c.isLive).length,
    };
  });

  return { accounts, liveChannels, ...(input.error ? { error: input.error } : {}) };
}
