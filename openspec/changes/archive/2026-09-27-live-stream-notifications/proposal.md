## Why

Streamers you follow go live at unpredictable hours across many platforms, and nothing tells you about all of them at once. Today that means keeping Twitch and Kick tabs open and watching them manually, so most launches are missed. A browser extension that quietly tracks which followed channels are live removes that manual watch entirely, and both platforms now publish documented APIs for follow lists and live status, so this can be built against official integrations rather than scrapes.

## What Changes

- Add a Chromium (Manifest V3) browser extension that connects the user's own Twitch and Kick accounts, maintains a set of tracked channels per connected account, polls those channels for live status roughly once a minute, and raises a browser notification the moment a tracked channel goes live.
- Introduce a **provider adapter contract** as the single integration surface for a streaming platform, so a third provider can be added later without touching authentication, polling, notification, or UI code.
- **Twitch**: connect through the official OAuth authorization-code flow and read the follow list from the official `Get Followed Channels` endpoint (`user:read:follows`). Detect live status from the official `Get Followed Streams` endpoint, which already returns exactly the followed channels that are live.
- **Kick**: connect through the official Kick OAuth authorization-code flow with PKCE, and read live status from the official `Get Livestreams for Users` endpoint. Kick publishes **no** endpoint for a user's follow list, so Kick channels are tracked by manual slug entry, with an optional, clearly-labelled "import my follows" action that uses Kick's undocumented website API and can be disabled independently.
- Add a small **stateless token-broker service** that holds the Twitch and Kick client secrets and performs authorization-code and app-token exchanges on behalf of the extension. Both platforms require a client secret on their token endpoints and publish no public-client grant, so this is what makes official-API-only integration possible from a browser at all.
- Add an in-extension popup dashboard showing which tracked channels are live right now, plus a rolling history of past notifications.
- Add local-only persistence for connected accounts, tokens, tracked channels, last-known live state, and notification history. The broker is stateless and only relays tokens; no user data is stored server-side.

### Platform constraints driving this design

- Kick's OAuth token endpoint requires `client_secret` even with PKCE, and Kick offers no public-client grant. Its `AppAccessToken` (client-credentials) flow also requires the secret, so even anonymous live-status polling needs the broker.
- Twitch's token endpoint documents `client_secret` as required and advertises only `client_secret_post` token-endpoint authentication, so Twitch uses the same broker rather than a second, divergent auth story.
- Kick's real-time Events API is webhook-only, which needs a publicly reachable endpoint and therefore cannot be used from a browser extension. Both providers are polled uniformly.
- Kick's `Get Channels` response embeds the broadcaster's stream key. The extension must never persist or log it.
- Chrome raised the `chrome.alarms` minimum period to 1 minute, so a ~60-second poll is the fastest reliable cadence.

## Capabilities

### New Capabilities

- `provider-registry`: The provider adapter contract and the rules for registering a streaming platform, so Twitch and Kick share one integration surface and a future provider is an isolated addition.
- `account-auth`: Connecting, authenticating, refreshing tokens, and disconnecting the user's own Twitch and Kick accounts, including the authorization-code flow and the extension's interaction with the token broker.
- `token-broker`: The stateless backend service that performs provider token exchanges so client secrets never ship inside the extension.
- `channel-tracking`: The set of channels monitored per connected account — how it is populated (Twitch follow import, Kick manual entry, optional Kick follow import), how entries are added and removed, and how channels are identified and deduplicated.
- `live-detection`: The periodic polling loop, provider live-status querying, diffing against last-known state to identify a stream that just started, and behaviour under service-worker restarts, rate limits, and API errors.
- `notifications`: Raising a browser notification when a tracked channel starts a new stream, what it contains, how it is de-duplicated, and what happens when it is clicked.
- `live-dashboard`: The extension popup that shows currently live channels and recent notification history.

### Modified Capabilities

None. This is the first change in the project; there are no existing specs.

## Impact

- **New project**: this repository currently contains only OpenSpec planning files, so the change introduces the extension from scratch — build tooling, manifest, TypeScript sources, and tests — plus a separate deployable broker service.
- **New deployable unit**: the token broker must be hosted on a public HTTPS origin, configured with the Twitch and Kick client secrets, and kept stateless. Both providers' developer apps must register the extension's `https://<extension-id>.chromiumapp.org/` redirect URI.
- **External dependencies**: Twitch Helix API, Kick Developer Public API, Kick's undocumented website follow endpoint (optional feature only), and a `chrome.*` API surface requiring Manifest V3 on Chrome 116 or newer.
- **Permissions and privacy**: the extension needs host permissions for `id.twitch.tv`, `api.twitch.tv`, `id.kick.com`, `api.kick.com`, the broker origin, and — for the optional import only — `kick.com`, plus `cookies` for that import and `storage`, `alarms`, `notifications`, and `identity`. Credentials stay in the local browser profile. The unofficial Kick import is isolated so it can be disabled or removed without affecting anything else.
- **Operational**: provider rate limits, OAuth redirect-URI registration, and client-secret rotation are ongoing maintenance concerns for the broker.
