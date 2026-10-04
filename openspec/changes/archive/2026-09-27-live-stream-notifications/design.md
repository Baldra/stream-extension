## Context

See `proposal.md` — Why for motivation. This is a greenfield repository: only OpenSpec planning files exist, so this change creates both the extension and the broker service.

The constraints below are the ones that actually shaped the architecture. Each was verified against primary documentation rather than assumed.

- **Neither platform supports a public OAuth client.** Twitch's token endpoint documents `client_secret` as required and its OIDC metadata advertises only `client_secret_post`. Kick requires `client_secret` on both the authorization-code and client-credentials grants even when PKCE is used. A shipped extension bundle cannot keep a secret, so official-API integration is impossible from the extension alone.
- **Kick publishes no followed-channel endpoint.** It is absent from `api.kick.com/swagger/doc.yaml`; KickDevDocs issue #134 records Kick support confirming the endpoint "is currently unavailable" and planned for the future.
- **Kick's real-time path is webhook-only.** The Kick Events API requires a publicly reachable endpoint, which a browser extension cannot provide.
- **`chrome.alarms` has a 1-minute floor** in current Chrome, and the MV3 service worker is terminated freely, so there is no sub-minute schedule and no reliance on worker longevity.
- **Kick's `Get Channels` response embeds the broadcaster's stream key** (`endpoints.Stream.key`). The extension must strip it.
- **Twitch's `Get Followed Streams` returns the followed-and-live set directly**, so Twitch needs no channel-identifier batching for detection, only follow-list pagination.
- **Kick's `Get Livestreams for Users` accepts up to 100 `user_id` values and works with an app-level token**, so Kick detection batches by stable identifier and needs no user credential.

## Goals / Non-Goals

**Goals:**

- Keep the extension free of client secrets so it can be published and audited as-is.
- Confine every platform quirk to one adapter file, so a third provider touches one new directory.
- Make notification delivery exactly-once with respect to a newly-live event, across worker termination, browser restart, and poll retries.
- Never infer "offline" from a failed request, so a provider blip cannot lose or fabricate a notification.
- Keep the unofficial Kick import fully removable, since it depends on an endpoint Kick can break without notice.

**Non-Goals:**

- Real-time push detection. EventSub (Twitch) and Kick Events (webhook-only) are explicitly deferred; the adapter contract is shaped so a push transport can be added per provider later.
- Firefox support. Chromium-only keeps a single `https://<id>.chromiumapp.org/` redirect URI per provider and one `chrome.*` surface.
- Per-channel mute, notification sounds, and notification preferences beyond a per-provider on/off switch.
- Any server-side user data. The broker relays tokens and nothing else.
- Chat, subscriber, or moderation features.

## Decisions

### 1. One stateless broker serves both providers

The extension performs PKCE and holds the `code_verifier` itself, then POSTs `{code, code_verifier, redirect_uri, provider}` to the broker. The broker injects the client secret, calls the platform's token endpoint, and returns the token response without persisting anything.

- **Alternative — embed the client secret in the extension.** Rejected: the secret is extractable from the shipped bundle, and it would still not cover the app-level token both providers need.
- **Alternative — implicit grant for Twitch, broker only for Kick.** Rejected: two divergent auth stories, no refresh token for Twitch, and implicit is discouraged in current OAuth guidance.
- **Alternative — device-code grant.** Rejected: workable as a public client, but it makes the user transcribe a code for a flow we can complete in one window, purely to avoid using a broker we already need.

The broker is provider-parameterised rather than Kick-specific, which is why the capability is `token-broker` and not `kick-token-broker`. The accept-identity control is worth calling out: the extension is a public client with no secret of its own, so the broker's defence against code injection is (a) requiring the registered extension identity, and (b) validating `redirect_uri` against an allowlist, exactly as the existing Kick OAuth proxies do. The broker is the only place a client secret exists, so it is also the natural home for rotation.

### 2. Polling uniformly at ~60 s for both providers

A single `chrome.alarms` period drives detection for every provider. Twitch uses `GET /helix/streams/followed` (`user:read:follows`, `first` up to 100 with cursor pagination). Kick uses `GET /public/v1/users/livestreams` with up to 100 `user_id` per call, chunked over the tracked set.

- **Alternative — Twitch EventSub WebSocket for instant alerts, polling for Kick.** Rejected for v1: requires Chrome 116+, demands a keepalive ping to hold the service worker open, and Twitch's own forums document PONG and session-loss failures in browsers. Not worth two detection paths. The adapter contract keeps the door open.
- **Alternative — `chrome.identity.getAuthToken`.** Not applicable; it is Google-only.

Twitch's `streams/followed` returns only the live subset, so it is also the single cheapest call for a user with many follows. Its one sharp edge is the 100-item page cap, which the poller must walk with `after` cursors; a partial walk would silently under-report.

### 3. Detect the offline→live transition, never presence

The poller stores a last-known live state per `(accountId, channelKey)` and raises a newly-live event only when a successful query flips it from not-live to live. Presence-only detection would fire a burst for every already-running stream on first sync and re-fire on every worker restart.

A channel with **no** prior state that is found live is recorded without notifying. This is a deliberate v1 behaviour trade: the alternative (notifying on first sight) makes day one unusable for anyone with a large follow list. The cost is that a user who installs the extension seconds before a channel goes live gets no notification for that stream. The trade-off is recorded in the spec so it is a chosen contract, not a surprise.

### 4. Only successful queries mutate state

A failed, rate-limited, or interrupted query leaves the channel's state untouched. This is what makes the poller idempotent: a failed poll cannot clear a live state (no false "offline") and cannot promote an unknown state to live (no false notify). A partially failed poll applies its successful subset and skips the rest.

### 5. Proactive renewal with a per-account lock

Credentials are renewed when within ~15 minutes of expiry, before the query is issued, rather than reacting to a 401 mid-poll — a 401 during a poll is user-visible as a missed notification. Renewal is serialised per account behind an in-memory promise chain so overlapping polls cannot race into concurrent refreshes; Twitch refresh tokens and Kick's sliding-window refresh tokens are not safe to consume twice in parallel.

### 6. Follow-list refresh merges additively

A follow import adds newly-appeared channels and never re-adds ones the user removed in the extension. Users unfollow channels on the site all the time; a destructive refresh would silently resurrect them and generate notifications for streams they chose to stop following. Users prune in one place — the extension.

### 7. The unofficial Kick import is quarantined

It lives behind its own `optional_host_permissions` (`kick.com`) plus `cookies`, so the default install does not request them. Failures degrade to a message and never touch detection. Kick can delete `/api/v2/channels/followed` with no notice; the blast radius is one button, and removal requires no spec change.

### 8. Channel identity is `(providerId, providerChannelId)`

Kick slugs are user-renameable, so slug is stored for display and resolution only. This prevents the rename-collision bug where a renamed channel's old handle is later claimed by a different channel, which would otherwise hijack a tracked entry.

### 9. Secrets are stripped at the parse boundary, not at the sink

Kick's `Get Channels` response embeds the broadcaster's stream key. Descriptors map provider responses into a narrow internal shape and omit `stream.key` entirely, so the secret never enters application state and cannot be reached by a later `JSON.stringify` of stored state or a log line. Defence is at deserialisation rather than at each write site.

## Risks / Trade-offs

- **Chrome's 1-minute `chrome.alarms` floor caps notification latency at ~1–2 min.** Accepted: it is the browser's reliable floor, and a longer-lived socket is only "faster" by burning battery and risking worker termination mid-flight. Detection is a repeated poll, not a persisted connection, so an unlucky termination costs one cycle, not correctness.
- **Kick's undocumented follow endpoint can break with no notice.** Mitigated by the quarantine in decision 7 — it is optional, off by default, and failing it is a message rather than a regression. Kick may also publish a real followed-channel endpoint, in which case the manual path simply becomes the fallback.
- **The broker is a single point of failure for new connections.** Mitigated by keeping it stateless and free of user data, so it can be redeployed at any time with no user impact, and by having it issue app-level tokens for anonymous live polling so existing connections keep working while it is down. Residual: it cannot be entirely optional, because both providers require a secret. This is the main operational cost of the official-APIs-only constraint.
- **Twitch `streams/followed` 100-item page cap.** Mitigated by cursor pagination in the poller, with a test asserting a >100-follow account is fully covered.
- **Kick publishes no documented rate limits.** Mitigated by exponential backoff on 429 and 5xx with a visible error state; the real limits get learned in practice.
- **Notification latency claims must stay honest.** The dashboard shows last-checked time so a stale view is not read as current, and specs forbid promising a delay tighter than the poll interval.
- **`stream.key` leakage.** Mitigated at the parse boundary per decision 9, plus a test asserting the stored state serialises without it.

## Migration Plan

Not a migration — nothing exists yet. Deployment order:

1. Deploy the broker with provider secrets and the redirect-URI allowlist configured; register the extension's `https://<id>.chromiumapp.org/` redirect URI in both developer consoles first, since OAuth fails closed otherwise.
2. Ship the extension with the Twitch provider, validate end-to-end, then add Kick.
3. Roll back by disabling or redeploying the broker; no user data is stranded because the extension holds all state locally. Client-secret rotation is a broker-only redeploy.

## Open Questions

- Whether Kick's `AppAccessToken` is subject to tighter rate limits than the user token, discovered in production rather than by test.
- Exact `chrome.alarms` minimum on the oldest Chrome version we intend to support, to confirm 1 minute is a safe floor rather than an assumption.
