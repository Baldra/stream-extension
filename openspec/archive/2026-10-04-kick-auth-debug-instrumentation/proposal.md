## Why

The application has limited visibility into what happens during runtime (auth flows, broker calls, polling, message handling). We need a simple, general logging system for both the extension and the server (broker) to make debugging easier without over-engineering.

## What Changes

- Add a minimal, general logging utility/module for the extension (background, core, popup as needed) with simple levels (debug/info/error/warn) and consistent formatting
- Add a minimal logging utility for the broker (server-side) with the same essential behavior
- Instrument key operational paths (auth/connect flows, broker HTTP calls, message handling, detection/polling where useful) with structured, non-sensitive logs
- Ensure all logs redact secrets/tokens (access/refresh tokens, client secrets, codes, verifiers, full state values)
- Keep it simple and easy to scale

## Capabilities

### New Capabilities
- `logging`: A minimal general-purpose logging system for extension and broker with consistent, safe logging and easy extensibility.

### Modified Capabilities
- (none) — no requirement changes to existing behavioral specs.

## Impact

- Affects: src/core/logging.ts (new), src/background/*, src/core/accounts.ts, src/background/broker-client.ts, src/background/messages.ts, broker/src/logging.ts (new), broker/src/* as needed
- No external API changes, no permission changes, no schema changes
- Logging is additive; all existing tests continue to pass
