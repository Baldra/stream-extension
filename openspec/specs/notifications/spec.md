# Notifications Specification

## Purpose
Covers raising a browser notification when a tracked channel starts a new stream — what the notification conveys, how duplicates are prevented, and what happens when the user interacts with it.

## Requirements

### Requirement: Raise one notification per newly-live event

The system SHALL raise a browser notification for each newly-live event raised by live detection, and for no other event. A single newly-live event SHALL produce at most one notification even if the poll that produced it is retried or repeated.

#### Scenario: Event produces exactly one notification

- **WHEN** live detection raises a newly-live event for a channel
- **THEN** the system raises exactly one browser notification for that channel
- **AND** raises none for channels whose live state did not change

#### Scenario: Duplicate delivery is suppressed

- **GIVEN** a notification has been raised for a newly-live event
- **WHEN** the same event is observed again, such as after a worker restart
- **THEN** the system raises no additional notification for it

#### Scenario: Channel going offline raises nothing

- **WHEN** a tracked channel stops streaming
- **THEN** the system raises no notification

### Requirement: Convey who went live, on which platform, and what they are playing

A notification SHALL identify the channel by its platform display name, name the platform, and include the stream title and category when the platform supplies them. When the platform supplies a thumbnail image, the notification SHALL use it.

The notification SHALL NOT include any platform credential.

#### Scenario: Notification content for a live channel

- **WHEN** a notification is raised for a channel that is live
- **THEN** it shows the channel's display name and the platform
- **AND** it shows the stream title and category when the platform supplied them
- **AND** it shows the platform's thumbnail when one was supplied

#### Scenario: Missing optional details degrade gracefully

- **GIVEN** the platform supplied no category for the stream
- **WHEN** a notification is raised for that stream
- **THEN** the notification omits the category
- **AND** still shows the channel and the platform

#### Scenario: No credentials in the notification

- **WHEN** a notification is raised
- **THEN** it contains no access token, renewal credential, or client secret

### Requirement: Clicking a notification opens the stream

Clicking a notification SHALL open the channel's live stream page in a new browser tab, and SHALL dismiss the notification. The destination SHALL be the platform's canonical public URL for that channel.

#### Scenario: User clicks the notification

- **WHEN** the user clicks a notification
- **THEN** the channel's live stream page opens in a new tab
- **AND** the notification is no longer shown

#### Scenario: Channel is offline when clicked

- **GIVEN** a channel stopped streaming after its notification was raised
- **WHEN** the user clicks that notification
- **THEN** the channel's page opens rather than failing
- **AND** the system does not raise a further notification

### Requirement: Respect the user's notification permission and per-provider choice

The system SHALL raise notifications only when the browser has granted notification permission for the extension. If permission is not granted, the system SHALL continue tracking and raise no notifications, and SHALL prompt the user to grant permission. The system SHALL support disabling notifications for an individual platform, and while disabled for a platform the system SHALL continue tracking that platform and raise no notifications from it.

#### Scenario: Notification permission not granted

- **GIVEN** the browser has not granted the extension notification permission
- **WHEN** a channel goes live
- **THEN** the system raises no notification
- **AND** continues tracking the channel
- **AND** prompts the user to grant notification permission

#### Scenario: User disables notifications for one platform

- **WHEN** the user disables notifications for a platform
- **THEN** the system continues tracking that platform's channels
- **AND** raises no notifications for channels on that platform

#### Scenario: User re-enables notifications

- **WHEN** the user re-enables notifications for a platform
- **THEN** the system raises notifications for newly-live events on that platform that occur afterwards
- **AND** does not retroactively notify for channels already live

### Requirement: Record each raised notification

The system SHALL record each raised notification, including the channel, platform, and time it was raised, so that the user can review recent notifications. Recorded history SHALL be retained only locally and SHALL be bounded, discarding the oldest entries beyond a configured limit.

#### Scenario: Raised notification is recorded

- **WHEN** a notification is raised
- **THEN** the system records the channel, platform, and time of the notification

#### Scenario: History is bounded

- **WHEN** the number of recorded notifications exceeds the configured limit
- **THEN** the system discards the oldest entries so only the most recent remain
