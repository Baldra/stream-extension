import type {
  DashboardAccountView,
  DashboardChannelView,
  DashboardViewModel,
} from '../core/dashboard-model';
import type { ProviderCapabilities, ProviderId } from '../core/provider';

/**
 * Platform metadata as plain data.
 *
 * The popup reads it from the worker over `chrome.runtime.sendMessage`, which only
 * carries JSON, so the view depends on this summary rather than on live adapters.
 */
export interface PlatformSummary {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;
}

export class Platforms {
  private readonly byId: Map<ProviderId, PlatformSummary>;
  constructor(platforms: PlatformSummary[]) {
    this.byId = new Map(platforms.map((p) => [p.id, p]));
  }
  get(id: ProviderId): PlatformSummary {
    const found = this.byId.get(id);
    if (!found) throw new Error(`Unknown platform: ${id}`);
    return found;
  }
  all(): PlatformSummary[] {
    return [...this.byId.values()];
  }
}

/**
 * The dashboard is rendered to an HTML string rather than built through the DOM.
 *
 * The markup then holds the whole layout in one readable place and every view rule
 * becomes a plain assertion, without a DOM implementation standing in for the
 * browser. Event wiring is applied afterwards by data-action attributes.
 */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = escapeHtml;

const VIEWERS_FORMAT = new Intl.NumberFormat();

export const formatViewers = (viewers: number | undefined): string | undefined =>
  viewers === undefined ? undefined : VIEWERS_FORMAT.format(viewers);

export const formatTime = (epochMs: number, now: number): string => {
  const delta = Math.max(0, now - epochMs);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

const renderChannelRow = (channel: DashboardChannelView): string => {
  const viewers = formatViewers(channel.viewers);
  const details = [
    channel.title,
    viewers === undefined ? undefined : `${viewers} watching`,
  ].filter((part): part is string => Boolean(part));

  return `
      <li class="channel" data-key="${escapeAttr(channel.key)}" data-live="${String(channel.isLive)}">
        <a class="channel-link" href="${escapeAttr(channel.streamUrl)}" target="_blank" rel="noreferrer noopener">
          <span class="channel-name">${escapeHtml(channel.displayName)}</span>
        </a>
        <span class="channel-platform">${escapeHtml(channel.platformLabel)}</span>
        ${channel.isLive ? '<span class="badge badge-live">Live</span>' : ''}
        ${
          channel.unverified
            ? '<span class="badge badge-stale" title="Live status could not be verified">Not verified</span>'
            : ''
        }
        ${details.length > 0 ? `<span class="channel-detail">${escapeHtml(details.join(' · '))}</span>` : ''}
        <button
          type="button"
          class="channel-remove"
          data-action="remove-channel"
          data-provider="${escapeAttr(channel.providerId)}"
          data-account="${escapeAttr(channel.accountId)}"
          data-channel="${escapeAttr(channel.channelId)}"
        >
          Remove<span class="visually-hidden"> ${escapeHtml(channel.displayName)}</span>
        </button>
      </li>`;
};

export interface RenderContext {
  now: number;
  registry: Platforms;
  /** Whether the optional unofficial follow import has been enabled. */
  unofficialImportEnabled: boolean;
  /** Whether the browser has granted notification permission. */
  notificationsGranted: boolean;
  /** Whether notifications are switched off for that platform. */
  notificationsEnabledFor(providerId: ProviderId): boolean;
}

const renderAccount = (account: DashboardAccountView, ctx: RenderContext): string => {
  const adapter = ctx.registry.get(account.providerId);
  const capabilities = adapter.capabilities;

  const importAction = capabilities.followedChannels
    ? `<button type="button" class="action" data-action="import-follows"
        data-provider="${escapeAttr(account.providerId)}" data-account="${escapeAttr(account.accountId)}">
        Import followed channels
      </button>`
    : '';

  // The unofficial path is only ever offered when the platform has no official
  // endpoint. It is labelled unsupported, and the run control stays disabled until
  // the user has explicitly turned it on.
  const unofficialAction =
    capabilities.followedChannels || !capabilities.unofficialFollowImport
      ? ''
      : `<div class="unofficial">
          <p class="unofficial-note">Unofficial, unsupported: this uses a private endpoint that may break at any time. It is not needed for live detection.</p>
          <label class="toggle">
            <input type="checkbox" data-action="toggle-unofficial-import"
              ${ctx.unofficialImportEnabled ? 'checked' : ''} />
            Enable unofficial follow import${ctx.unofficialImportEnabled ? '' : ' (not enabled)'}
          </label>
          <button type="button" class="action action-unsupported" data-action="unofficial-import"
            data-provider="${escapeAttr(account.providerId)}" data-account="${escapeAttr(account.accountId)}"
            ${ctx.unofficialImportEnabled ? '' : 'disabled'}
            title="Unofficial and unsupported: may break at any time">
            Run unofficial follow import
          </button>
        </div>`;

  const notificationToggle = `<label class="toggle">
        <input type="checkbox" data-action="toggle-notifications"
          data-provider="${escapeAttr(account.providerId)}"
          ${ctx.notificationsEnabledFor(account.providerId) ? 'checked' : ''} />
        Notify for ${escapeHtml(account.platformLabel)}
      </label>`;

  return `
    <li class="account" data-provider="${escapeAttr(account.providerId)}" data-account="${escapeAttr(account.accountId)}">
      <div class="account-head">
        <span class="account-identity">${escapeHtml(account.displayName)}</span>
        <span class="account-platform">${escapeHtml(account.platformLabel)}</span>
        ${
          account.requiresReconnection
            ? '<span class="badge badge-warn">Needs reconnecting</span>'
            : ''
        }
        ${
          account.notUpdating
            ? `<span class="badge badge-stale" data-not-updating="${escapeAttr(
                account.notUpdatingReason ?? 'failing',
              )}">Not updating</span>`
            : ''
        }
      </div>
      <div class="account-meta">
        <span>${account.trackedCount} tracked</span>
        <span>${account.liveCount} live</span>
        ${
          account.lastPolledAt === undefined
            ? '<span>Not checked yet</span>'
            : `<span>Last checked ${escapeHtml(formatTime(account.lastPolledAt, ctx.now))}</span>`
        }
      </div>
      <div class="account-actions">
        ${importAction}
        <form class="add-channel" data-action="add-channel" data-provider="${escapeAttr(
          account.providerId,
        )}" data-account="${escapeAttr(account.accountId)}">
          <label class="visually-hidden" for="handle-${escapeAttr(account.accountId)}">
            Channel name for ${escapeHtml(account.displayName)}
          </label>
          <input id="handle-${escapeAttr(account.accountId)}" name="handle" type="text"
            placeholder="channel name" autocomplete="off" required />
          <button type="submit" class="action">Add channel</button>
        </form>
        ${
          account.requiresReconnection
            ? `<button type="button" class="action" data-action="connect"
                data-provider="${escapeAttr(account.providerId)}" data-account="${escapeAttr(account.accountId)}">
                Reconnect
              </button>`
            : ''
        }
        <button type="button" class="action action-danger" data-action="disconnect"
          data-provider="${escapeAttr(account.providerId)}" data-account="${escapeAttr(account.accountId)}">
          Disconnect
        </button>
        ${notificationToggle}
      </div>
      <ul class="channels">
        ${
          account.channels.length === 0
            ? '<li class="empty">No channels tracked for this account.</li>'
            : account.channels.map(renderChannelRow).join('')
        }
      </ul>
      ${unofficialAction}
    </li>`;
};

export const renderLiveSection = (model: DashboardViewModel, ctx: RenderContext): string => {
  const staleNotice =
    model.notUpdatingPlatforms.length > 0
      ? `<p class="notice notice-stale" role="status">Not currently updating: ${model.notUpdatingPlatforms
          .map((p) => escapeHtml(p.platformLabel))
          .join(', ')}. Live status below may be out of date.</p>`
      : '';

  return `
    <section class="live" aria-labelledby="live-heading">
      <h2 id="live-heading">Live now</h2>
      ${staleNotice}
      ${
        model.live.length === 0
          ? '<p class="empty">No tracked channels are currently live.</p>'
          : `<ul class="live-list">${model.live.map(renderChannelRow).join('')}</ul>`
      }
    </section>`;
};

export const renderAccountsSection = (model: DashboardViewModel, ctx: RenderContext): string => {
  const unsupported = model.accounts.filter((a) => !ctx.registry.get(a.providerId).capabilities.followedChannels);
  const unconnected = ctx.registry
    .all()
    .filter((platform) => !model.accounts.some((a) => a.providerId === platform.id));

  return `
    <section class="accounts" aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Connected accounts</h2>
      ${
        model.accounts.length === 0
          ? '<p class="empty">No accounts connected yet.</p>'
          : `<ul class="account-list">${model.accounts.map((a) => renderAccount(a, ctx)).join('')}</ul>`
      }
      ${
        unconnected.length > 0
          ? `<div class="connect-actions">${unconnected
              .map(
                (platform) => `<button type="button" class="action action-primary" data-action="connect"
                  data-provider="${escapeAttr(platform.id)}">Connect ${escapeHtml(platform.displayName)}</button>`,
              )
              .join('')}</div>`
          : ''
      }
      ${
        unsupported.length > 0 && !ctx.unofficialImportEnabled
          ? `<p class="notice">${unsupported
              .map((a) => escapeHtml(a.platformLabel))
              .join(', ')} has no official followed-channel list, so channels are added by name.</p>`
          : ''
      }
    </section>`;
};

export const renderHistorySection = (model: DashboardViewModel, ctx: RenderContext): string => `
    <section class="history" aria-labelledby="history-heading">
      <h2 id="history-heading">Recent notifications</h2>
      ${
        model.hasHistory
          ? `<ul class="history-list">${model.history
              .map(
                (entry) => `<li class="history-entry">
                  <a href="${escapeAttr(entry.streamUrl)}" target="_blank" rel="noreferrer noopener">
                    ${escapeHtml(entry.displayName)}
                  </a>
                  <span class="history-platform">${escapeHtml(
                    ctx.registry.get(entry.providerId).displayName,
                  )}</span>
                  <span class="history-title">${escapeHtml(entry.title)}</span>
                  <time datetime="${new Date(entry.wentLiveAt).toISOString()}">${escapeHtml(
                    formatTime(entry.wentLiveAt, ctx.now),
                  )}</time>
                </li>`,
              )
              .join('')}</ul>`
          : '<p class="empty">No notifications have been raised yet.</p>'
      }
    </section>`;



export function renderDashboard(model: DashboardViewModel, ctx: RenderContext): string {
  const lastChecked =
    model.lastCheckedAt === undefined
      ? '<span class="last-checked" data-last-checked="">Not checked yet</span>'
      : `<span class="last-checked" data-last-checked="${model.lastCheckedAt}">Last checked ${escapeHtml(
          formatTime(model.lastCheckedAt, ctx.now),
        )}</span>`;

  return `
    <h1>Stream Live Notifier</h1>
    ${
      ctx.notificationsGranted
        ? ''
        : '<p class="notice notice-permission" role="alert">Notifications are blocked. Grant permission to be told when a tracked channel goes live.</p>'
    }
    <p class="status-bar">${lastChecked}</p>
    ${renderLiveSection(model, ctx)}
    ${renderAccountsSection(model, ctx)}
    ${renderHistorySection(model, ctx)}`;
}
