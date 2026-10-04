## Purpose

Covers the extension popup that shows the user which tracked channels are live right now, which accounts are connected, and what was notified recently.

## ADDED Requirements

### Requirement: List currently live tracked channels

The dashboard SHALL show every tracked channel that is live, for every connected account and every supported platform, in a single list. Each entry SHALL identify the channel, the platform, and the account it is tracked by, and SHALL indicate that the channel is currently live.

#### Scenario: Channels live on multiple platforms are shown together

- **GIVEN** tracked channels on two platforms are live at the same time
- **WHEN** the user opens the dashboard
- **THEN** the dashboard lists all of them in one list
- **AND** each entry identifies its platform and the account that tracks it

#### Scenario: No tracked channel is live

- **WHEN** the user opens the dashboard and no tracked channel is live
- **THEN** the dashboard states that no tracked channels are currently live

#### Scenario: Channels that went offline are not listed as live

- **GIVEN** a tracked channel was live and has since stopped
- **WHEN** the user opens the dashboard
- **THEN** the channel is not presented as currently live

#### Scenario: Stale live state is not shown as current

- **GIVEN** a platform's live-status queries are failing
- **WHEN** the user opens the dashboard
- **THEN** the dashboard does not present unverified state as current
- **AND** indicates that the platform is not currently updating

### Requirement: Show connected accounts and their state

The dashboard SHALL list each connected account with its platform and the identity the user authorized, and SHALL offer an action to connect another account and an action to disconnect each listed account.

#### Scenario: Connected accounts are listed

- **GIVEN** accounts are connected on one or more platforms
- **WHEN** the user opens the dashboard
- **THEN** each connected account is listed with its platform and authorized identity

#### Scenario: Account requiring reconnection is marked

- **GIVEN** a connected account's credentials can no longer be renewed
- **WHEN** the user opens the dashboard
- **THEN** that account is marked as requiring reconnection
- **AND** an action to reconnect it is offered

#### Scenario: User disconnects from the dashboard

- **WHEN** the user disconnects an account from the dashboard
- **THEN** the account is removed from the connected list
- **AND** its tracked channels are no longer polled

### Requirement: Provide connect and channel-management actions

The dashboard SHALL provide an action to connect each supported platform, and SHALL provide channel management scoped to a connected account: importing followed channels where the platform officially supports it, adding a channel by handle, and removing a tracked channel.

#### Scenario: Connect action is available for each platform

- **WHEN** the user views the dashboard
- **THEN** an action to connect each supported platform is offered

#### Scenario: Channel actions are scoped to one account

- **GIVEN** two accounts are connected on the same platform with different tracked channels
- **WHEN** the user manages channels for one account
- **THEN** only that account's tracked channels are listed and modifiable

#### Scenario: Unsupported import action is absent

- **WHEN** the user manages channels for an account on a platform with no official followed-channel endpoint
- **THEN** no official follow-import action is offered for that platform

#### Scenario: Unofficial import is presented as optional and unsupported

- **WHEN** an account on a platform with no official followed-channel endpoint is shown
- **THEN** any unofficial follow-import action is labelled as unofficial and unsupported
- **AND** is not active unless the user has explicitly enabled it

### Requirement: Show recent notification history

The dashboard SHALL show the most recent notifications the system raised, including the channel, platform, and time, and SHALL indicate when no notifications have been raised yet.

#### Scenario: Recent notifications are shown

- **GIVEN** the system has raised notifications
- **WHEN** the user opens the dashboard
- **THEN** the most recent notifications are shown with channel, platform, and time

#### Scenario: No notifications yet

- **WHEN** the user opens the dashboard before any notification has been raised
- **THEN** the dashboard states that no notifications have been raised yet

### Requirement: Reflect the latest detected state without user action

The dashboard SHALL reflect the most recent detection results when opened, and SHALL update if detection results change while it is open, without requiring the user to reload or reopen it.

#### Scenario: Dashboard opens with current results

- **WHEN** the user opens the dashboard
- **THEN** it shows the most recent detection results
- **AND** does not require a detection run to have been triggered by the user

#### Scenario: Live status changes while the dashboard is open

- **GIVEN** the dashboard is open showing a tracked channel as live
- **WHEN** detection finds that channel is no longer live
- **THEN** the dashboard stops presenting it as live without reopening
