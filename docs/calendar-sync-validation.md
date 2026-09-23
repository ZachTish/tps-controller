# Calendar sync reliability validation — 2.4.1

Validated on 2026-09-23. This record describes tested behavior, not a guarantee for
all providers, file providers, devices or feed rewrites. Only synthetic feeds and
the isolated Obsidian Plugin Test Vault were used. No production calendar or note
was read, rewritten, merged or removed.

## Findings and fixes

The additional tests reproduced DST conversion errors, incorrect mixed-zone end
times, silent machine-local interpretation of unknown timezones, and repeated
collision-suffix renames. Embedded VTIMEZONE testing also reproduced ICAL.js's
standard-time preference during a repeated hour; the parser now applies the
RFC 5545 first-occurrence/pre-gap rules to both embedded and IANA timezone paths.
Real-vault QA exposed a further interaction: Controller was undoing the vault's
settled filename automation on repeat sync. It now adopts that filename when the
imported title and schedule already match. A genuine external title or schedule
change still requests a readable name; GCM owns the root and layout.

DTEND defines an exact recurring duration. DURATION days/weeks remain wall-clock
units, while hours/minutes/seconds are elapsed time. Consequently P1D can differ
from PT24H across DST. Unknown explicit TZIDs without usable embedded definitions
fail the fetch. Floating events still use the device's local timezone by design.

## Automated evidence

The complete Controller suite reports **567 passes, 3 existing optional comparison
skips, 0 failures**. The focused parser/native-record suites contain 115 tests.
TypeScript and the mandatory separate production build pass.

| Coverage | Evidence |
| --- | --- |
| Feed ordering and duplicate revisions | 100 seeded shuffles of 25 recurring series; all produce the same 75 occurrence objects |
| Recurring identity | Single moves, THISANDFUTURE, explicit overrides, copied RRULEs, EXDATE/RDATE, all-day dates and cross-series isolation |
| Stateful convergence | 120 operations across 12 logical records, mixing moves, title edits, cancellations/restoration, 24 failed fetches, manual property edits and repeated syncs |
| Interrupted writes | Failure after each of six retirement/create boundaries for three moved events; retry produces exactly the originally planned three generation IDs |
| Timezones | Four device zones; spring/fall transitions, midnight, repeated/nonexistent times, mixed start/end zones, elapsed/nominal durations, custom VTIMEZONE and UTC exceptions across DST |
| Feed failure | HTTP 401/404/500, rejected network request, timeout, incomplete document and equal-rank conflicting revisions return failure, not a successful empty feed; later valid fetch recovers |
| Volume | 100 weekly zoned series expand into 2,600 unique correctly timed occurrences; diagnostic Node timing is reported by the test and is not an Obsidian/iPhone benchmark |
| Existing safeguards | Stale metadata, concurrent edits, preflight rejection, protected notes, identity collisions, cancellation persistence, failed saves, source ownership and single-flight execution remain covered |
| Stable files | Collision suffixes and another plugin's settled filename survive unchanged repeats; new external titles still rename |

The replay checks both note count and one active generation per logical occurrence.
After manual property edits, repeating an unchanged successful sync preserves the
complete snapshot. Failure-injection tests model GCM's batch contract; they do not
simulate every operating-system crash or iCloud conflict.

## Final artifact test-vault verification

CLI confirmed Obsidian Plugin Test Vault and Controller role User, then reloaded
2.4.1. No configured outbound feed was enabled. The real parser, Controller and GCM
were exercised with in-memory feed responses and actual Markdown files under Inbox.
GCM discovery was scoped to that synthetic folder because unrelated historical QA
fixtures intentionally contain identity conflicts. Normal ownership/preflight checks
remained active, as did the test vault's existing filename automation.

The final run passed:

- DST start and mixed-zone end conversion in the shipped Obsidian runtime.
- Six distinct events with colliding titles; a title-only change creates no history.
- Three repeats preserve every resulting path and Markdown byte.
- A failed feed preserves every byte with archive-on-missing configured.
- One external move creates exactly one replacement; old/current property actions apply.
- An older feed revision preserves the latest generation and all existing files.
- Controller/GCM data.json hashes remain unchanged; test settings remain disabled.

Initial real-vault runs intentionally failed the filename-stability assertion and
led to the settled-name fix. Their synthetic notes and the final accepted fixtures
were all moved directly to `_archive`. No synthetic content remains in Inbox.
The separate final build deploys only shipped files to the test runtime; public
release notes record hashes of the exact validated artifacts.

## Remaining acceptance and upgrade effects

- No live Google/Outlook/Apple account or production feed was tested in this run.
  Real-provider fixtures and physical iPhone/iCloud acceptance remain separate.
- Changed UIDs or rewritten master schedules without original recurrence identifiers
  cannot be safely matched by title/date. Existing duplicate notes are not auto-merged.
- Failed/incomplete feeds cannot justify inferred absence. A valid successful empty
  feed can still invoke the user's configured missing-event policy.
- One designated Controller remains required. Snapshot validation is not a cross-device
  distributed transaction, and a suspended app cannot promise timely execution.
- The first post-upgrade sync can correct an affected previously imported time. If
  keep-old history is enabled, that correction can retain an additional historical
  note; no note is silently deleted to conceal the correction.
- This release does not migrate calendar sync into TishOS. A future migration should
  preserve existing event identities, compare mutation plans against these fixtures,
  keep one writer, and run in read-only comparison mode before ownership changes.

Timezone semantics reference: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html),
sections 3.3.5, 3.3.6 and 3.8.5.3.
