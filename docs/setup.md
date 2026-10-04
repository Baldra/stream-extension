# Setup and operations guide

How to build, configure, deploy and extend this extension and its token broker.

## Contents

- [How it fits together](#how-it-fits-together)
- [Build and test](#build-and-test)
- [Local development](#local-development)
- [Deploy the token broker](#deploy-the-token-broker)
- [Register the OAuth redirect URI](#register-the-oauth-redirect-uri)
- [Load the extension unpacked](#load-the-extension-unpacked)
- [Permissions, and what is deliberately optional](#permissions-and-what-is-deliberately-optional)
- [Rotate a secret](#rotate-a-secret)
- [Add a provider](#add-a-provider)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)

## How it fits together

The extension never holds a client secret. Authorization codes are exchanged by a
small separate service, the **broker**, which is the only component with access to
secrets. The extension talks to the broker over `fetch` and the broker calls Twitch
and Kick on the extension's behalf.

```
extension popup  ──▶  service worker  ──▶  broker  ──▶  Twitch / Kick
     (views)          (poll + notify)     (secrets)
                          │
                          └──▶ chrome.storage.local, chrome.alarms
```

Everything durable lives in `chrome.storage.local`, so the MV3 service worker can be
terminated at any time and pick up where it left off.

## Build and test

```sh
npm install
npm run verify     # typecheck, unit + end-to-end tests, extension build, broker build
npm run dev        # rebuild the extension on change
```

Outputs:

| Path                | Contents                                    |
| ------------------- | ------------------------------------------- |
| `dist/`             | the unpacked extension                      |
| `broker/dist/`      | the broker, ready to `node`                 |

Node 20 or newer is expected.

## Local development

Two `.env` files hold configuration, and both have a committed template. Node does
not read `.env` files on its own, so the npm scripts pass `--env-file-if-exists`;
you do not need to export anything yourself.

```sh
cp broker/.env.example broker/.env   # secrets, port, and which extension may call
cp .env.example .env                 # where the extension should find the broker
```

Fill in `broker/.env`:

```sh
TWITCH_CLIENT_ID=<from the Twitch developer console>
TWITCH_CLIENT_SECRET=<from the Twitch developer console>
KICK_CLIENT_ID=<from the Kick developer console>
KICK_CLIENT_SECRET=<from the Kick developer console>
ALLOWED_ORIGINS=chrome-extension://<extension-id>
ALLOWED_REDIRECT_URIS=https://<extension-id>.chromiumapp.org/
PORT=8787
```

Then, in another terminal:

```sh
npm run broker:build   # builds the broker and starts it on :8787
npm run build          # builds the extension, reading both .env files
```

Then load `dist/` unpacked and complete a connect, which registers your real
extension id. Copy that id back into `broker/.env` and rebuild the broker.

Three things to get right, in the order they bite:

1. **`ALLOWED_ORIGINS` is the caller's origin, not the broker's address.** It is
   compared against the CORS `Origin` header, which the extension sets to
   `chrome-extension://<extension-id>`. `http://localhost:8787` in this field will
   reject every call.
2. **`ALLOWED_REDIRECT_URIS` has no path.** The worker calls
   `chrome.identity.getRedirectURL('')`, so the value it sends is the origin with a
   trailing slash and nothing after it. A trailing `/oauth` makes every exchange
   fail with `redirect_uri_not_allowed`.
3. **The client ids must match the broker's.** The extension carries its own copy,
   compiled in at build time, and a mismatch fails the exchange upstream with an
   opaque error. `npm run build` reads `broker/.env` as well as `.env`, so leaving
   the ids out of `.env` keeps the two files from drifting apart.

If you prefer to run the broker by hand, `--env-file` is all it needs:

```sh
node --env-file=broker/.env broker/dist/server.js
```

## Deploy the token broker

The broker is a plain Node HTTP service. In production, inject the environment
directly rather than shipping a file:

```sh
export TWITCH_CLIENT_ID=...
export TWITCH_CLIENT_SECRET=...
export KICK_CLIENT_ID=...
export KICK_CLIENT_SECRET=...
export ALLOWED_ORIGINS=chrome-extension://<extension-id>
export ALLOWED_REDIRECT_URIS=https://<extension-id>.chromiumapp.org/
export PORT=8787

npm run build:broker && node broker/dist/server.js
```

Notes on each:

- `ALLOWED_ORIGINS` is checked against the request `Origin`. Leave it empty and the
  broker will not start, because an unlisted origin is exactly the case where a
  stolen code could be exchanged.
- `ALLOWED_REDIRECT_URIS` is compared against the `redirect_uri` the extension asks
  the broker to use. Registering the extension URI in the provider console is not
  enough; the broker must also be told to expect it.
- `PORT=0` binds an ephemeral port, which the test suite uses.

A variable already present in the real environment wins over any `.env` file, so the
same command works in both places.

Behind a reverse proxy, terminate TLS upstream. The extension's `host_permissions`
must include the broker's origin, because that is what lets the worker reach it.

## Register the OAuth redirect URI

1. Build the extension and load it unpacked (below) so Chrome assigns an extension
   id. The id is what the redirect URI is derived from, and it is also what the
   broker's `ALLOWED_ORIGINS` must contain.
2. In the Twitch developer console, register the callback URL:

   ```
   https://<extension-id>.chromiumapp.org/
   ```

3. In the Kick developer console, register the same URL.
4. Add it to the broker's `ALLOWED_REDIRECT_URIS`, and restart the broker.
5. Confirm the client ids you registered are the ones the extension and the broker
   are configured with.

Read the id from `chrome://extensions`, where it is shown on the extension's card as
**ID**. The redirect URI is always `https://<extension-id>.chromiumapp.org/`, with
the trailing slash, and it must match byte for byte in both consoles and in the
broker. If you also generate a `manifest.json` **key** for the build, the id becomes
the same for every machine and install, which is what you want for anything beyond
local development.

## Load the extension unpacked

1. `npm run build`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the `dist/` directory.
4. Open the popup and confirm no error banner appears. A service-worker error would
   also be visible under the extension's **service worker** link; the build test
   suite fails if the worker logs anything during startup, so a clean
   `npm run verify` is a reasonable proxy.

## Permissions, and what is deliberately optional

Granted at install, because the extension cannot function without them:

| Permission      | Why                                                   |
| --------------- | ----------------------------------------------------- |
| `storage`       | accounts, channels, live state, history              |
| `alarms`        | polling while the popup is closed                     |
| `notifications` | the went-live alert                                   |
| `identity`      | the OAuth redirect                                    |

Host permissions for `id.twitch.tv`, `api.twitch.tv`, `id.kick.com`, `api.kick.com`
and the broker origin are also default, since they are the app's own traffic.

Two are **optional** and are never granted until the user asks for them in the
popup's Kick section:

| Optional permission  | Granted for                                     |
| -------------------- | ----------------------------------------------- |
| `https://kick.com/*` | reading the followed-channel list                |
| `cookies`            | reading the Kick web session for that request    |

The unofficial import is a convenience, not a requirement. Detection, tracking by
handle, and official channel listings all work without it, and turning the toggle
off both drops the grants and forgets the setting.

## Rotate a secret

Client secrets never enter the extension, so rotation is a broker-only operation.

1. Generate the new secret in the provider's developer console.
2. Update the provider's `*_CLIENT_SECRET` in the broker's environment.
3. Restart the broker.
4. Confirm a connect still works.

No browser data needs clearing: access tokens stay valid until they expire, and
refresh happens through the broker, so the next refresh after the restart uses the
new secret. If you also rotate the **client id**, rebuild the extension with the new
`TWITCH_CLIENT_ID` / `KICK_CLIENT_ID` and update the broker to match, because the
id is public and is compiled into the bundle.

To invalidate every user's tokens, revoke them in the provider console. The
extension will then mark the account as needing reconnection rather than retrying.

## Add a provider

A platform is one adapter plus a registration. Nothing in `src/core/detection.ts`,
`src/core/tracking.ts` or the popup needs to change.

1. Create `src/providers/<name>/adapter.ts` implementing `ProviderAdapter`. Declare
   it with `satisfies ProviderAdapter` so the compiler checks the whole contract:

   ```ts
   const upstream = new UpstreamFixture();

   export const myAdapter = {
     id: 'myplatform',
     displayName: 'MyPlatform',
     authStrategy: 'oauth',
     capabilities: {
       followedChannels: true,
       followedStreams: true,
       manualChannelEntry: true,
       unofficialFollowImport: false,
       supportsMultipleAccounts: true,
       realtimeEvents: false,
     },
     publicStreamUrl: (channel) => `https://myplatform.example/${channel.displayName}`,

     // A listing is answered one page at a time. Omitting nextCursor tells the
     // tracker the listing is exhausted; returning it always would loop forever.
     async listFollowedChannels(account, cursor) {
       const all = upstream.handles().map(({ channelId, handle }) => ({
         channelId,
         displayName: handle,
         accountId: account.accountId,
       }));
       const start = cursor ? Number(cursor) : 0;
       const size = 2;
       const channels = all.slice(start, start + size);
       const next = start + size;
       return { channels, ...(next < all.length ? { nextCursor: String(next) } : {}) };
     },

     async resolveChannelByHandle(account, handle) {
       const found = upstream.handles().find((entry) => entry.handle === handle);
       return found ? { channelId: found.channelId, displayName: found.handle, accountId: account.accountId } : undefined;
     },

     async fetchLiveStatus(account, channelIds) {
       const live = upstream.liveEntries()
         .filter((entry) => channelIds.includes(entry.channelId))
         .map((entry) => entry.info);
       const wentOffline = channelIds.filter((id) => !live.some((info) => info.channelId === id));
       return { providerId: 'myplatform', accountId: account.accountId, live, wentOffline, warnings: [] };
     },
   } satisfies ProviderAdapter;
   ```

   `pollAccount` treats a thrown error as a failed poll, so an adapter that cannot
   answer must reject rather than return an empty `live` list: returning empty would
   read as "every tracked channel just went offline" and raise a false notification.

   `tests/provider-guide.test.ts` contains this adapter verbatim, so the snippet above
   is known to satisfy the contract.

2. Return `undefined` from `resolveChannelByHandle` when there is no such channel,
   and throw `UnsupportedCapabilityError` from `listFollowedChannels` if the
   platform has no followed-channel endpoint. Adding a channel by handle must work
   regardless.
3. Implement `fetchLiveStatus` to report the tracked channels that are live in
   `live`, and the ones no longer live in `wentOffline`, so the engine can detect
   both transitions without a second request.
4. Register it in the provider registry and, if it uses OAuth, add its client id to
   `BUILD_CONFIG` and its secret to the broker's configuration.
5. Reuse the shared behaviour suite for your adapter; it asserts the contract that
   detection relies on:

   ```ts
   import { createFixture, UpstreamFixture, type ProviderFixture } from './helpers/fixture-state';
   import { describeSharedProviderBehaviour } from './helpers/shared-behaviour';

   function myFixture(): ProviderFixture {
     const upstream = new UpstreamFixture();
     const adapter = adapterWith(myRoutes(upstream));

     return createFixture(
       adapter,
       {
         failPollOnce: (error) => {
           fail.status = error.name === 'AuthError' ? 401 : 500;
         },
         setPageSize: (size) => {
           page.size = size;
         },
         streamUrlFor: (_channelId, handle) =>
           adapter.publicStreamUrl({ channelId: '', displayName: handle, accountId: '' }),
       },
       {
         follow: (channelId, handle) => upstream.follow(channelId, handle),
         setLive: (channelId, handle, info) => upstream.setLive(channelId, handle, info),
         setOffline: (channelId) => upstream.setOffline(channelId),
       },
     );
   }

   describeSharedProviderBehaviour('MyPlatformAdapter', myFixture);
   ```

   `createFixture` takes the adapter plus controls for the faked upstream, and the
   overrides route the fixture's verbs at that upstream. The suite it drives asserts
   both transition directions, partial listings and auth failures, so an adapter that
   passes it will not surprise the detection engine. `tests/twitch-adapter.test.ts`
   and `tests/kick-adapter.test.ts` are complete worked examples.
6. Add the platform's hosts to `HOST_PERMISSIONS` in `src/manifest.ts`.

Only after these does the new platform appear in the popup, because the view is
driven entirely by the adapter's declared capabilities.

## Configuration reference

Build-time, read by `scripts/build.mjs` through `src/manifest.ts`:

| Variable           | Read from         | Used for                 | Default if unset                    |
| ------------------ | ----------------- | ------------------------ | ----------------------------------- |
| `BROKER_ORIGIN`    | `.env`            | broker host permission   | `https://broker.example.invalid`    |
| `TWITCH_CLIENT_ID` | either `.env`     | Twitch authorization URL | `twitch-client-id-not-configured`   |
| `KICK_CLIENT_ID`   | either `.env`     | Kick authorization URL   | `kick-client-id-not-configured`     |

`npm run build` reads `.env` first and then `broker/.env`, so a public value only
needs setting in one place. An unset variable falls back to a visibly unconfigured
placeholder rather than shipping a blank host permission.

These files are git-ignored. `broker/.env` holds client secrets and must never be
committed; `.env` holds only public values but is ignored too, so a real client id
never lands in a diff.

Run-time, read only by the broker: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`,
`KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `ALLOWED_ORIGINS`,
`ALLOWED_REDIRECT_URIS`, `PORT`.

## Troubleshooting

**Popup shows the broker is unreachable.** The extension cannot reach the configured
`BROKER_ORIGIN`. Check that the origin is in the built `host_permissions` and that
the broker's `ALLOWED_ORIGINS` contains the extension's `chromiumapp.org` origin.

**Connect fails immediately.** The redirect URI is almost always the cause. It must
be identical in the provider console, in the broker's `ALLOWED_REDIRECT_URIS`, and
as derived from `chrome.identity.getRedirectURL('')`, trailing slash included.

**Account says it needs to reconnect.** The grant was refused, usually because the
secret was rotated without restarting the broker. Reconnect from the popup; the
tracked channels for that account are kept.

**No notifications but the channel shows as live.** The extension has no
notification permission, or the platform's toggle is off. Both states are shown in
the popup next to the platform name.

**A channel shows "not updating".** Repeated polls have failed. The banner names the
account; the common cause is a revoked or expired grant upstream.
