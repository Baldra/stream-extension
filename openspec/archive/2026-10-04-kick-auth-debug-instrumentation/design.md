## Context

The app needs a simple, general logging system for both extension and broker to improve debuggability. The current approach of ad-hoc console calls is inconsistent and risks logging secrets.

## Goals / Non-Goals

**Goals:**
- Minimal logging module for extension (src/core/logging.ts)
- Minimal logging module for broker (broker/src/logging.ts) 
- Safe redaction (no tokens/secrets/codes/full state)
- Instrument key paths (auth/connect, broker calls, message errors)
- Simple, extensible, no heavy deps

**Non-Goals:**
- External log shipping, persistence beyond console
- Complex log levels/formatting
- Changing existing behavior

## Decisions

1. **Simple interface**: Both loggers export a logger object with debug/info/warn/error. Extension logger may include context prefix; broker logger keeps it simple.
2. **Redaction utility**: Shared redaction logic - strip/obfuscate sensitive keys (token, access_token, refresh_token, client_secret, code, code_verifier, state, password). For state, log prefix only.
3. **Placement**: Extension core logger (src/core/logging.ts) imported by background/core modules. Broker logger (broker/src/logging.ts) for server code.
4. **Safe metadata only**: When logging objects, sanitize keys/values.
5. **Non-invasive**: Additive instrumentation.

## Risks / Trade-offs

- [Risk] Log volume - Mitigation: keep to essentials, use debug for verbose traces
- [Risk] Accidental leakage - Mitigation: centralize sanitization in logger
