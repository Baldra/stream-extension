## Purpose

Covers the periodic polling of tracked channels, how the system determines that a channel has just started a stream, and how it behaves across service-worker restarts, rate limits, and provider errors.

## ADDED Requirements

### Requirement: Poll tracked channels on a periodic schedule

The system SHALL poll tracked channels on a recurring schedule while any account is connected and has at least one tracked channel. Each poll SHALL cover every tracked channel of every connected account, and SHALL batch its requests to the platform within that platform's documented limits.

The system SHALL stop scheduling polls when no account has any tracked channel, and SHALL resume scheduling when a tracked channel is added.

#### Scenario: Polling covers every tracked channel

- **GIVEN** multiple connected accounts across multiple platforms have tracked channels
- **WHEN** a poll runs
- **THEN** the system queries every tracked channel of every account
- **AND** no tracked channel is silently omitted

#### Scenario: Large tracked set is queried in full

- **GIVEN** an account has more tracked channels than a single platform request accepts
- **WHEN** a poll runs
- **THEN** the system issues the additional requests needed to cover the whole tracked set
- **AND** the system pages through any paginated result

#### Scenario: No tracked channels means no polling

- **WHEN** no connected account has any tracked channel
- **THEN** the system is not polling
- **AND** it begins polling again once a channel is tracked

### Requirement: Detect a stream that just started

The system SHALL raise a newly-live event for a tracked channel only when a successful poll shows the channel live and the last known successful state for that channel was not live. A channel that remains live across polls SHALL NOT raise a further event.

A channel with no last known state that is found live on its first successful poll SHALL be recorded as live and SHALL NOT raise a newly-live event, so that installing the extension does not produce a burst of notifications for streams that are already running.

#### Scenario: Channel transitions from offline to live

- **GIVEN** a tracked channel's last known successful state is offline
- **WHEN** a successful poll shows the channel is live
- **THEN** the system raises a newly-live event for that channel exactly once

#### Scenario: Channel stays live across polls

- **GIVEN** a tracked channel was raised as newly-live
- **WHEN** a later poll also shows the channel live
- **THEN** the system raises no further newly-live event for that channel

#### Scenario: Channel restarts a new stream

- **GIVEN** a tracked channel was live and a later successful poll shows it offline
- **WHEN** a subsequent poll shows it live again
- **THEN** the system raises a newly-live event for the new stream

#### Scenario: First poll finds a channel already live

- **GIVEN** a channel is newly tracked and has no last known state
- **WHEN** the first successful poll shows it already live
- **THEN** the system records it as live
- **AND** raises no newly-live event for it

### Requirement: Never infer offline from a failed query

The system SHALL record a channel's live state only from a successful platform query. When a query fails, is rate-limited, or is interrupted, the system SHALL leave that channel's last known state unchanged, SHALL NOT raise a newly-live event, and SHALL NOT raise any event indicating the stream ended.

#### Scenario: Platform request fails during a poll

- **GIVEN** a tracked channel was live
- **WHEN** its live-status query fails
- **THEN** the system retains the channel's last known live state
- **AND** raises no event indicating the stream ended

#### Scenario: Partial failure within one account

- **GIVEN** an account has several tracked channels and a poll fails for one of them
- **WHEN** the poll completes
- **THEN** the successfully queried channels are updated
- **AND** the failed channel's state is left unchanged

### Requirement: Poll cadence is the fastest the browser reliably allows

The system SHALL schedule polls no more frequently than the browser's minimum reliable alarm interval, and SHALL NOT rely on a persistent connection or long-lived worker to achieve a faster cadence. Notification timeliness is bounded by this poll interval and the system SHALL NOT claim a shorter delay than it can deliver.

#### Scenario: Service worker is terminated between polls

- **GIVEN** the background worker has been terminated and later restarted by the browser
- **WHEN** the next scheduled poll runs
- **THEN** the system uses its persisted last-known states to evaluate newly-live events
- **AND** does not re-raise events for channels already recorded as live

#### Scenario: Polling resumes after browser restart

- **WHEN** the browser restarts with the extension installed
- **THEN** the system resumes polling on its schedule using its persisted state
- **AND** does not raise events for channels it already recorded as live

### Requirement: Back off on provider errors and rate limits

When a platform responds with a rate-limit or server error, the system SHALL stop issuing further requests to that platform for a cooling-off interval that increases with consecutive failures, and SHALL resume normal polling once the cooling-off interval passes. The system SHALL surface an ongoing failure to the user rather than polling indefinitely in a failed state.

#### Scenario: Rate limit is returned

- **WHEN** a platform responds with a rate-limit response
- **THEN** the system pauses further requests to that platform for a cooling-off interval
- **AND** raises no newly-live event during the pause
- **AND** resumes polling that platform after the interval passes

#### Scenario: Repeated failures back off further

- **GIVEN** a platform request has failed repeatedly
- **WHEN** the cooling-off interval for the next attempt is computed
- **THEN** the interval is longer than the previous one

#### Scenario: Ongoing failure is visible to the user

- **GIVEN** a platform has failed to respond successfully for an extended period
- **WHEN** the user opens the dashboard
- **THEN** the dashboard indicates that the platform is not currently updating

### Requirement: Renew credentials before a poll fails on them

The system SHALL renew a connected account's credentials ahead of their expiry so that an in-flight poll is not failed by an expired credential, and SHALL serialise renewal per account so that overlapping polls cannot issue concurrent renewals for the same account.

#### Scenario: Credential is near expiry

- **GIVEN** a connected account's credentials are within their renewal window
- **WHEN** a poll runs
- **THEN** the account's credentials are renewed before its live-status query is issued

#### Scenario: Overlapping polls on one account

- **GIVEN** two polls for the same account start concurrently while renewal is needed
- **WHEN** both attempt to obtain a usable credential
- **THEN** only one renewal is performed
- **AND** both polls proceed using the resulting credential
