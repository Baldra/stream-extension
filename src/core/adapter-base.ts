import { AuthHttpError } from './http';
import {
  AuthError,
  UnsupportedCapabilityError,
  type FollowedChannelPage,
  type PollOutcome,
  type ProviderAccount,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ResolvedChannel,
} from './provider';

/**
 * Shared adapter plumbing (the boundary task 3.1 and 3.4 define).
 *
 * Subclasses implement the two network-facing methods; this base handles the two
 * cross-cutting concerns so no provider can forget them:
 *  - translating a transport-level 401/403 into the contract's {@link AuthError},
 *    so the polling and account layers recognise "needs reconnection" without
 *    knowing which HTTP client produced the failure;
 *  - refusing a capability the adapter does not declare, so a caller gets a typed
 *    error instead of a silent empty result.
 */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly authStrategy: ProviderAdapter['authStrategy'];
  abstract readonly capabilities: ProviderCapabilities;

  abstract publicStreamUrl(channel: { channelId: string; displayName: string; accountId: string }): string;

  /** Implemented by the subclass; may throw {@link AuthHttpError}. */
  protected abstract fetchFollowedPage(
    account: ProviderAccount,
    cursor?: string,
  ): Promise<FollowedChannelPage>;

  /** Implemented by the subclass; may throw {@link AuthHttpError}. */
  protected abstract fetchStatus(account: ProviderAccount, channelIds: string[]): Promise<PollOutcome>;

  /**
   * Implemented by the subclass; may throw {@link AuthHttpError}. Defaults to
   * searching the followed listing, which is all a platform with one can offer.
   */
  protected async lookupChannel(
    _account: ProviderAccount,
    _handle: string,
  ): Promise<ResolvedChannel | undefined> {
    return undefined;
  }

  async listFollowedChannels(account: ProviderAccount, cursor?: string): Promise<FollowedChannelPage> {
    if (!this.capabilities.followedChannels) {
      throw new UnsupportedCapabilityError(this.id, 'followedChannels');
    }
    return this.guardAuth(() => this.fetchFollowedPage(account, cursor));
  }

  async fetchLiveStatus(account: ProviderAccount, channelIds: string[]): Promise<PollOutcome> {
    return this.guardAuth(() => this.fetchStatus(account, channelIds));
  }

  async resolveChannelByHandle(
    account: ProviderAccount,
    handle: string,
  ): Promise<ResolvedChannel | undefined> {
    return this.guardAuth(() => this.lookupChannel(account, handle));
  }

  private async guardAuth<R>(run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AuthHttpError) throw new AuthError(this.id, 'revoked');
      throw error;
    }
  }
}
