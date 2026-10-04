## 1. Create logging infrastructure

- [x] 1.1 Create `src/core/logging.ts` with simple logger (debug/info/warn/error), context prefix support, and redaction (no secrets/tokens/codes/full state); verify exports work
- [x] 1.2 Create `broker/src/logging.ts` with simple logger and same redaction rules; verify it compiles

## 2. Instrument extension paths

- [x] 2.1 Instrument `src/background/index.ts` connectAccount with general trace logs (start, begin, launch result, redirect summary, completion) using safe metadata; verify behavior unchanged
- [x] 2.2 Instrument `src/core/accounts.ts` completeConnect with key steps and safe outcomes; verify no secrets logged
- [x] 2.3 Instrument `src/background/broker-client.ts` post() with request start (provider/path) and outcome; verify no sensitive body logged
- [x] 2.4 Instrument `src/background/messages.ts` handleDashboardRequest error paths with console/error via logger; verify errors propagate to popup

## 3. Instrument broker paths

- [x] 3.1 Instrument `broker/src/handlers.ts` exchange/refresh/revoke with safe outcome logs; verify no secrets
- [x] 3.2 Instrument `broker/src/server.ts` startup with safe info logs; verify no config secrets logged

## 4. Verification

- [x] 4.1 Rebuild extension and broker; verify no type errors
- [x] 4.2 Attempt auth flows and verify logs appear with safe content (no tokens/secrets)
- [x] 4.3 All existing tests still pass (npm test)
