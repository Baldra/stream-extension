import {
  UnsupportedCapabilityError,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderId,
} from './provider';

export class DuplicateProviderError extends Error {
  constructor(readonly id: ProviderId) {
    super(`a provider with id "${id}" is already registered`);
    this.name = 'DuplicateProviderError';
  }
}

export class UnknownProviderError extends Error {
  constructor(readonly id: ProviderId) {
    super(`no provider with id "${id}" is registered`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * The single place providers are looked up (task 3.2). Registration is
 * append-only and collision-checked so a later import can never silently
 * shadow a working adapter.
 */
export class ProviderRegistry {
  readonly #adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    if (this.#adapters.has(adapter.id)) throw new DuplicateProviderError(adapter.id);
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  /** Re-registers the same id, e.g. after a hot reload in development. */
  replace(adapter: ProviderAdapter): this {
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: ProviderId): ProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new UnknownProviderError(id);
    return adapter;
  }

  has(id: ProviderId): boolean {
    return this.#adapters.has(id);
  }

  get ids(): ProviderId[] {
    return [...this.#adapters.keys()];
  }

  all(): ProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  /**
   * Capability discovery (task 3.3). The UI reads this instead of hardcoding a
   * provider check, so a platform without a followed-channel listing simply
   * reports it as unsupported.
   */
  capabilitiesOf(id: ProviderId): ProviderCapabilities {
    return { ...this.get(id).capabilities };
  }

  /** Providers that support an official followed-channel listing. */
  get supportsFollowedChannels(): ProviderId[] {
    return this.all()
      .filter((adapter) => adapter.capabilities.followedChannels)
      .map((adapter) => adapter.id);
  }

  /**
   * Guard used by callers instead of a `providerId === 'kick'` branch, so an
   * unsupported capability fails as a typed error rather than a silent no-op.
   */
  requireCapability(id: ProviderId, capability: keyof ProviderCapabilities): void {
    const adapter = this.get(id);
    if (!adapter.capabilities[capability]) throw new UnsupportedCapabilityError(id, capability);
  }
}
