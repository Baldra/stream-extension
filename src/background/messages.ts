import { systemClock } from '../core/clock';
import { buildDashboardModel } from '../core/dashboard-model';
import type { LiveDetectionService } from '../core/detection';
import type { ProviderRegistry } from '../core/registry';
import type { Repository } from '../core/repository';
import type { AccountManager } from '../core/accounts';
import type { ChannelTracker } from '../core/tracking';
import type { ProviderId } from '../core/provider';
import type { PopupViewState } from '../popup/controller';
import type { PlatformSummary } from '../popup/view';
import { fetchUnofficialFollows } from '../providers/kick/unofficial-import';
import { UnofficialImportUnavailableError, messageForUnofficialImport } from '../core/unofficial-import';
import type { Clock } from '../core/clock';

/**
 * The worker's half of the popup protocol.
 *
 * The popup cannot touch the repository directly, because the detection engine's
 * decisions live in the worker and a popup context would race it. Every dashboard
 * action therefore arrives here as a message and the popup re-reads the result.
 */

export type DashboardRequest =
  | { kind: 'dashboard-state' }
  | { kind: 'platform-metadata' }
  | { kind: 'connect'; providerId: ProviderId; accountId?: string }
  | { kind: 'disconnect'; providerId: ProviderId; accountId: string }
  | { kind: 'add-channel'; providerId: ProviderId; accountId: string; handle: string }
  | { kind: 'remove-channel'; providerId: ProviderId; accountId: string; channelId: string }
  | { kind: 'import-follows'; providerId: ProviderId; accountId: string }
  | { kind: 'set-notifications'; providerId: ProviderId; enabled: boolean }
  | { kind: 'set-unofficial-import'; enabled: boolean }
  | { kind: 'unofficial-import'; providerId: ProviderId; accountId: string };

export type DashboardResponse = { ok: true } | { ok: false; error: string };

/**
 * The two read requests answer with data rather than the action envelope, so the
 * popup's `load()` can return a view state directly. Keeping them out of
 * `DashboardResponse` is what stops a caller from treating `{ ok: true }` as a
 * successful load.
 */
export type PopupReadResponse = PopupViewState | PlatformSummary[];

export function isPopupReadRequest(
  request: DashboardRequest,
): request is Extract<DashboardRequest, { kind: 'dashboard-state' | 'platform-metadata' }> {
  return request.kind === 'dashboard-state' || request.kind === 'platform-metadata';
}

/** Answers a read request with the data the popup asked for. */
export async function handlePopupReadRequest(
  request: Extract<DashboardRequest, { kind: 'dashboard-state' | 'platform-metadata' }>,
  deps: MessageApiDeps,
): Promise<PopupReadResponse> {
  return request.kind === 'dashboard-state' ? buildPopupViewState(deps) : platformMetadata(deps);
}

export interface MessageApiDeps {
  repository: Repository;
  registry: ProviderRegistry;
  accounts: AccountManager;
  tracker: ChannelTracker;
  detection: LiveDetectionService;
  clock: Clock;
  notificationPermission(): Promise<'granted' | 'denied' | 'default'>;
  /** Grants or drops the optional permissions the unofficial import needs. */
  setUnofficialImportPermissions(enabled: boolean): Promise<boolean>;
  /** The Kick website session cookie, or undefined when access was refused. */
  kickCookie(): Promise<string | undefined>;
  /**
   * Runs the whole authorization flow: opens the provider consent screen, waits for
   * the redirect, and stores the resulting account. Doing it in the worker keeps the
   * popup free of a second OAuth surface, and survives the popup being closed.
   */
  connectAccount(providerId: ProviderId, existingAccountId?: string): Promise<void>;
}

/** The reasons are provider-specific, so the popup only needs to map them to text. */
const ADD_FAILED: Record<string, string> = {
  unknown_handle: 'No channel with that name was found on this platform',
  unsupported: 'This platform does not support adding channels by name',
  auth_required: 'The account needs reconnecting before channels can be added',
};

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong';

/** Platform labels and capabilities as plain data, safe to send over messaging. */
export function platformMetadata(deps: MessageApiDeps): PlatformSummary[] {
  return deps.registry.all().map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    capabilities: { ...adapter.capabilities },
  }));
}

export async function buildPopupViewState(deps: MessageApiDeps): Promise<PopupViewState> {
  const [dashboard, permission, enabled] = await Promise.all([
    buildDashboardModel({ repository: deps.repository, registry: deps.registry, clock: deps.clock }),
    deps.notificationPermission(),
    Promise.all(deps.registry.all().map((adapter) => deps.repository.notificationsEnabledFor(adapter.id))),
  ]);
  const enabledFor = deps.registry
    .all()
    .map((adapter, index) => (enabled[index] ? adapter.id : null))
    .filter((id): id is ProviderId => id !== null);

  return {
    dashboard,
    platforms: platformMetadata(deps),
    unofficialImportEnabled: await deps.repository.unofficialFollowImportEnabled(),
    notificationsGranted: permission === 'granted',
    notificationsEnabledFor: enabledFor,
  };
}

export async function handleDashboardRequest(
  request: DashboardRequest,
  deps: MessageApiDeps,
): Promise<DashboardResponse> {
  try {
    switch (request.kind) {
      // Reading is answered by `handlePopupReadRequest`, which returns data instead
      // of this envelope. Reaching it here would mean the popup rendered a success
      // envelope as a view state, so it fails loudly rather than showing nothing.
      case 'dashboard-state':
      case 'platform-metadata':
        throw new Error(`read request ${request.kind} must be answered with its data`);

      case 'connect': {
        await deps.connectAccount(request.providerId, request.accountId);
        // A new account may have no channels yet, but a reconnected one already has
        // them, so the schedule is re-evaluated either way.
        await deps.detection.syncSchedule();
        break;
      }

      case 'disconnect': {
        await requireAccount(deps, request.providerId, request.accountId);
        await deps.accounts.disconnect(request.providerId, request.accountId);
        // The account's channels stop being polled once it is gone.
        await deps.detection.syncSchedule();
        break;
      }

      case 'add-channel': {
        const account = await requireAccount(deps, request.providerId, request.accountId);
        const result = await deps.tracker.addByHandle(deps.registry.get(request.providerId), account, request.handle);
        if (!result.ok) throw new Error(ADD_FAILED[result.reason]);
        // A newly tracked channel has never been observed, so the schedule has to
        // include its account immediately rather than at the next alarm.
        await deps.detection.syncSchedule();
        break;
      }

      case 'remove-channel': {
        const account = await requireAccount(deps, request.providerId, request.accountId);
        await deps.tracker.remove(account, request.channelId);
        await deps.detection.syncSchedule();
        break;
      }

      case 'import-follows': {
        const account = await requireAccount(deps, request.providerId, request.accountId);
        // The adapter throws when the platform has no official endpoint, which the
        // popup already knows to not offer; a summary otherwise reports the counts.
        await deps.tracker.importFollowed(deps.registry.get(request.providerId), account);
        await deps.detection.syncSchedule();
        break;
      }

      case 'set-notifications': {
        await deps.repository.setNotificationsEnabled(request.providerId, request.enabled);
        break;
      }

      case 'set-unofficial-import': {
        // Turning it on asks for the optional permissions; refusing leaves the
        // opt-in off, so nothing unsupported ever runs.
        const granted = await deps.setUnofficialImportPermissions(request.enabled);
        await deps.repository.setUnofficialFollowImportEnabled(request.enabled && granted);
        break;
      }

      case 'unofficial-import': {
        const account = await requireAccount(deps, request.providerId, request.accountId);
        const adapter = deps.registry.get(request.providerId);
        if (!adapter.capabilities.unofficialFollowImport) {
          throw new Error('This platform needs no unofficial import');
        }
        // The tracker checks the opt-in itself, so no request is made while it is off.
        await deps.tracker.importUnofficial(account, async () => {
          const cookie = await deps.kickCookie();
          return fetchUnofficialFollows(account.accountId, { cookie });
        });
        await deps.detection.syncSchedule();
        break;
      }
    }
    return { ok: true };
  } catch (error) {
    // An unofficial failure always reads as "unavailable, nothing changed", so a
    // user is never told a tracked channel was lost.
    if (error instanceof UnofficialImportUnavailableError) {
      return { ok: false, error: messageForUnofficialImport(error.reason) };
    }
    return { ok: false, error: messageFor(error) };
  }
}

async function requireAccount(
  deps: MessageApiDeps,
  providerId: ProviderId,
  accountId: string,
) {
  const account = await deps.repository.account(providerId, accountId);
  if (!account) throw new Error('That account is no longer connected');
  return account;
}

/**
 * The notification channel the popup subscribes to.
 *
 * Detection writes to `chrome.storage.local`, so the popup can react to the
 * storage event directly; nothing is broadcast from the worker, which keeps the
 * worker free of per-popup bookkeeping and works even if the worker is asleep.
 */
export const DASHBOARD_CHANGE_EVENT = 'stream-notifier:dashboard-changed';

export interface ChromeMessagingLike {
  runtime: {
    onMessage: {
      addListener(
        listener: (
          request: unknown,
          sender: unknown,
          respond: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  };
  storage: {
    onChanged: {
      addListener(listener: (changes: Record<string, unknown>) => void): void;
      removeListener(listener: (changes: Record<string, unknown>) => void): void;
    };
  };
}

export function registerMessageApi(chromeApi: ChromeMessagingLike, deps: MessageApiDeps): void {
  chromeApi.runtime.onMessage.addListener((request, _sender, respond) => {
    if (typeof request !== 'object' || request === null || !('kind' in request)) return undefined;
    if (!isDashboardRequest(request)) return undefined;
    // The response is asynchronous, so the listener must return true to keep the
    // message channel open.
    const answered = isPopupReadRequest(request)
      ? handlePopupReadRequest(request, deps)
      : handleDashboardRequest(request, deps);
    void answered.then(respond, (error: unknown) => {
      // A read that throws still owes the popup a response, or it waits forever.
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });
}

export function isDashboardRequest(value: unknown): value is DashboardRequest {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return false;
  return (
    kind === 'dashboard-state' ||
    kind === 'platform-metadata' ||
    kind === 'connect' ||
    kind === 'disconnect' ||
    kind === 'add-channel' ||
    kind === 'remove-channel' ||
    kind === 'import-follows' ||
    kind === 'set-notifications' ||
    kind === 'set-unofficial-import' ||
    kind === 'unofficial-import'
  );
}
