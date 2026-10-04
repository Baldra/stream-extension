## 1. Project Scaffolding

- [x] 1.1 Initialize the repository as a TypeScript project with a build, typecheck, and test script; verify by running each script successfully
- [x] 1.2 Choose and configure a Manifest V3 bundler for the extension and the shared provider/core code; verify a build emits a loadable unpacked extension
- [x] 1.3 Confirm the minimum `chrome.alarms` period on the oldest Chrome version targeted, and pin the poll period to a single exported constant; verify by an assertion test on the constant (resolves design Open Question 2)
- [x] 1.4 Add a redaction helper that strips credential-shaped fields from any value before it is logged or serialized, and verify by unit test that a nested token and client secret are removed
- [x] 1.5 Add a time source and a scheduler abstraction so polling and notification timing are deterministic under test; verify by unit test that injected time drives the schedule

## 2. Token Broker Service

- [x] 2.1 Scaffold the broker as a separate deployable service with config loaded from environment variables and a health endpoint; verify by starting it locally and asserting the health endpoint responds
- [x] 2.2 Implement the provider-parameterized authorization-code exchange operation, injecting the client secret server-side and forwarding only platform-required parameters; verify by unit test against a stubbed platform token endpoint
- [x] 2.3 Implement the client-credentials operation for application-level tokens, held in transient memory only; verify by unit test that no credential is written to any persistent store or log sink
- [x] 2.4 Enforce the registered-extension-identity check and the `redirect_uri` allowlist, rejecting requests that fail either; verify by unit test that an unregistered caller and a non-allowlisted redirect URI are both rejected before any platform call is attempted
- [x] 2.5 Make failure responses identify the platform and failure class without echoing submitted codes or tokens; verify by unit test asserting no submitted value appears in the response
- [x] 2.6 Assert the broker holds no state across calls and is unaffected by restart; verify by test that a restarted instance needs no migration and rejects no valid request

## 3. Provider Registry and Core Contracts

- [x] 3.1 Define the provider adapter contract types for provider identity, auth strategy, channel resolution, live-status retrieval, and public stream URL; verify by typecheck and by a compile-time conformance check
- [x] 3.2 Implement the provider registry with unique-identifier enforcement; verify by unit test that a duplicate identifier is rejected and the original remains usable
- [x] 3.3 Implement capability discovery so the UI can query per-provider optional capabilities; verify by unit test that a provider without followed-channel listing reports it as unsupported
- [x] 3.4 Prove the boundary by writing a test provider and asserting polling, notification, and dashboard logic run against it with no platform-specific branching; verify by running the shared-behaviour test suite against the fake provider

## 4. Storage Layer

- [x] 4.1 Define the persisted state model for accounts, tokens, tracked channels, per-account last-known live state, and notification history; verify by unit test round-tripping the model through storage
- [x] 4.2 Implement repository accessors keyed by provider and account, enforcing that a channel belongs to exactly one account; verify by unit test that state for two accounts stays independent
- [x] 4.3 Implement bounded notification history that discards oldest entries past the configured limit; verify by unit test at the limit boundary
- [x] 4.4 Implement a per-key write lock so concurrent operations against one account serialize; verify by unit test that N concurrent calls produce exactly one underlying mutation
- [x] 4.5 Verify the redaction guarantee end to end for persisted state, using Kick's stream-key-bearing response shape as the fixture; verify by asserting the serialized state contains no stream key

## 5. Account Authentication

- [x] 5.1 Implement the authorization-request builder using each provider's official authorization endpoint with minimal scopes; verify by unit test asserting the requested scope sets are exactly those the specs permit
- [x] 5.2 Implement the OAuth web-auth flow driver with fresh per-attempt state binding; verify by unit test that a mismatched or absent state is discarded with no account connected
- [x] 5.3 Implement PKCE generation and verifier retention in the extension, with the code verifier sent to the broker; verify by unit test asserting the extension never transmits a client secret
- [x] 5.4 Implement token storage and the pre-expiry renewal window, serialising renewal per account; verify by unit test that overlapping renewals collapse into one
- [x] 5.5 Implement the requiring-reconnection state and the associated user-visible signal; verify by unit test that a permanent renewal failure stops queries for that account
- [x] 5.6 Implement disconnect, including credential revocation or discard and removal of that account's channels and live state; verify by unit test that a sibling account is unaffected
- [x] 5.7 Verify multi-account isolation for the same provider; verify by unit test covering two accounts with overlapping channel sets

## 6. Channel Tracking

- [x] 6.1 Implement channel identity as `(providerId, providerChannelId)` with handle stored for display only; verify by unit test covering rename and rename-then-handle-reuse
- [x] 6.2 Implement manual add-by-handle with platform validation and stable-identifier resolution; verify by unit test covering success, unknown handle, and idempotent re-add
- [x] 6.3 Implement removal, clearing that channel's tracked and live state; verify by unit test that removing an untracked channel succeeds without error
- [x] 6.4 Implement additive-only follow-import merge preserving locally removed channels; verify by unit test covering a channel removed locally while still followed upstream
- [x] 6.5 Implement follow-import pagination for providers that page; verify by unit test asserting a tracked set exceeding one page is fully imported

## 7. Twitch Provider Adapter

- [x] 7.1 Implement Twitch auth strategy using the broker-backed authorization-code flow; verify by unit test against stubbed Twitch endpoints
- [x] 7.2 Implement followed-channel listing from the official followed-channels endpoint, fully paged; verify by unit test with a fixture requiring more than one page
- [x] 7.3 Implement live-status retrieval from the official followed-streams endpoint, with cursor pagination past the 100-item page cap; verify by unit test asserting an account with more than 100 live followed channels is fully covered
- [x] 7.4 Implement the public stream URL and stream metadata mapping, with any credential-bearing field excluded from the mapped shape; verify by unit test

## 8. Kick Provider Adapter

- [x] 8.1 Implement Kick auth strategy using the authorization-code flow with PKCE via the broker; verify by unit test against stubbed Kick endpoints
- [x] 8.2 Implement slug-to-identifier resolution via the official channels endpoint, chunked to its documented per-request limit; verify by unit test covering chunk boundaries
- [x] 8.3 Implement live-status retrieval from the official livestreams-for-users endpoint, chunked at 100 identifiers per request; verify by unit test covering a tracked set exceeding 100 channels
- [x] 8.4 Ensure the channels response is mapped so the embedded stream key never enters application state; verify by unit test asserting it is absent from the mapped object and from serialized state
- [x] 8.5 Report the platform as not supporting official followed-channel listing; verify by unit test asserting the capability query returns unsupported

## 9. Live Detection

- [x] 9.1 Implement the poll loop on the pinned alarm period, with scheduling suspended when no tracked channels exist and resumed when one is added; verify by test using an injected scheduler
- [x] 9.2 Implement fan-out across all providers and accounts with per-provider batching within documented limits; verify by test asserting request counts and batch sizes for a multi-account, multi-provider tracked set
- [x] 9.3 Implement transition detection raising a newly-live event only on a not-live to live flip, and recording without notifying a channel found live with no prior state; verify by unit test covering both cases
- [x] 9.4 Implement idempotence across repeated polls and worker restarts, proving no event is re-raised for a channel already recorded live; verify by unit test that restarts do not re-fire
- [x] 9.5 Implement that only successful queries mutate live state, and that partial poll failures apply the successful subset while leaving the rest untouched; verify by unit test asserting no event on failure and no false offline
- [x] 9.6 Implement backoff on rate-limit and server errors with increasing cooling-off intervals, plus a visible ongoing-failure signal; verify by unit test asserting interval growth and no requests during cooling-off
- [x] 9.7 Integrate proactive credential renewal ahead of each account's queries; verify by unit test asserting renewal precedes the query and that a failing poll never surfaces as a credential error

## 10. Notifications

- [x] 10.1 Implement notification emission for newly-live events, including channel, platform, stream title, category, and thumbnail when supplied; verify by unit test with and without optional fields
- [x] 10.2 Implement duplicate suppression per newly-live event, including across worker restart; verify by unit test asserting exactly one notification per event
- [x] 10.3 Assert notifications and their content contain no credentials; verify by unit test over the rendered payload
- [x] 10.4 Implement click-through to the channel's canonical public stream URL in a new tab, with dismissal, including the case where the channel went offline; verify by unit test asserting the opened URL
- [x] 10.5 Implement notification-permission gating, prompting when not granted while continuing to track; verify by unit test that tracking continues and no notification is raised
- [x] 10.6 Implement the per-provider notification on/off switch, with no retroactive catch-up on re-enable; verify by unit test for both directions
- [x] 10.7 Record each raised notification to bounded local history; verify by unit test that the entry is retrievable and bounded

## 11. Live Dashboard

- [x] 11.1 Implement the single live-channel list across all providers and accounts, with per-entry platform and owning-account identity; verify by component test
- [x] 11.2 Implement the empty and not-currently-updating states, including the stale-state case where queries are failing; verify by component test that unverified state is not shown as current
- [x] 11.3 Implement the connected-accounts list with connect and disconnect actions, marking accounts requiring reconnection; verify by component test
- [x] 11.4 Implement per-account channel management scoped to that account, with import, add-by-handle, and remove actions; verify by component test that actions for one account do not affect another
- [x] 11.5 Ensure unsupported follow-import is absent and any unofficial import is labelled unsupported and inactive until explicitly enabled; verify by component test
- [x] 11.6 Implement the recent-notification history view including the no-notifications-yet state; verify by component test
- [x] 11.7 Implement live updates to an open dashboard without user reload, and display of last-checked time; verify by component test asserting the view changes on a new detection result

## 12. Unofficial Kick Follow Import (Optional)

- [x] 12.1 Place the unofficial import behind optional host and cookie permissions that are not requested by default; verify by manifest test asserting the permissions are optional and absent from the default grant
- [x] 12.2 Implement the import request against Kick's undocumented followed-channel endpoint, guarded by an explicit user enablement; verify by unit test that no request is made while disabled
- [x] 12.3 Implement fail-soft handling for errors and unrecognized responses, leaving the tracked set unchanged and surfacing an unavailable message; verify by unit test that detection and notifications are unaffected
- [x] 12.4 Implement disabling the import without removing already-tracked channels; verify by unit test

## 13. Packaging and Verification

- [x] 13.1 Write the extension manifest with required permissions, optional permissions for the unofficial import, host permissions, and the minimum Chrome version; verify by loading the built extension unpacked and confirming it registers no service-worker errors
- [ ] 13.2 Register the extension's `https://<extension-id>.chromiumapp.org/` redirect URI in both developer consoles and document the client-ids and broker configuration; verify by completing a real connect for each provider
- [x] 13.3 Write an end-to-end test that connects a provider, adds a channel, detects it going live, raises exactly one notification, and dismisses it from history; verify by running the suite green
- [x] 13.4 Write an end-to-end test covering worker termination and browser restart without duplicate or lost notifications; verify by running the suite green
- [x] 13.5 Document setup, broker deployment, secret rotation, and how to add a new provider against the adapter contract; verify by a reviewer following the guide to register a provider successfully
