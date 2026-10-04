# Channel Tracking Specification

## Purpose
Covers the set of channels the extension monitors for each connected account — how that set is populated on each platform, how entries are added and removed, and how channels are identified so that duplicates never produce duplicate notifications.

## Requirements

### Requirement: Track channels per connected account

The system SHALL maintain a distinct set of tracked channels for each connected account. A channel SHALL belong to exactly one connected account, and a channel's tracked state, last-known live state, and notifications SHALL be attributable to the account that tracks it.

#### Scenario: Channel belongs to one account

- **GIVEN** the same channel is tracked by two different connected accounts
- **WHEN** the system stores its tracked state
- **THEN** the channel has one tracked entry per account
- **AND** each account's live state for that channel is stored independently

#### Scenario: Disconnecting an account affects only its channels

- **WHEN** a user disconnects an account
- **THEN** only the channels tracked by that account are removed
- **AND** channels tracked by other accounts are unaffected

### Requirement: Identify a channel by platform and immutable identifier

The system SHALL identify each tracked channel by the platform identifier together with the platform's stable identifier for that channel, and SHALL NOT identify a channel by its display name or by a user-renameable handle alone. A channel renamed by the streamer SHALL continue to be recognized as the same tracked channel.

#### Scenario: Streamer renames their channel

- **WHEN** a tracked channel changes its handle on the platform
- **THEN** the system continues to treat it as the same tracked channel
- **AND** does not raise a notification as if a new channel had started streaming

#### Scenario: Handle collision is not a match

- **GIVEN** a tracked channel is renamed
- **WHEN** a different channel later takes the old handle
- **THEN** the system does not treat the new holder of that handle as the tracked channel

### Requirement: Import followed channels where the platform supports it

Where a platform provides an official endpoint listing the connected account's followed channels, the system SHALL offer to import that list into the account's tracked channels. The import SHALL page through the complete list and SHALL resolve each followed channel's stable platform identifier.

#### Scenario: Twitch follow list is imported

- **WHEN** the user requests a followed-channel import for a connected Twitch account
- **THEN** the system retrieves the account's followed channels using the platform's official endpoint
- **AND** adds each returned channel to the account's tracked channels

#### Scenario: Large follow list is fully imported

- **GIVEN** a connected Twitch account follows more channels than a single API page returns
- **WHEN** the import runs
- **THEN** the system retrieves every page
- **AND** the tracked set contains all of the account's followed channels

#### Scenario: Import preserves channels removed on the platform

- **GIVEN** the user previously removed a channel from their tracked set in the extension, while still following it on the platform
- **WHEN** a follow import runs
- **THEN** the system does not re-add that channel

### Requirement: Add a channel manually

The system SHALL allow the user to add a channel by handle where the platform identifies channels by handle, including for platforms that provide no way to list followed channels. On add, the system SHALL validate the handle against the platform and resolve the channel's stable platform identifier. Adding a channel that is already tracked by the same account SHALL NOT create a second tracked entry.

#### Scenario: Kick channel is added by handle

- **WHEN** the user submits a Kick channel handle that exists
- **THEN** the system adds it to the connected Kick account's tracked channels
- **AND** stores its stable platform identifier for later live-status queries

#### Scenario: Handle does not exist

- **WHEN** the user submits a Kick channel handle that the platform does not recognise
- **THEN** the system reports that the channel could not be found
- **AND** adds no tracked channel

#### Scenario: Adding an already-tracked channel is idempotent

- **GIVEN** a channel is already tracked by the account
- **WHEN** the user adds the same channel again
- **THEN** the tracked set contains a single entry for that channel

### Requirement: Remove a tracked channel

The system SHALL allow the user to remove any tracked channel. On removal the system SHALL discard that channel's tracked state and last-known live state, and SHALL stop polling it. Removing a channel that is not tracked SHALL succeed without error.

#### Scenario: User removes a channel

- **WHEN** the user removes a tracked channel
- **THEN** the system stops polling it
- **AND** raises no further notifications for it

#### Scenario: Removing a non-tracked channel

- **WHEN** the user removes a channel that is not tracked
- **THEN** the system completes the removal without error

### Requirement: Offer an explicitly optional undocumented follow import

Where a platform has no official followed-channel endpoint, the system MAY offer a follow import that uses the platform's undocumented website API. The system MUST label that action as using an unofficial, unsupported integration, MUST keep it disabled until the user explicitly enables it, and MUST fail without affecting any other behavior if the undocumented endpoint is unavailable or changes.

The undocumented import MUST NOT be required for live detection to function.

#### Scenario: Undocumented import is off by default

- **WHEN** the user has connected a Kick account
- **THEN** the unofficial follow import is not performed
- **AND** no action that triggers it is presented as enabled

#### Scenario: User explicitly enables and runs the import

- **GIVEN** the user has explicitly enabled the unofficial follow import for a connected Kick account
- **WHEN** the user runs it
- **THEN** the system adds the returned channels to the account's tracked channels

#### Scenario: Undocumented endpoint stops working

- **GIVEN** the unofficial follow import is enabled
- **WHEN** the undocumented endpoint returns an error or an unrecognized response
- **THEN** the system reports that the unofficial import is unavailable
- **AND** the tracked channel set is left unchanged
- **AND** live detection and notifications continue to function

#### Scenario: Undocumented import is disabled

- **WHEN** the user disables the unofficial follow import
- **THEN** the system no longer requests it
- **AND** channels already tracked by other means remain tracked
