# TishOS app: bounded recurring calendar imports

Planning only. No app code, settings, journal or notes were changed for this plan.
The audited app is the clean Calendar Status worktree, version 0.21.13, branch
`fix/calendar-status-parity`, commit `465b8c1e5dc11cb92ddae48aa11999213ac62503`. References
below are relative to that app's `App/Imports` directory unless stated otherwise.

## Match the Controller contract

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
retaining 90 as the app's default. Controller defaults to 60 and offers 1–3660 days;
align the setting explicitly when comparing results. The journal currently rejects
windows longer than 370 days (`CalendarImportConfiguration.swift`, lines 210–214).
Supporting the Controller range therefore also requires updating that validation
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

Keep the Controller overlap guard in `CalendarImportCoordinator.swift` (lines
126–138) and `CalendarImportNoteWriter.swift` (lines 332–370). EventKit IDs and
Controller's canonical ICS IDs are not proven equivalent. This feature does not
make concurrent importers safe. Move import ownership deliberately; any future
cross-provider adoption needs an explicit, validated identity mapping before the
guard can change.

The app's own journal already lives in local, backup-excluded Application Support
(`CalendarImportCoordinator.swift`, lines 23–35; `RecordRelayPersistence.swift`,
lines 20–31). Keep selection there. No TPS API, vault mailbox, synced service note
or Controller/plugin dependency is needed. Advance through the existing running-Mac
60-second sync cadence (coordinator lines 113–123), manual sync and existing app
lifecycle hooks. This is not a promise of background execution while the Mac sleeps
or iOS suspends the app.

One configuration gap must be addressed before claiming taxonomy parity: property
keys and lifecycle labels are configurable, but `calendar-event` is still a fixed
kind value in `CalendarImportConfiguration.swift` (lines 138–143), writer ownership
checks (lines 93–95, 249–252, 289), journal validation (configuration line 229),
and some `VaultSnapshotBuilder.swift` paths (lines 3614–3620, 3646–3650).
`TPSNativeRecordProjection.swift` (lines 937–958) already recognizes reserved
`tishos-calendar:` identities with another valid public kind; it must remain intact.
Add a configured kind value, freeze it with pending batches, and update the fixed
writer/journal/reader checks. Preserve previous journal-owned
records rather than orphaning them after a setting change.

The app journal currently has no provider-version comparison equivalent to
Controller's source-revision gate. Do not pretend it does or copy an ICS revision
check without EventKit evidence. Selection uses a complete successful EventKit
observation frozen with the batch; source-version support would be a separate
provider contract investigation.

## Tests and rollout

1. Port Controller's selector fixtures: active/future/end boundaries, canceled
   next instances, per-source isolation, deterministic ties, zero duration,
   detached moves, DST/all-day events and sparse-series window limits.
2. Test legacy configuration and pending-batch decode; retries retain selection
   across rollover and preserve completed batch receipts. Test metadata/file
   conflicts and authored body/status/history preservation.
3. Retain a full observed batch with only one new recurrence chosen. Verify no
   false missing/deleted classification and no duplicate notes on repeated sync.
   Measure source reads, selected creations and unchanged writes separately.
4. Test disappearance/permission failure before staging, explicit cancellations,
   preexisting extra future notes, custom keys/kind values, and the Controller guard.
5. On a synthetic subscribed ICS calendar, move one detached occurrence and cancel
   another in the actual provider. Check EventKit's original identity and returned
   cancellation behavior on Mac before enabling real-vault importing. Confirm
   settings layout on narrow/mobile screens without relying on a background timer.
6. Ship behind the explicit per-calendar choice. Keep current default behavior.
   Switch import ownership only after the identity/adoption plan is reviewed;
   adopting this bounded mode alone does not enable dual importers.
