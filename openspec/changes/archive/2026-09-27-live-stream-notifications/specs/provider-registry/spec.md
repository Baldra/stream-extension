## Purpose

Defines the single contract every streaming platform integration must satisfy, and the rules for registering one, so that adding a third provider later is an isolated addition that does not require changes to authentication, polling, notification, or user-interface behavior.

## ADDED Requirements

### Requirement: Provider adapter contract

The system SHALL define one provider adapter contract that every streaming platform integration MUST implement. The contract SHALL cover: provider identity, the authentication strategy the platform requires, resolution of the tracked channel list for a connected account, retrieval of current live status for tracked channels, and the public stream URL for a channel.

The contract SHALL be the only surface through which the polling, notification, and dashboard behavior reaches a streaming platform. No other subsystem SHALL reference a platform's HTTP endpoints, authentication endpoints, or response shapes directly.

#### Scenario: Twitch and Kick satisfy the same contract

- **WHEN** the polling, notification, or dashboard behavior needs live status for a channel
- **THEN** it obtains that status through the provider adapter contract
- **AND** it does not reference a platform-specific endpoint or response field

#### Scenario: Contract is sufficient to implement a new platform

- **WHEN** a new platform adapter is registered
- **THEN** the polling loop, notification behavior, and dashboard operate for it without modification to those subsystems

### Requirement: Provider registration

The system SHALL support registering each supported platform as a provider. Registration SHALL declare a stable, unique provider identifier, and the identifier SHALL be used as the storage key for that provider's credentials and tracked channels.

The system SHALL refuse to register two providers under the same identifier.

#### Scenario: Twitch and Kick are registered as providers

- **WHEN** the extension starts with no stored accounts
- **THEN** it exposes both `twitch` and `kick` as connectable providers

#### Scenario: Duplicate identifier is rejected

- **WHEN** a provider is registered using an identifier that is already in use
- **THEN** the system rejects the registration and reports the conflict
- **AND** the already-registered provider remains usable

### Requirement: Platform-specific quirks are contained in the adapter

Any platform-specific constraint SHALL be contained within that platform's adapter and SHALL NOT leak into shared behavior. This includes required authentication parameters, endpoint batching limits, pagination style, and any undocumented endpoint the platform depends on.

#### Scenario: A platform requires a client secret and another does not

- **WHEN** the authentication behavior initiates a connection for each supported platform
- **THEN** each platform's credential requirements are satisfied by that platform's own adapter
- **AND** the shared authentication behavior contains no platform-specific credential logic

#### Scenario: A platform's undocumented endpoint is removed

- **WHEN** a platform's undocumented endpoint stops responding
- **THEN** only the adapter feature that depends on that endpoint degrades
- **AND** live detection, notifications, and the dashboard continue to function

### Requirement: Provider capability discovery

The system SHALL expose, per registered provider, which optional capabilities that platform supports, so that the user interface can present only applicable actions. A provider that does not support listing followed channels SHALL NOT present a follow-import action.

#### Scenario: Kick does not support official follow listing

- **WHEN** the user interface renders the Kick channel management view
- **THEN** it does not present an official "import followed channels" action
- **AND** it presents manual channel entry instead

#### Scenario: Twitch supports official follow listing

- **WHEN** the user interface renders the Twitch channel management view
- **THEN** it presents an action to import the account's followed channels
