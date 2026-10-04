import type { DashboardViewModel } from '../core/dashboard-model';
import type { PlatformSummary } from './view';
import type { ProviderId } from '../core/provider';

/**
 * The popup talks to the worker through this interface instead of the Chrome API
 * directly, so the behaviour of every dashboard action is testable without a
 * browser. The message protocol is implemented in `src/background/messages.ts`.
 */
export interface PopupViewState {
  dashboard: DashboardViewModel;
  /** Static platform labels and capabilities, sent alongside the dashboard. */
  platforms: PlatformSummary[];
  unofficialImportEnabled: boolean;
  notificationsGranted: boolean;
  notificationsEnabledFor: ProviderId[];
}

export interface PopupApi {
  /** Reads the latest detection results; never triggers a poll. */
  load(): Promise<PopupViewState>;
  connect(providerId: ProviderId, accountId?: string): Promise<void>;
  disconnect(providerId: ProviderId, accountId: string): Promise<void>;
  addChannel(providerId: ProviderId, accountId: string, handle: string): Promise<void>;
  removeChannel(providerId: ProviderId, accountId: string, channelId: string): Promise<void>;
  importFollows(providerId: ProviderId, accountId: string): Promise<void>;
  setNotificationsEnabled(providerId: ProviderId, enabled: boolean): Promise<void>;
  /**
   * Turns the unsupported import on or off. Enabling asks for the optional
   * permissions, and a refusal leaves it off.
   */
  setUnofficialImportEnabled(enabled: boolean): Promise<void>;
  runUnofficialImport(providerId: ProviderId, accountId: string): Promise<void>;
  /** Notifies when detection or another context changes persisted state. */
  subscribe(onChange: () => void): () => void;
}

export type PopupAction =
  | { kind: 'connect'; providerId: ProviderId; accountId?: string }
  | { kind: 'disconnect'; providerId: ProviderId; accountId: string }
  | { kind: 'add-channel'; providerId: ProviderId; accountId: string; handle: string }
  | { kind: 'remove-channel'; providerId: ProviderId; accountId: string; channelId: string }
  | { kind: 'import-follows'; providerId: ProviderId; accountId: string }
  | { kind: 'toggle-notifications'; providerId: ProviderId; enabled: boolean }
  | { kind: 'unofficial-import'; providerId: ProviderId; accountId: string }
  | { kind: 'toggle-unofficial-import'; enabled: boolean };

/** The subset of a DOM element the dispatcher needs. */
export interface ActionElement {
  dataset: { [key: string]: string | undefined };
  closest?: (selector: string) => ActionElement | null;
  querySelector?: (selector: string) => ActionElement | null;
  value?: string;
  checked?: boolean;
}

/** Adapts a real element to the structural shape the dispatcher works with. */
const asActionElement = (element: unknown): ActionElement =>
  element as unknown as ActionElement;

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/**
 * Translates a rendered control into an action. Returns null for anything that is
 * not one of the dashboard's own controls, so a stray click elsewhere in the page
 * is ignored rather than dispatched.
 */
export function parseAction(element: ActionElement): PopupAction | null {
  const kind = element.dataset.action;
  if (!kind) return null;

  // The unofficial-import opt-in is extension-wide rather than per platform, so
  // it carries no provider id.
  if (kind === 'toggle-unofficial-import') {
    return { kind: 'toggle-unofficial-import', enabled: element.checked === true };
  }

  const providerId = element.dataset.provider as ProviderId | undefined;
  if (!providerId) return null;

  switch (kind) {
    case 'connect':
      return {
        kind: 'connect',
        providerId,
        ...(element.dataset.account ? { accountId: element.dataset.account } : {}),
      };
    case 'disconnect':
      return { kind: 'disconnect', providerId, accountId: required(element.dataset.account, 'account') };
    case 'remove-channel':
      return {
        kind: 'remove-channel',
        providerId,
        accountId: required(element.dataset.account, 'account'),
        channelId: required(element.dataset.channel, 'channel'),
      };
    case 'import-follows':
      return {
        kind: 'import-follows',
        providerId,
        accountId: required(element.dataset.account, 'account'),
      };
    case 'unofficial-import':
      return {
        kind: 'unofficial-import',
        providerId,
        accountId: required(element.dataset.account, 'account'),
      };
    case 'toggle-notifications':
      return { kind: 'toggle-notifications', providerId, enabled: element.checked === true };
    case 'add-channel': {
      // The form carries the provider and account; the handle is the input's value.
      const input = element.closest
        ? asActionElement(element.closest('[data-action="add-channel"]'))
        : element;
      const handle = trimmed(input.value);
      if (handle === '') return null;
      return {
        kind: 'add-channel',
        providerId,
        accountId: required(element.dataset.account, 'account'),
        handle,
      };
    }
    default:
      return null;
  }
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what} for dashboard action`);
  return value;
}

export interface PopupController {
  refresh(): Promise<void>;
  dispatch(action: PopupAction): Promise<void>;
  handleClick(element: ActionElement): Promise<void>;
  handleSubmit(form: ActionElement): Promise<void>;
  handleToggle(element: ActionElement): Promise<void>;
  /** Re-renders when another context changes state, and stops listening. */
  start(): () => void;
}

export interface ControllerDeps {
  api: PopupApi;
  render: (state: PopupViewState) => void;
  /** Renders a transient error; defaults to nothing, keeping failures silent. */
  onError?: (message: string) => void;
  notify?: (message: string) => void;
}

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong';

export function createPopupController(deps: ControllerDeps): PopupController {
  /** Actions are serialised so a second click cannot race the first. */
  let queue: Promise<void> = Promise.resolve();

  const refresh = async (): Promise<void> => {
    // A failed read must be reported, not swallowed: `start()` and the storage
    // listener both discard this promise, so an unhandled rejection here would
    // leave the popup showing its initial "Loading..." with no explanation.
    try {
      const state = await deps.api.load();
      deps.render(state);
    } catch (error) {
      deps.onError?.(messageFor(error));
    }
  };

  const perform = async (action: PopupAction): Promise<void> => {
    try {
      switch (action.kind) {
        case 'connect':
          await deps.api.connect(action.providerId, action.accountId);
          break;
        case 'disconnect':
          await deps.api.disconnect(action.providerId, action.accountId);
          break;
        case 'add-channel':
          await deps.api.addChannel(action.providerId, action.accountId, action.handle);
          break;
        case 'remove-channel':
          await deps.api.removeChannel(action.providerId, action.accountId, action.channelId);
          break;
        case 'import-follows':
          await deps.api.importFollows(action.providerId, action.accountId);
          break;
        case 'toggle-notifications':
          await deps.api.setNotificationsEnabled(action.providerId, action.enabled);
          break;
        case 'unofficial-import':
          await deps.api.runUnofficialImport(action.providerId, action.accountId);
          break;
        case 'toggle-unofficial-import':
          await deps.api.setUnofficialImportEnabled(action.enabled);
          break;
      }
      await refresh();
    } catch (error) {
      deps.onError?.(messageFor(error));
    }
  };

  const dispatch = (action: PopupAction): Promise<void> => {
    queue = queue.then(() => perform(action));
    return queue;
  };

  return {
    refresh,
    dispatch,
    async handleClick(element) {
      const action = parseAction(element);
      if (action) await dispatch(action);
    },
    async handleSubmit(form) {
      if (form.dataset.action !== 'add-channel') return;
      const input = form.querySelector
        ? asActionElement(form.querySelector('[name="handle"]'))
        : form;
      const handle = trimmed(input.value);
      if (handle === '') return;
      await dispatch({
        kind: 'add-channel',
        providerId: form.dataset.provider as ProviderId,
        accountId: required(form.dataset.account, 'account'),
        handle,
      });
      // Clearing the field keeps a re-render from submitting the same handle twice.
      input.value = '';
    },
    async handleToggle(element) {
      const action = parseAction(element);
      if (action?.kind === 'toggle-notifications' || action?.kind === 'toggle-unofficial-import') {
        await dispatch(action);
      }
    },
    start() {
      void refresh();
      return deps.api.subscribe(() => void refresh());
    },
  };
}
