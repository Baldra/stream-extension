import { systemClock } from '../core/clock';
import { createPopupController, type PopupApi, type PopupViewState } from './controller';
import { Platforms, renderDashboard, type RenderContext } from './view';
import type { DashboardRequest, DashboardResponse } from '../background/messages';
import { STATE_KEY } from '../core/repository';
import type { ProviderId } from '../core/provider';

/**
 * The popup's browser wiring.
 *
 * All behaviour lives in the controller and the worker; this file only translates
 * DOM events into actions and messages, and messages back into re-renders.
 */

const app = document.querySelector<HTMLElement>('#app');

const notify = (message: string): void => {
  if (!app) return;
  const banner = document.createElement('p');
  banner.className = 'notice notice-error';
  banner.setAttribute('role', 'alert');
  banner.textContent = message;
  app.prepend(banner);
};

const send = async (request: DashboardRequest): Promise<void> => {
  const response = (await chrome.runtime.sendMessage(request)) as DashboardResponse | undefined;
  if (!response) throw new Error('The extension background is not responding');
  if (!response.ok) throw new Error(response.error);
};

const api: PopupApi = {
  async load() {
    const response = (await chrome.runtime.sendMessage({ kind: 'dashboard-state' })) as
      | PopupViewState
      | { ok: false; error: string }
      | undefined;
    if (!response) throw new Error('The extension background is not responding');
    // The read channel answers with a view state, not the action envelope. Checking
    // the shape turns a protocol regression into a readable message instead of a
    // render crash that leaves the popup stuck on "Loading...".
    if ('ok' in response) {
      throw new Error(
        response.ok
          ? 'The background sent a response the popup cannot read. Reload the extension.'
          : response.error,
      );
    }
    if (!response.dashboard || !Array.isArray(response.platforms)) {
      throw new Error('The background sent an incomplete dashboard. Reload the extension.');
    }
    return response;
  },
  connect: async (providerId: ProviderId, accountId) => {
    await send({ kind: 'connect', providerId, ...(accountId ? { accountId } : {}) });
  },
  disconnect: async (providerId, accountId) => {
    await send({ kind: 'disconnect', providerId, accountId });
  },
  addChannel: async (providerId, accountId, handle) => {
    await send({ kind: 'add-channel', providerId, accountId, handle });
  },
  removeChannel: async (providerId, accountId, channelId) => {
    await send({ kind: 'remove-channel', providerId, accountId, channelId });
  },
  importFollows: async (providerId, accountId) => {
    await send({ kind: 'import-follows', providerId, accountId });
  },
  setNotificationsEnabled: async (providerId, enabled) => {
    await send({ kind: 'set-notifications', providerId, enabled });
  },
  setUnofficialImportEnabled: async (enabled) => {
    await send({ kind: 'set-unofficial-import', enabled });
  },
  runUnofficialImport: async (providerId, accountId) => {
    await send({ kind: 'unofficial-import', providerId, accountId });
  },
  subscribe(onChange) {
    // Detection persists to chrome.storage.local, so a storage change is the
    // signal that new results exist. The worker needs no per-popup bookkeeping and
    // this still fires while the worker is asleep.
    const listener = (changes: Record<string, chrome.storage.StorageChange>): void => {
      if (STATE_KEY in changes) onChange();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  },
};

const controller = createPopupController({
  api,
  onError: notify,
  render(state: PopupViewState) {
    if (!app) return;
    const ctx: RenderContext = {
      now: systemClock.now(),
      registry: new Platforms(state.platforms),
      unofficialImportEnabled: state.unofficialImportEnabled,
      notificationsGranted: state.notificationsGranted,
      notificationsEnabledFor: (providerId) => state.notificationsEnabledFor.includes(providerId),
    };
    app.removeAttribute('aria-busy');
    app.innerHTML = renderDashboard(state.dashboard, ctx);
  },
});

app?.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (target) void controller.handleClick(target);
});

app?.addEventListener('submit', (event) => {
  const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>('form[data-action]');
  if (!form) return;
  event.preventDefault();
  void controller.handleSubmit(form);
});

app?.addEventListener('change', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('[data-action]');
  if (target) void controller.handleToggle(target);
});

controller.start();
