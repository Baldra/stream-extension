# Account Auth Specification

## Purpose
Covers connecting the user's own Twitch and Kick accounts to the extension, keeping those credentials usable over time, and disconnecting an account and all data derived from it.

## Requirements

### Requirement: Connect an account with the platform's authorization flow

The system SHALL allow the user to connect each supported platform's account using that platform's own official authorization endpoint. The system SHALL request only the permissions needed to read the user's followed channels and identify their account, and SHALL NOT request permissions that alter the user's channels, chat, or settings.

The system SHALL require the user to complete authorization in the provider's own page, and SHALL NOT collect or handle the user's platform password.

#### Scenario: User connects a Twitch account

- **WHEN** the user starts connecting a Twitch account
- **THEN** the system opens Twitch's official authorization page requesting only the follow-list permission
- **AND** the extension records a connected Twitch account once the user approves

#### Scenario: User connects a Kick account

- **WHEN** the user starts connecting a Kick account
- **THEN** the system opens Kick's official authorization page using the authorization-code flow with PKCE
- **AND** the extension records a connected Kick account once the user approves

#### Scenario: No platform password is handled

- **WHEN** the user authorizes any platform
- **THEN** the credential the user submits is submitted only to that platform's authorization page
- **AND** the extension never receives or stores it

### Requirement: Prove possession of the authorization request

The system SHALL generate a fresh, unpredictable value per authorization attempt, bind it to that attempt, and verify the value returned by the provider matches before accepting any credentials. A mismatch or a missing value SHALL cause the attempt to be discarded without connecting an account.

#### Scenario: Returned state does not match

- **WHEN** a provider redirects back with a state value that differs from the one generated for that attempt
- **THEN** the system discards the response
- **AND** no account becomes connected

#### Scenario: Returned state matches

- **WHEN** a provider redirects back with the state value generated for that attempt
- **THEN** the system accepts the response and proceeds to exchange it for credentials

### Requirement: Store credentials only in the local browser profile

The system SHALL store the credentials for each connected account in the browser's local extension storage, keyed by platform identifier and platform account identifier. The system SHALL NOT transmit stored credentials to any destination other than the platform they belong to, and SHALL NOT include them in logs, error messages, or user-interface output.

#### Scenario: Credentials are readable only locally

- **WHEN** an account is connected
- **THEN** its credentials are written to the browser's local extension storage
- **AND** they are not sent to any server other than the platform's own API

#### Scenario: Credentials never appear in diagnostics output

- **WHEN** the system records a diagnostic, log entry, or error message
- **THEN** the output contains no access token, refresh token, or client secret

### Requirement: Keep credentials valid without repeated user action

The system SHALL use stored credentials to query the platform's API without prompting the user to re-authorize while the credentials remain valid. When a platform requires credentials to be renewed and a stored renewal credential is available, the system SHALL renew automatically. When renewal is not possible, the system SHALL mark the account as requiring reconnection and SHALL surface that state to the user rather than polling silently with failing credentials.

#### Scenario: Stored credentials are still valid

- **WHEN** the system queries a platform using a connected account's stored credentials
- **THEN** it does not ask the user to authorize again

#### Scenario: Stored credentials expire and can be renewed automatically

- **WHEN** a connected account's credentials have expired and the platform issued a renewal credential
- **THEN** the system renews automatically using that renewal credential
- **AND** the account remains connected without user action

#### Scenario: Renewal is no longer possible

- **WHEN** a connected account's credentials have expired and renewal fails permanently
- **THEN** the system marks the account as requiring reconnection
- **AND** the user interface shows that the account must be reconnected
- **AND** the system stops issuing live-status queries for that account

### Requirement: Disconnect an account and purge its data

The system SHALL allow the user to disconnect a connected account. On disconnect the system SHALL revoke or discard the account's credentials with the platform, and SHALL remove that account's stored credentials, tracked channels, and last-known live state from local storage.

Disconnecting one account SHALL NOT affect other connected accounts, including other accounts on the same platform.

#### Scenario: User disconnects an account

- **WHEN** the user disconnects a connected account
- **THEN** the account's stored credentials, tracked channels, and last-known live state are removed
- **AND** the user interface no longer shows the account as connected

#### Scenario: Disconnecting one account preserves another

- **GIVEN** two accounts are connected on the same platform
- **WHEN** the user disconnects one of them
- **THEN** the other account remains connected with its tracked channels intact

#### Scenario: Disconnected account is no longer polled

- **WHEN** an account has been disconnected
- **THEN** the system issues no further live-status queries for that account's channels
- **AND** raises no further notifications for them

### Requirement: Support multiple accounts per platform

The system SHALL allow more than one account to be connected for the same platform, and SHALL keep their credentials, tracked channels, and last-known live state isolated from each other. Tracked channels and notifications SHALL be attributed to the owning account.

#### Scenario: Two accounts on one platform

- **GIVEN** the user has connected two accounts on the same platform
- **WHEN** live detection runs
- **THEN** it queries both accounts using each account's own credentials
- **AND** a channel tracked by one account is not treated as tracked by the other

#### Scenario: Notification identifies the owning account

- **WHEN** a notification is raised for a channel tracked by a specific account
- **THEN** the notification identifies the channel and its platform
