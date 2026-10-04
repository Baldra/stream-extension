import { redact, safeStringify } from './redact';
import type { Repository } from './repository';
import type { ProviderId } from './provider';
import type { WentLiveNotice } from './detection';

/**
 * The browser notification surface, narrowed to what this module uses so the
 * service is testable without `chrome` and the gating rules stay explicit.
 */
export interface NotificationApi {
  /** The browser's own grant state, i.e. `chrome.notifications.getPermissionLevel`. */
  permission(): Promise<'granted' | 'denied' | 'default'>;
  /** Asks the browser to prompt, per the notification spec. */
  requestPermission(): Promise<'granted' | 'denied'>;
  create(notificationId: string, options: NotificationContent): Promise<string | undefined>;
  clear(notificationId: string): Promise<boolean>;
}

export interface NotificationContent {
  title: string;
  message: string;
  iconUrl?: string;
  contextMessage?: string;
}

/** One notification identity per newly-live event, never per poll. */
export type NotificationId = string;

export interface NotificationOutcome {
  raised: boolean;
  reason?: 'no_permission' | 'disabled_for_provider' | 'duplicate' | 'create_failed';
  notificationId?: NotificationId;
  needsPermissionPrompt?: boolean;
}

export interface NotificationServiceDeps {
  repository: Repository;
  api: NotificationApi;
  /** Platform label for the notification subtitle, e.g. "Twitch". */
  platformLabel: (providerId: ProviderId) => string;
}

/**
 * The notification id encodes the *stream*, not the moment it was noticed.
 *
 * `wentLiveAt` identifies one broadcast, so re-observing the same stream always
 * produces the same id, while a channel that goes offline and starts a new stream
 * produces a new one and is notified again.
 */
export const notificationIdFor = (notice: WentLiveNotice): NotificationId =>
  `${notice.providerId}:${notice.accountId}:${notice.channelId}:${notice.wentLiveAt}`;

/**
 * Raised notifications (group 10).
 *
 * Every suppression rule lives here rather than in the detection loop, so there
 * is exactly one place that can decide a newly-live event becomes a notification.
 *
 * Duplicate suppression needs no extra store: the notification is recorded to
 * bounded history, whose entry id is the notification id, and a second attempt
 * for the same stream finds the entry. Recording happens only after the browser
 * accepted the notification, so a failed create is retried rather than lost.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /**
   * Builds the notification content. Only fields the platform actually supplied
   * are included, so a stream with no category reads cleanly instead of showing an
   * empty segment.
   */
  buildContent(notice: WentLiveNotice, category?: string): NotificationContent {
    const platform = this.deps.platformLabel(notice.providerId);
    const parts: string[] = [];
    if (notice.title) parts.push(notice.title);
    if (category) parts.push(category);
    if (parts.length === 0) parts.push('is live');

    return {
      title: `${notice.displayName} is live on ${platform}`,
      message: parts.join(' — '),
      // The click target is the channel page, which exists whether or not the
      // stream is still running.
      contextMessage: platform,
      ...(notice.thumbnailUrl ? { iconUrl: notice.thumbnailUrl } : {}),
    };
  }

  async raise(notice: WentLiveNotice, category?: string): Promise<NotificationOutcome> {
    const notificationId = notificationIdFor(notice);

    // Checked first, and before any permission prompt, so re-observing a stream
    // never nags the user to grant permission.
    if ((await this.deps.repository.history(HISTORY_PROBE_LIMIT)).some((e) => e.entryId === notificationId)) {
      return { raised: false, reason: 'duplicate' };
    }

    if (!(await this.deps.repository.notificationsEnabledFor(notice.providerId))) {
      // Tracking continues; only the notification is withheld.
      return { raised: false, reason: 'disabled_for_provider' };
    }

    const permission = await this.deps.api.permission();
    if (permission !== 'granted') {
      const requested = await this.deps.api.requestPermission();
      if (requested !== 'granted') {
        return { raised: false, reason: 'no_permission', needsPermissionPrompt: permission === 'default' };
      }
    }

    const content = this.buildContent(notice, category);

    // Defence in depth: the content is assembled only from fields that cannot hold
    // a credential, but the payload is scrubbed anyway so that adding a field later
    // cannot leak one into something the user can see.
    const scrubbed = safeStringify(redact(structuredClone(content)));
    const created = await this.deps.api.create(notificationId, JSON.parse(scrubbed) as NotificationContent);
    if (!created) return { raised: false, reason: 'create_failed' };

    await this.deps.repository.addHistoryEntry({
      entryId: notificationId,
      providerId: notice.providerId,
      accountId: notice.accountId,
      channelId: notice.channelId,
      displayName: notice.displayName,
      title: notice.title,
      wentLiveAt: notice.wentLiveAt,
      streamUrl: notice.streamUrl,
    });
    await this.deps.repository.markNotified(notice.providerId, notice.accountId, notice.channelId);

    return { raised: true, notificationId };
  }

  /**
   * Click-through: open the stream, then dismiss (task 10.4).
   *
   * The URL is read back from recorded history, so a notification whose stream has
   * already ended still resolves to the channel's canonical page.
   */
  async handleClick(notificationId: NotificationId): Promise<string | undefined> {
    const entry = (await this.deps.repository.history(HISTORY_PROBE_LIMIT)).find(
      (e) => e.entryId === notificationId,
    );
    if (!entry) return undefined;
    await this.deps.api.clear(notificationId);
    return entry.streamUrl;
  }
}

/**
 * How much history to scan when looking for a duplicate. The repository's own
 * history is already bounded, so a generous probe costs nothing and avoids a
 * false "not a duplicate" from a too-small window.
 */
const HISTORY_PROBE_LIMIT = 1_000;
