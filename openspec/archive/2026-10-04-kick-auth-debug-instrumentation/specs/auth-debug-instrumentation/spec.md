## Purpose

Provides a simple, general-purpose logging system for both the extension and the broker so operational events can be traced safely without exposing secrets.

## ADDED Requirements

### Requirement: Provide a simple logging interface

The system SHALL provide a minimal logging module with levels debug, info, warn, error and a consistent interface usable across extension and broker code.

#### Scenario: Extension logs at different levels
- **WHEN** extension code logs at debug/info/warn/error
- **THEN** the log entry is emitted with level, timestamp or context, and message

#### Scenario: Broker logs at different levels
- **WHEN** broker code logs at debug/info/warn/error
- **THEN** the log entry is emitted with level and message

### Requirement: Logging is safe by default (no secrets)

All log output MUST be sanitized to exclude secrets: access tokens, refresh tokens, client secrets, authorization codes, PKCE code_verifiers, and full OAuth state values. Only non-sensitive metadata (providerId, booleans like hasCode/hasState, error reason class, short prefixes) may be logged.

#### Scenario: Auth flow logs contain no secrets
- **WHEN** auth/connect code logs
- **THEN** no secrets appear in log output

#### Scenario: Broker logs contain no secrets
- **WHEN** broker logs any request/response outcome
- **THEN** no secrets or credentials appear

### Requirement: Instrument key operational paths

The system SHALL instrument key paths with general logging: auth/connect, broker HTTP requests/responses (outcomes), message handling errors, and core lifecycle events where helpful. Instrumentation is additive and does not change behavior.

#### Scenario: Connect flow emits trace logs
- **WHEN** a connect flow runs
- **THEN** key steps are logged (start, launch, redirect summary, completion) with safe metadata

#### Scenario: Broker requests logged by outcome
- **WHEN** broker makes or receives requests
- **THEN** success/failure is logged with safe context

### Requirement: Simple and extensible

The logging implementation SHALL be minimal (few lines, no heavy dependencies), easy to extend to new modules, and consistent across extension and broker.

#### Scenario: Adding a new module
- **WHEN** a new module needs logging
- **THEN** it can import and use the logger without complex setup
