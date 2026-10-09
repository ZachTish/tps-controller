# TishOS app: bounded recurring calendar imports

Planning only. No app code, settings, journal or notes were changed for this plan.
The audited app is the clean Calendar Status worktree, version 0.21.13, branch
`fix/calendar-status-parity`, commit `465b8c1e5dc11cb92ddae48aa11999213ac62503`. References
below are relative to that app's `App/Imports` directory unless stated otherwise.

## Independent app configuration

The goal is equivalent recurring-event choices implemented independently in
TishOS. The calendar import path must not reference TPS Controller, read its
settings or service files, inspect its identifiers, call its APIs, or require it
to be installed. The app owns its settings, EventKit observation, journal and note
writer. There is no shared runtime contract or configuration synchronization.

This plan adds recurring-event settings and removes the existing plugin-specific
checks that conflict with standalone operation. It does not add cross-importer
adoption, deduplication, schema migration or a new transport.

## Recurring-event choices

Add a per-source option: **All occurrences in import window** (legacy default) or
**Current + next occurrence**. Current means an active interval:
`start <= sampledSyncTime < end`. Keep overlapping active instances. Next is the
earliest noncanceled instance with `start > sampledSyncTime`; break ties with the
stable original occurrence identity. An ended instance remains a historical note.
Canceled instances never occupy the next slot. Nonrecurring events are unchanged.
Ordinary sync creates no ended recurring instances; explicit historical backfill
may create ended noncanceled instances. Already-owned history remains reconciled.

Apply this limit to new recurring notes, not to source observation or updates of
already-owned notes. An existing rescheduled occurrence may still need a successor
note under its configured preservation policy. Preserve authored content, status
ownership and identities. Do not delete healthy existing future notes when the
mode changes. A separately reviewed one-time migration is needed if the user
wants to prune earlier full-window imports.

## Settings and source window

`CalendarImportConfiguration.swift` (configuration: lines 23–65) needs a mode keyed
by selected EventKit calendar ID, with old persisted configurations decoding to
all. `CalendarImportSettingsView.swift` (selected sources: lines 23–30) should show
the native picker beside each selected calendar, including while sync is off.

`CalendarImportReader.swift` currently queries past 14 days and future 90 days
(lines 15–23, 49–76). Make its lookahead configurable through the existing settings,
retaining 90 as the app's default. A proposed app-owned range is 1–3660 days;
validate it independently in the app. The journal currently rejects
windows longer than 370 days (`CalendarImportConfiguration.swift`, lines 210–214).
Supporting this range therefore also requires updating that validation
to a bounded lookahead plus the existing past window, while retaining the 5,000-
event fail-closed limit and validating old pending batches. Do not expand the
reader alone. Next only exists when the
source returns it inside this window. Do not claim support for an annual next
occurrence from a 90-day query. No additional query loop or timer is needed.

## Preserve the complete observation and durable selection

`CalendarImportCoordinator.sync` (lines 84–107) reads EventKit and stages a durable
pending `CalendarImportJournal.Batch` before writing notes. Keep all observed rows
in `Batch.events`. At staging, sample time once, group recurring rows by calendar
ID and external series identifier, and freeze the selected new occurrence IDs.
Persist that choice with the existing frozen configuration; a pending batch must
replay the same choice after a crash, including across a time boundary. Legacy
pending batches have no selection and retain all-occurrences behavior.

`CalendarImportNoteWriter.apply` must check the selection only before creating an
unowned recurring note. Continue updating every existing owned occurrence and
its configured reschedule successor. Its missing-event inference (lines 215–235)
must use the complete observed identity set, not the selected creation set.
Otherwise valid unselected occurrences are falsely treated as deleted.

Use the existing stable identity `(calendarID, externalID, originalOccurrence)`
from `CalendarImportConfiguration.swift` (lines 118–120). Rank moved exceptions
by actual start/end; do not use those mutable dates as a new source identity or
expand another local recurrence series.

## Cancellation, ownership and standalone operation

The reader already aborts if a selected calendar disappears or becomes unreadable.
An absent EventKit row is not a cancellation tombstone. Keep the default no-delete
policy for absence, and retain configurable lifecycle labels for returned canceled
events. Real subscribed-ICS cancellation coverage still needs verification.

The audited app currently contains plugin-specific checks. They are a mismatch
with the intended standalone design, not a requirement to preserve:

- Remove `CalendarImportCoordinator.checkControllerOverlap` (lines 126–138) and
  its calls during enable and sync (lines 72, 93, 105). It currently reads another
  plugin's `data.json` and rejects enabled external calendar settings.
- Remove the other-importer identity rejection and duplicate-quarantine exception
  from `CalendarImportNoteWriter.discover` (lines 358–370). Discover only the app's
  own `tishos-calendar:` identities using its configured identity keys; unrelated
  notes do not block enabling or syncing the app.
- Remove the plugin-specific setup warning in `CalendarImportSettingsView.swift`
  (line 100) and replace the corresponding guard tests with standalone-operation
  tests. Keep conflicting/unknown/duplicate app-owned identity checks (writer
  lines 371–375), destination collision checks and journal protections.

These changes establish independence, not cross-provider identity equivalence.
Do not promise that separate importers will deduplicate one another, and do not
introduce compatibility lookups to try to achieve that in this feature.

The app's own journal already lives in local, backup-excluded Application Support
(`CalendarImportCoordinator.swift`, lines 23–35; `RecordRelayPersistence.swift`,
lines 20–31). Keep selection there. No plugin API, vault mailbox, synced service
note or plugin dependency is needed. Advance through the existing running-Mac
60-second sync cadence (coordinator lines 113–123), manual sync and existing app
lifecycle hooks. This is not a promise of background execution while the Mac sleeps
or iOS suspends the app.

Keep the app's existing configured property keys, lifecycle labels, note schema
and identity format. Changing kind values or taxonomy readers is separate from
these recurring-event settings. The app journal currently has no provider-version
comparison. Selection uses a complete successful EventKit observation frozen
with the batch; source-version support would be a separate provider investigation.

## Tests and rollout

1. Add app-owned selector fixtures: active/future/end boundaries, canceled
   next instances, per-source isolation, deterministic ties, zero duration,
   detached moves, DST/all-day events and sparse-series window limits.
2. Test legacy configuration and pending-batch decode; retries retain selection
   across rollover and preserve completed batch receipts. Test metadata/file
   conflicts and authored body/status/history preservation.
3. Retain a full observed batch with only one new recurrence chosen. Verify no
   false missing/deleted classification and no duplicate notes on repeated sync.
   Measure source reads, selected creations and unchanged writes separately.
4. Test disappearance/permission failure before staging, explicit cancellations,
   preexisting extra future notes and configured property keys/lifecycle labels.
   Verify app importing works without any plugin installation or settings files;
   unrelated other-importer notes must not cause plugin-specific rejection.
5. On a synthetic subscribed ICS calendar, move one detached occurrence and cancel
   another in the actual provider. Check EventKit's original identity and returned
   cancellation behavior on Mac before enabling real-vault importing. Confirm
   settings layout on narrow/mobile screens without relying on a background timer.
6. Ship behind the explicit per-calendar choice. Keep current default behavior.
   The app remains an independent importer. Cross-importer adoption or identity
   matching is outside this recurring-event settings change.
