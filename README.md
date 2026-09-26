# TPS Controller

## 2.6.0 — Connections in one place

Open **Connections** for **Banks & Wallet**, **AI**, **TishOS devices**, or **Food databases**. Apple Wallet setup, bank connect/sync/reconnect/disconnect, pending sign-ins and import history are together. **Bank setup · This device** holds hosting/pairing, automatic refresh, request-folder controls and Plaid credentials. It starts expanded on an unconfigured device. Paired clients do not need the host's Plaid secrets. Changing pairing or credentials refreshes the affected controls immediately. Apple permission and initial Wallet import still happen in the native TishOS app; new Wallet connections write on the iPhone and do not require bank pairing.

The top-level destinations are Overview (default), Connections, Calendar rules, Note rules, Reminder rules, Automations, and Advanced. Calendar feeds and attachment sync retain their existing Controller workflow pages, with direct buttons from Connections. Overview keeps its visible Wallet shortcut. TishOS command pairing/catalog actions moved from Overview to Connections → TishOS devices. Advanced now contains field mappings and diagnostics only.

Update Controller first, then **Finances 1.9.0**, **AI Gateway 0.10.0**, and **Health 3.4.0**. Controller does not bundle or enable those plugins. Finances still owns provider normalization and the account/transaction note writer; AI Gateway still executes AI requests; Health still performs food lookups. This release consolidates connection configuration and controls without rewriting those tested service contracts.

The connection editor API is `api.connectionSettings = { version: 1, render(parent): dispose }`. Controller mounts one editor at a time and disposes it on navigation/hide. Provider-specific editors retain the existing save paths, runtime adapters, commands, and device state. No keys, tokens, pairing authority, queued requests, connection IDs, sync cursors, or note mappings are copied or reset. No connection or provider test runs merely from opening settings. Missing/outdated plugins produce an upgrade/enable message instead of a duplicate configuration surface.

Settings inventory: added Connections and its transient provider selector; moved existing bank/Wallet controls from Advanced; moved TishOS devices from Overview; retained calendar, reminder, archive, attachment, mapping, and diagnostic controls. Retired circular Open Finances/Open Controller connection links. One bank-setup disclosure and AI's existing Diagnostics disclosure are never nested. Native buttons use aria-pressed, visible focus, restored selector focus, and horizontally scrolling selectors; narrow controls wrap. No navigation fields are persisted. Minimum Obsidian remains 1.12.3. This additive API/settings consolidation is a minor release.

See [connection ownership audit](CONNECTIONS.md) and [release validation](release-notes/2.6.0.md) for preserved/retired controls, tests, final build, isolated test-vault deployment, reload, UI verification, limitations, and hashes. Production installation remains the user's BRAT pull.

## Previous releases (historical settings locations)


## Visible Wallet connection — 2.5.2

**Overview → Connect Apple Wallet** is available immediately, before Device role,
on desktop and mobile. The same action remains in Advanced beside bank settings.
It opens TishOS's Wallet settings only; it does not grant account permission or
start bank automation. TishOS 0.18.2 (152) exposes the action on its home screen
even without a linked vault, and starts setup with Choose vault or Connect Apple
Wallet. Confirm the destination and Apple accounts to begin the initial import.

The six destinations, default Overview, device role, bank hosting/pairing,
request-folder editing, legacy Stop, status and Finances handoff are retained.
No persisted settings, defaults or disclosure levels change. Native Obsidian
buttons retain keyboard semantics and existing narrow-screen wrapping. Focused
regressions cover default-page placement and working mobile/desktop URL actions;
the full suite passes 588 cases with three existing opt-in skips and no failures.
Test-vault desktop and mobile-emulated UI show the action on Overview and
Advanced; settings remain editable without bank pairing. A separate final build,
test deployment and reload verify the released artifact. Production installation remains the user's BRAT pull.

## Initial Wallet handoff recovery — 2.5.1

A first-time legacy handoff can retry its acknowledgement after a disk or sync
failure even if Controller never imported Wallet records. Once the writer is
durably retired, that exact saved owner is sufficient to resend its receipt;
active legacy imports still require their original history. A regression test
reproduces the failure and verifies restart recovery with bank sync paused.
All 2.5.0 setup/UI behavior remains unchanged. Use 2.5.1 or newer for setup.


## Wallet setup on iPhone — 2.5.0

Advanced now separates **Apple Card & Savings** from **Bank connections**.
Open Apple Wallet goes directly to TishOS 0.18.1 (151)'s Wallet screen. New
connections need no finance-host pairing: confirm the vault, choose Apple
accounts/history, and the iPhone starts the initial note import automatically.
Bank hosting and bank pairing remain independent.

Existing relay users choose **Finish setup and import** on the iPhone. It sends
an authenticated one-time request. The original Controller completes any active
legacy write, durably retires its Wallet importer, and then acknowledges; the
phone resumes the same journal and imports automatically. Keep Controller 2.5.0+
open for this handoff once. It can retire the writer while bank service is paused
without enabling bank sync or requiring the Finances backend. Lost replies are
retried, wrong producers/requests and corrupt state stop the handoff, and a
retired writer cannot be enabled again. Rollback to a pre-2.5.0 Controller after
handoff is unsupported. Real Apple permission remains a user action on iPhone.

Settings inventory: all six hub routes and Overview default remain. Apple Wallet
has one direct setup entry, separate from bank pairing. Desktop folder editing,
bank refresh, service pause/resume, host setup, pairing, unpairing and Open
Finances remain. Mobile omits desktop-only hosting/folder editing; paired clients
can still replace their pairing code and unpair on either platform. The previous Wallet enable toggle is intentionally retired; an already
enabled importer retains **Stop old importer**. No UI route/disclosure state is
persisted. Native Setting buttons keep keyboard semantics and existing wrapping
mobile CSS. Runtime retirement is stored in the device-local finance config;
its encrypted request/receipt use the existing paired request folder.

Focused tests cover mobile/desktop actions, independent handoff/retry state and
an in-flight legacy write. Full tests, final build/deploy/reload, visual QA and
public release evidence are recorded in `release-notes/2.5.0.md`. Test-vault QA
reloaded 2.5.0, inspected all six destinations, the separate bank pairing dialog,
and the Wallet entry on desktop and a 393 px panel using Obsidian mobile
emulation. Focus restoration and native button semantics remain intact. The
original runtime data hash and unconfigured finance service were preserved.
Native phone renderings and synthetic first imports were verified in TishOS;
physical Apple account authorization remains a user/device acceptance step.


## Calendar write-batch reduction — 2.4.3

Full identity and destination checks still run, but unchanged calendar notes no
longer enter the mutating batch. Only real property, identity, path, create and
archive changes are applied. GCM replans the reduced batch against the same
snapshot and must preserve every previously validated destination. Repeated
missing-event handling also preserves an already archived note's archive date.
This reduces interruptions from unrelated vault writers and automatic renamers;
real source changes during an actual write batch still fail closed and need retry.
No settings, defaults, identity formats or API requirements change.

Tests cover zero write batches on settled repeat sync, a new occurrence beside
unchanged owners, stable archive timestamps, and the existing stale-token, exact
payload, interrupted-write and reschedule cases. Test-vault installed validation
uses synthetic records and GCM's real planner/writer. This patch does not disable
background services or weaken write guards. Production backfill verification is
separate from test-vault release acceptance.

Validation: 578 passing checks, three existing optional comparison skips, zero
failures; 103 focused native-calendar checks. TypeScript and the separate final
build passed and deployed to the test vault. Named-vault plugin reload and real
Controller 2.4.3/GCM 3.2.1 QA verified no write batch for an unchanged repeat, one
create-only batch beside an unchanged owner, preservation of an unrelated invalid
note, and rejection of duplicate calendar ownership. Fixtures were archived from
Inbox and test settings were preserved. This version is a BRAT handoff; it has not
been installed or accepted in production.


## Calendar creation recovery — 2.4.2

Calendar reconciliation now uses GCM's optional conflict-aware snapshot capability
(available in GCM 3.2.0). Invalid unrelated records no longer prevent all event
creation. GCM still reserves every conflicting identity globally; Controller stops
on canonical calendar IDs, calendar kinds, legacy calendar ownership, schedule
stamps, or unreadable conflict evidence. It never repairs or rewrites unrelated
notes. Older GCM versions retain the existing strict snapshot behavior; update both
plugins for this fix. No saved setting or default changes.

The snapshot and every recovery/post-write snapshot use the same guard. Regression
coverage includes unrelated invalid records, calendar conflicts, missing diagnostic
payloads, duplicate/blocked owners, identity reservations, and repeat-sync stability.
Malformed YAML and unreadable vault files still stop reconciliation.


## Calendar reliability follow-up — 2.4.1

Extended testing of 2.4.0 reproduced four issues: a one-hour error near DST
transitions without Moment Timezone, a DTEND in a different timezone using the
start zone, unknown explicit zones becoming machine-local times, and numbered
calendar filenames being compacted repeatedly after a sibling renamed. Real-vault
QA also caught Controller undoing another plugin's settled filename on repeat sync.

The timezone fallback now validates candidate instants on both sides of a
transition, chooses the first repeated wall time and the pre-gap offset for an
explicit nonexistent time, and formats midnight as hour 00. Feed-local VTIMEZONE
remains available to detached exceptions. Unresolved explicit zones fail the feed
rather than change meaning on another device. DURATION keeps nominal days/weeks
separate from elapsed hours/minutes/seconds; DTEND supplies a fixed duration for
recurrences. Existing correct filenames, including collision suffixes, remain
stable while GCM still owns root/layout resolution. Once the imported title and
schedule match the saved baseline, Controller adopts the settled filename instead
of repeatedly overriding the vault's filename automation. An external title or
schedule change still requests the new readable name. No settings or defaults change.
The first sync can correct an affected previously imported time; with keep-old
history enabled, that correction can retain an additional historical note.
This is a backward-compatible patch; minimum Obsidian remains 1.12.3.

The expanded [calendar reliability record](docs/calendar-sync-validation.md)
contains the regression matrix, replay coverage, results and remaining limits.
It includes 100 seeded permutations of 25 series; a 120-step native-record replay
with moves, cancellations/restoration, failed downloads and manual edits; failure
injection after all six writes of a three-event reschedule; four device timezones;
and a 2,600-occurrence timezone/recurrence fixture. Synthetic results do not replace
real-provider and physical-device acceptance. The app migration remains a proposal;
this release changes Controller only.

Final validation: 567 tests pass, three existing optional comparison skips, zero
failures; TypeScript and the separate production build pass. The final 2.4.1 runtime
was reloaded via the named test-vault CLI. Real Controller/GCM file checks passed for
six colliding event names, title-only changes, three byte-identical repeat syncs,
failed-feed archive safety, reschedule actions, one replacement and stale-response
protection. GCM discovery was scoped to the synthetic folder to exclude unrelated
intentional conflict fixtures. Existing test-vault filename automation stayed active.
All fixtures were moved directly from Inbox to `_archive`; Controller and GCM
settings hashes stayed unchanged and outbound automation stayed disabled. Production
was not accessed. Release notes include the tested artifact hashes for BRAT.

Validation (2026-09-23): the full declared suite, focused identity-conflict tests,
TypeScript, and final production build pass. Test-vault CLI reload verifies the
versioned artifacts. Installed Controller/GCM QA creates an event beside an
incomplete unrelated record, repeats with zero creates and unchanged bytes, and
rejects a duplicate calendar owner before writing. The unrelated note stays
byte-identical. Synthetic fixtures were archived directly from Inbox; settings
and outbound automation were preserved. This is a BRAT handoff, not evidence of
production installation or user acceptance.

## Deterministic calendar reschedules — 2.4.0

**Calendar rules → select a calendar → On external reschedule** configures property
updates for the **Current note** and **Retained old note** independently. Add an
update, enter a property and value, then **Save property updates**. For example,
set the retained note's `status` to `rescheduled`, and set the current note's
`project` to `xyz`. Existing properties are replaced; missing properties are
inserted. Values accept text, numbers, booleans and JSON lists of text. Updates
apply to Native TPS event records, with GCM's existing native-record API v6.
Old-note updates require **Keep old note when externally rescheduled**. Current-note
updates also work with that option off, updating the existing note in place.

Actions run once when the imported start, end or all-day timing changes after a
baseline sync. Local edits, title-only changes, first import and cancellation do
not trigger them. Repeat syncs preserve subsequent manual edits to these custom
properties. Identity, calendar timing, recurrence and other provider-owned fields
are protected; custom properties and workflow status are supported. Drafts are
saved explicitly and running syncs retain their original configuration snapshot.
No existing setting, default, command or destination was removed. The six existing
hub destinations and Overview default remain; the editor is flat inside the
selected calendar, with actions above rows, keyboard labels/focus and wrapping,
stacked mobile controls. Only per-calendar `rescheduleActions` is persisted.

Calendar parsing now groups components by UID before relating exceptions. The
previous library default attached exceptions from unrelated series, and repeated
master components could expand more than once. Controller selects the latest
SEQUENCE/LAST-MODIFIED/DTSTAMP revision, collapses identical repeats and rejects
conflicting equal revisions. A moved occurrence retains its original RECURRENCE-ID;
THISANDFUTURE applies only to its own series, and an exception's copied RRULE never
starts another series. Reordering a feed does not change the planned occurrences.
Malformed, incomplete or expansion-limited feeds fail the fetch rather than
appearing as successful empty/partial calendars to missing-event handling.
Structured parser logs report components, series, exceptions, discarded revisions,
outcome and duration without event bodies.

Native records track imported revision information in `tpsCalendarSync`; older
revisions of the same master/exception are ignored. A master and an exception have
separate revision origins. Retained-note generation IDs derive from occurrence,
existing history and imported timing, so retrying an interrupted retirement uses
the same planned identity. Moving back later still creates a distinct generation.
The existing snapshot/preflight checks reject ambiguous ownership or concurrent
edits. Controller strips `recurrenceRule`, `recurrence` and `rrule` from imported
native templates and reconciles those keys off managed calendar instances: the
external feed owns their recurrence. Other properties and note content remain.

**Limits:** providers must retain UID and original RECURRENCE-ID for a moved
occurrence. Replacing a UID or rewriting an entire master schedule without
recurrence exceptions can describe a new set of occurrences; Controller does not
infer matching from titles or dates. Equal-rank conflicts within a feed are errors;
across fetches, changed timing with unchanged revision metadata is still accepted
for providers that omit revision bumps. Existing production duplicates are not
deleted or merged. Property actions/history are native-note features; legacy notes
and inline tasks retain their existing storage behavior. Use one Controller device.
This backward-compatible feature warrants a minor version; Obsidian remains 1.12.3+.

**Automated validation:** 553 passing tests, three existing optional comparison
skips, zero failures; TypeScript and the production build pass. Regression tests
cover cross-series isolation, duplicate revisions and feed order, single/range
reschedules, UTC/TZID identity, all-day EXDATE/RDATE, failed fetches, actual parser-to-
record reconciliation, property upserts, templates, stale responses and interrupted
retries. The build deploys only to the test vault. Runtime/UI verification on 2026-09-23 used the named test vault after a CLI plugin
reload to 2.4.0. The actual settings editor saved two typed property actions and the
keep-old toggle against an isolated, disabled fixture with a stub save handler.
Desktop controls, accessible labels and save feedback were inspected; mobile CSS
stacks and wraps controls, but physical iPhone acceptance remains user testing.
The real parser, Controller and GCM wrote three recurring notes in Inbox; moving
one instance created exactly one replacement, updated the old status, inserted the
new project, and preserved old content/path/identity. Reordered duplicate input
created nothing and preserved a subsequent manual project edit. GCM discovery was
scoped to the fixture folder because historical test fixtures intentionally contain
identity conflicts. Fixtures were archived directly to `_archive`, runtime settings
were restored, both Controller/GCM data.json hashes stayed unchanged, and automation
remained off. No production feed, notes or settings were accessed. Artifact hashes
are recorded in the public release notes; 2.4.0 is ready for the user's BRAT pull,
not installed in production by this task.

## Previous Wallet relay — 2.3.0 (superseded by direct iPhone import)

**Advanced → Finance server → Import Apple Wallet · This device** enables the
approved native TishOS iPhone app to send balances and transaction history to this
Controller. Requires TPS Finances 1.8.0 in Atomic note mode and TishOS 0.17.0.
Set up the finance host, enable Wallet import, privately copy its pairing code,
and enter it in TishOS → Apple Wallet on one iPhone. The app separately confirms
the named vault and asks Apple for the accounts and dates. No Plaid connection
or credential is needed for Wallet. Existing Plaid connections stay independent.

The configurable finance request folder must remain included in vault sync.
AES-256-GCM envelopes authenticate the collection and each transfer path. A
bounded hash manifest, immutable parts, one producer identity and increasing
sequence prevent incomplete, altered or replayed imports. Controller durably
claims a batch before writes and acknowledges only after Finances finishes;
the phone commits its history cursor only after that acknowledgement. Partial
transfers and note writes resume with the same identities. Receipts live in
this device's SecretStorage; the Wallet toggle is local, off by default and
preserved while paused. Missing/corrupt state pauses import rather than starting
over. Error retries are bounded to at most one attempt per minute; ordinary
relay polling remains every four seconds. Wallet errors do not stop bank sync.

Apple IDs are device-local: use one exporting iPhone. Replacement-phone and
lost-state migration are not automatic. Missing accounts or restricted history
never imply deletion. Explicit deleted/rejected transactions use Finances'
normal trash behavior. The app retires its acknowledged encrypted parts; notes
remain ordinary vault content. Pause cannot recall transfers already delivered.
The existing secret pairing code grants finance connection authority and must
remain private. macOS, iPad and other vault devices read the resulting notes.
The native app needs a Files-accessible copy of that vault; it cannot read an
Obsidian-only iOS container. Neither background iOS refresh nor vault sync has
a guaranteed delivery deadline.

**Settings inventory:** all six hub destinations, Overview default, existing
finance controls and commands remain. One local toggle is added alongside host
refresh/pairing controls. Native toggle keyboard semantics and the existing
wrapping narrow layout apply; no extra disclosure or shared setting is added.

**Validation:** focused relay tests cover encryption, missing/tampered parts,
interrupted imports, durable acknowledgement, replay, alternate producers,
sequence gaps, disable races and a Wallet-only host without Plaid. The full suite reports 532 passes and three existing
opt-in comparison skips (zero failures). The separate production build deploys
only to the test vault; CLI reload verifies 2.3.0. The actual Advanced settings
were inspected with an in-memory, disabled host fixture: all six destinations
and prior controls remain, the new toggle is keyboard-focusable, and no real
configuration or outbound automation was enabled. Both plugin data.json hashes
remained unchanged. Native narrow/accessible Wallet screens were inspected. Real Apple-account authorization
and comparison remain the user's iPhone acceptance step. This is a minor feature
release; minimum Obsidian stays 1.12.3. Production installation is the BRAT handoff.


Device roles, calendar synchronization, reminders, encrypted attachment sync, and shared Plaid transport.

Current release: [2.4.1](https://github.com/ZachTish/tps-controller/releases/tag/2.4.1) · Obsidian 1.12.3+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-controller` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Configure Controller

The settings hub contains Overview (default), Calendar rules, Note rules, Reminder rules, Automations, and Advanced. Controller/User is a device role: select the device that should run shared automation. Pairing, attachment enrollment, and periodic reload preferences are local to each device.

- Configure calendar sources in Calendar rules and maintenance in Automations. Calendar views themselves belong to TPS Calendar Base.
- Configure reminder rules in Reminder rules. Inline-task eligibility can follow GCM's Atomic note/Atomic line mode, require the task's own scheduled value, or use an explicit override.
- Configure **Advanced → Plaid** for TPS Finances 1.3.0+. Environment, credential references, and OAuth redirect URI are marked **This device**. Secret values stay in Obsidian SecretStorage. Finances owns institution linking, account records, and ledger reconciliation.
- Attachment sync preserves local files and ordinary links. It uses encrypted GCS objects, device enrollment, and a recovery key; it is independent of Controller/User role. Markdown, Canvas, Bases, configuration, hidden files, and excluded paths stay outside this attachment collection.

## Preserve externally rescheduled notes — 2.2.0

In **Calendar rules**, select a calendar and enable **Keep old note when externally rescheduled**. This optional per-calendar setting defaults off and applies to **Native TPS event records**. Legacy note imports and inline Daily Note tasks retain their existing behavior. Native synchronization requires TPS GCM native-record mode/API v6; minimum Obsidian remains 1.12.3. This is a backward-compatible minor release.

After a baseline sync, a feed change to an occurrence's start, end, or all-day timing keeps the previous note at its existing path with its existing identity, authored properties, status and body, and creates a fresh note for the new schedule. The new note uses the calendar's current template/defaults. Title-only changes, local note date edits and cancellation notifications do not create history. Normal feed synchronization can still overwrite a locally edited date. Existing notes without a saved baseline establish it on their first sync after enabling; Controller does not guess at earlier reschedules. Matching relies on the provider retaining the event UID and, for recurring exceptions, the recurrence identity. A changed UID is treated as a different event.

Only the current generation receives subsequent updates, cancellation and missing-event handling. Retained notes stay ordinary visible notes; they are not archived automatically. Turning the option off resumes in-place updates on the current generation while leaving history alone. Moving an event back to an earlier time creates another distinct note. GCM allocates collision-safe filenames. The reserved `tpsCalendarSync` frontmatter object stores the opaque logical occurrence ID and last imported timing; `retired: true` marks retained history. Do not remove or edit this tracking data. It follows vault sync, survives restarts, and is stripped from copied template defaults. Ambiguous active generations or cross-source ownership stop the batch before mutation.

Creation/template/property planning completes before retiring a note. GCM's existing snapshot-bound batch protects against concurrent edits; if an interruption occurs after retirement, a later sync creates the missing current generation without reclaiming history. This is not a cross-device transaction: use the designated Controller device for automatic sync. The setting is editable alongside the calendar's existing controls without adding a new route, disclosure, command or navigation state; the existing mobile settings layout applies. Physical iPhone acceptance remains user testing.

Focused regression coverage includes external versus local edits, default-off and baseline behavior, repeated moves, cancellation/restoration, template preservation, recurring exceptions, filtered events, missing-event handling, disabling the option, interrupted retries and ambiguous ownership. Validation on 2026-09-20: 523 checks passed, with three existing optional skips; TypeScript, the separate production build, test-vault deployment and plugin reload passed. The actual settings checkbox was toggled on a synthetic disabled calendar using an isolated save handler, leaving real settings unchanged. A synthetic feed exercised the real Controller and GCM services against Inbox files: a local date edit created no duplicate, an external reschedule preserved the old note's body/status/path/ID and created a new note, and a repeat sync remained idempotent. Existing unrelated identity-conflict fixtures blocked a whole-vault snapshot, so file-level QA scoped GCM discovery to the synthetic folder; normal global conflict safeguards remain unchanged. Background filename automation was allowed to settle between checks. All fixtures were archived directly into _archive. No external feed or production vault was accessed. Artifact hashes are recorded in the release notes.

## Command-driven note rules — 2.0.0

**Note rules** replaces the per-calendar automatic Tag control. This is a major release because calendar synchronization deliberately stops appending that tag. Existing tags remain. Old configured calendar tags become manual rules scoped to their recognized calendar source; their old setting remains retained but inactive. Invalid legacy tag drafts are retained disabled for review. Atomic calendar IDs and legacy calendar external IDs identify those notes. Inline checkbox tasks are not edited by this feature.

Create and save rules in **Controller → Note rules**. Run **TPS Controller: Preview Note Rules on Current Note** or **Preview Note Rules on Notes**, choose a note, folder (including descendants), or the entire vault, inspect the proposed changes, select notes, then Apply. Both Controller and User devices can run these commands. No creation, edit, startup, or import trigger invokes rules, and opening settings does not scan notes. No Finances, Health, or companion update is needed.

Example: match **Property → type → is → event** and **Note name → contains → xyz**, then **Set title and filename → 123**. The title action updates Controller's configured title property and renames the file in its existing folder through Obsidian's file manager. Existing internal links follow Obsidian's own link-update preference. Other actions replace literal title text, set/remove a custom property, or add/remove one tag. Property values accept text, numbers, booleans, and JSON lists of text. No scripts, regular expressions, filesystem moves, body edits, or note deletion are available.

Rules run in displayed order. Conditions always evaluate the original note, text comparisons ignore case, and title replacement is literal and case-sensitive. All/any conditions, existence/emptiness, numeric greater/less comparisons, list membership through equality, enable/disable, reordering, and stop-after-match are supported. Later actions win. Missing fields do not satisfy negative comparisons. The configured title property falls back to the filename only when absent/empty; **Note name** always means filename. Ordinary property names are explicit and configurable, including type/kind. IDs and GCM's configured identity/schema keys and identity tag prefixes cannot be rewritten; a configured title property cannot alias tags or a record identity. Conditions using **Calendar source ID** are primarily used by the migrated calendar-tag rules.

**Safeguards and limits:** preview reads current disk content, never stale metadata. Hidden/internal, development, dependency, archive and trash paths are excluded; GCM-protected templates, malformed/ambiguous YAML, and notes above 2 MiB are reported as skipped. Renames cannot cross folders, use unsafe filenames, overwrite existing paths, or collide by case/Unicode normalization. Competing destinations are flagged before writes. Exact content fingerprints and a frozen settings snapshot are checked before application, then again at the write boundary. A stale selected note rejects the initial batch. Only one preview/application runs per device; Controller periodic reload waits for it. Renames may update links in other selected notes; any subsequently stale note is reported for a new preview.

Application is per note, not a vault-wide transaction or a cross-device lock. A late disk/sync error reports unfinished work and never overwrites a collision. If properties save but a rename fails, the result says so; a fresh preview can finish the rename. Reusing a consumed or edited preview is rejected. Note bodies are preserved, though normal YAML serialization can reformat frontmatter and its comments. There is no Controller undo/history layer. A subsequent provider import can restore provider-owned values; manual rules do not override that import or run again automatically. Existing authored/template tags are not removed by retiring the calendar tag action.

**Settings contract:** all five existing destinations, commands, and unrelated controls remain; Note rules is the sixth destination. Add/Save/Reload/Preview actions precede the ordered rule list. Only one selected editor is visible, with flat condition/action rows and no nested disclosures. Draft edits and selected-rule/focus state are transient; only explicit Save persists the versioned shared `noteRules` configuration. Configuration changes do not mutate notes. Save, preview, and application reject stale rules when the saved configuration changed on disk; Reload saved rules explicitly refreshes it. The preview has one optional disclosure for skipped notes, paginates change cards in groups of 50, and preserves selections. Native labeled controls, pressed-state route/rule buttons, live status, visible focus, wrapping action bars, and stacked fields serve keyboard and narrow layouts. No settings navigation state is persisted.

Focused regressions exercise matching/order, migration, identity protection, YAML/body preservation, selection, collisions, stale or altered plans, races, partial rename failures, template protection, source resolution, and command-only wiring. The complete suite and a separate final production build/deploy are required before the BRAT release. Validation on 2026-09-18: the full suite passes 509 tests with three existing optional historical-comparison skips; 30 focused rule tests pass. A legacy Daily Note timing fixture now compiles its module before starting the simulated creation clock. TypeScript and the mandatory separate production build pass and deploy to the isolated test vault. The final version is reloaded there. All six settings destinations were inspected without changing unrelated settings or enabling outbound automation. Keyboard Save and Apply, a 400-pixel settings content pane, and a 390-pixel preview were checked in the UI. A synthetic event was renamed to 123.md, preserving its ID, tags and body; Obsidian updated its backlink, and an unrelated note was unchanged. A colliding second note was blocked. Fixtures were moved from Inbox to _archive, original rules restored, viewport overrides cleared, and the hash of all unrelated Controller settings remained unchanged. Physical iPhone/iPad testing is not implied by desktop viewport emulation.

## Configurable finance request folder — 1.5.0

**Advanced → Finance server → Request files folder** accepts a vault-relative folder such as `_system/TPS Finance Relay` or `_system`. The default remains `_assets/TPS Finance Relay`. This is a backward-compatible minor release; minimum Obsidian remains 1.12.3. The setting is local to each device's finance pairing. New host setup uses the entered folder; an existing host offers **Move files**. The move relocates only its `<collection-id>` subfolder. Other `_assets` content is untouched.

Before changing an existing connection, pause finance service on each device and allow vault sync to settle. Move it on the desktop host, export its new pairing code, then use **Update pairing code** on each client before resuming. Install Controller 1.5.0 on every participant first. Keep the destination included in vault sync. Reusing the same connection code updates the folder while preserving that client's device identity, key, pending requests, and pause state. Old codes without a folder retain the default. A different connection/key is rejected without replacing the existing pairing. A stale client left on the old folder cannot discover the move automatically and may recreate transport files there.

The host records its intended move before renaming. Restart completes a pending move without resetting the connection. Unsafe paths, file collisions, missing move sources, and ambiguous destinations stop the operation; existing files are never overwritten. Configuration remains editable while paused. Credentials and the operation journal remain device-local. AI request folders belong to TPS AI Gateway and have a separate setting.

The hub/default route, existing disclosures and controls remain unchanged. The new native text field and action stay in Advanced; paired clients show the current folder with an Update pairing code action. Focused transport regressions cover custom/legacy pairing, pending operations across a move, Unicode paths, unsafe paths/collisions, disk failure, restart after rename, and disabled-service editing.

Validation on 2026-09-18: all 20 focused finance transport checks pass. The full suite passes 479 checks with three existing optional historical-comparison skips. TypeScript and the production build pass. The versioned test runtime was reloaded; Advanced shows the editable folder while user-role hosting stays disabled. A synthetic real-adapter connection moved its collection beneath an Inbox fixture while paused, preserving the journal and status file; the fixture was archived afterward. No bank provider was called. Original device-local pairing and runtime data hashes were unchanged. Narrow layout behavior uses the existing settings CSS; physical mobile acceptance is not inferred from desktop QA.

## Shared finance server — 1.4.0

Install **Controller 1.4.0 and Finances 1.4.0** on every participating device. On the always-running desktop, choose the **Controller** role in Overview, configure **Advanced → Plaid**, then choose **Advanced → Finance server → Use this Controller**. Use the desktop that already owns your bank connections; its tokens and identity map stay in local SecretStorage. Do not independently reconnect the same banks on other devices.

Choose **Show pairing code**, then enter that code under the same Finance server settings on your iPhone, iPad, or other desktop. Pairing is explicit and local to each device. The code grants control of the shared finance connection; keep it private. Clients need no Plaid secret. Finances → Connections handles Connect, Reconnect, Sync, Disconnect, and resumable sign-in requests. The Controller settings handoff opens that destination directly.

The Controller remains the only bank importer. Phones open [Plaid Hosted Link](https://plaid.com/docs/link/hosted-link/) in their browser and return to Obsidian after signing in; the desktop retrieves completion through `/link/token/get`. No localhost callback, listening port, public tunnel, webhook receiver, or additional hosted server is required. The default scheduled refresh is every 15 minutes; manual-only, 30-minute, hourly, six-hour, and daily intervals are available. This retrieves data Plaid has available; it does not force the bank itself to update or request a paid Transactions Refresh.

**Transport and recovery:** vault sync carries AES-256-GCM-encrypted Markdown envelopes under `_assets/TPS Finance Relay/<collection-id>/`. Keep that folder included in the vault's sync. The queue works with ordinary Markdown synchronization; there is no direct device-to-device network dependency. Unique per-message nonces authenticate collection and path. Each client owns immutable request files; one pinned host owns responses and presence. Credentials, access tokens, Link tokens, and the durable operation journal stay in device-local SecretStorage. Envelopes contain encrypted actions, shared institution summaries, and short-lived hosted sign-in URLs—not plaintext bank tokens. Ledger notes still use your normal vault sync and its privacy settings.

Reconciliation polls every four seconds after the workspace is ready, has one active operation chain per local app (including reloads), and preserves pending requests before publishing them. Presence updates every 30 seconds and becomes stale after 90 seconds. Missing/corrupt local state or failed authentication pauses processing. Imports retain existing finance identities/cursors and refresh shared Finances settings before each run. Reconnect retains the existing Item. An uncertain public-token exchange is never automatically repeated: the host checks its saved receipt, otherwise reports an uncertain result for review. Network retries use bounded backoff; an already-created sign-in survives polling outages within its six-hour result-recovery window. Unstarted requests expire after 30 minutes; completed transport files are retired after their retention window. Receipt expiry prevents old synced requests from resurrecting.

**Limits:** Obsidian and vault sync must be running on the awake Controller. This is not an OS background daemon, instant push channel, high-availability cluster, or automatic host failover. Mobile must receive the encrypted response through vault sync before its sign-in button appears. Bank login/consent happens in the user's browser, not inside Obsidian. Restore the host's local bank state after loss; do not recreate a connection over an empty identity map. A client can unpair and enter a corrected code; unpairing does not disconnect banks or cancel requests already delivered. Existing independent connections on other desktops are not migrated or merged automatically. Production OAuth access still depends on the user's Plaid account and institution support.

**Settings contract:** the existing Overview, Calendar rules, Reminder rules, Automations, and Advanced hub is retained, with Overview the default. Finance setup extends Advanced without another nested disclosure. Host setup, pairing export/import, pause/resume, interval, status refresh, client unpair, and the Finances handoff are device-local controls; existing Plaid environment/secret references/OAuth controls remain. Pairing text is shown only in a dedicated modal. Buttons and inputs are native and keyboard accessible; existing narrow settings layout applies. No existing shared settings, commands, or note property names are removed.

**Validation:** 16 isolated transport tests cover independent devices, encrypted payloads, path replay/tampering, double taps, bounded retry, resume, late completion, uncertain exchanges, missing/corrupt state, role/pause guards, response repair, cleanup, unpair, and reload serialization. Finances adds hosted-provider and complete mobile-bundle coverage. A real Sandbox Hosted Link browser run completed the synthetic First Platypus OAuth flow and imported four account notes and 241 transaction notes in an isolated Inbox fixture. Desktop and mobile-emulated settings/request UI are checked after the final versioned build. Physical iPhone/iPad and real-bank acceptance remain device testing, not a claim made from desktop emulation. Test artifacts deploy only to the test vault; production installation is the user's BRAT pull.

## Integration and limits

The enabled plugin exposes `api.plaid` version 1 and `api.openPlaidSettings()`. Plaid requests are restricted to supported environments and endpoints. Unpaired devices retain the earlier direct Plaid transport. An explicitly configured finance host adds the shared service described below.

TishOS companion pairing is separate on every device. A published reminder schedule is not proof of physical notification delivery. Attachment sync's required large-file iPhone/iPad transfer acceptance remains a release gate; desktop or simulated tests do not establish mobile readiness. Bucket retention/soft-delete policies are independent of Controller cleanup. The old public-link uploader is retired.

See [historical implementation and validation reference](REFERENCE.md) for the detailed calendar, reminder, attachment, and migration contracts. Earlier entries describe their release at that time, not additional features of the current UI.

## Development and repository policy

`main` is the stable source line. Numeric tags identify immutable released artifacts. `optimization` is an unreleased work-in-progress lane; do not install it through BRAT or merge it into stable without separate validation.

The supported build lives inside `Obsidian Plugin Test Vault/Plugin Development`, with `TPS-Controller (Dev)` as the mapped stable source. These repositories depend on adjacent shared tooling including `deploy-runtime.mjs`; a standalone clone is not currently self-contained.

From the contained workspace, prepare dependencies using the shared helper, then run tests and a separate final build:

```sh
# From Plugin Development:
node ./prepare-dependencies.mjs "TPS-Controller (Dev)"
cd "TPS-Controller (Dev)"
npm test
npm run build
```

Dependencies stay in the vault's `.plugin-dev-cache.nosync` through a relative `node_modules` symlink. Use a clean, current checkout; preserve unrelated changes and never build an old dirty worktree into the test runtime. Stable builds deploy only shipped artifacts to the test vault. Optimization builds are build-only. Runtime `data.json`, secrets, caches, and session state never belong in Git.

Documentation-only maintenance does not create a new plugin version. Published release tags and assets are preserved. Do not rely on legacy version/release scripts without reviewing their current behavior. Production updates remain the user's BRAT handoff.

For prior feature details and release-specific evidence, see [REFERENCE.md](REFERENCE.md) and [GitHub releases](https://github.com/ZachTish/tps-controller/releases). The September 16 cleanup changes documentation and repository metadata, not shipped behavior.


## 2.1.0 — Confirmed current mappings

Advanced calendar title, status, previous-status, start and duration fields are drafts until Apply. GCM 3.0.0 supplies preview, confirmation, migration and recovery through propertyMappings v1. Matching enabled Calendar and Health mappings update with the GCM property references. Missing/older GCM blocks the change without saving. Calendar auto-creation pauses during an active mapping migration; an already-running sync prevents migration from starting.

Minor: adds confirmed migration to existing mapping controls. Existing navigation destinations, default routes, disclosures, commands, and persisted UI-state contract are unchanged. Mapping controls are plain inputs with an explicit Apply action and wrapping layouts; no alias editor is added. Cancel preserves the current mapping and notes.

Shared migrations change Markdown frontmatter only, preserve note bodies, reject occupied destinations and stale previews, and keep a local recovery copy until success. Inline fields, Base formulas, per-view configuration, and disabled plugins are not automatically rewritten; enable participating TPS plugins before a shared rename. Review historical records before relying on totals after upgrading. Health timing migration uses its existing guarded rollback flow; a process crash cannot provide a vault-wide atomic transaction. No migration or outbound service runs merely because the plugin is upgraded.

Validation covers current-only reads, migration-only historical inputs, cancellation, archived notes, conflicts, stale previews, save/write rollback, cross-plugin setting changes and identity protection. Required final validation: full declared suite, separate production build to the test vault, named plugin reload and settings confirmation checks. UI and final test results are recorded in the release notes. Minimum Obsidian compatibility is unchanged. Update GCM before applying Controller or Calendar mapping changes. The release is a BRAT handoff; production installation remains user-controlled.

Full declared suite: 509 checks passed, 3 optional/existing checks skipped, zero failed. TypeScript and separate final production builds pass and deploy only shipped artifacts to the test vault; targeted plugin reloads verify the installed versions. Test-vault validation (2026-09-20): Controller’s real Apply dialog previewed one synthetic Markdown note and two plugin mappings. Cancel preserved both mappings and the original file; confirming renamed the property and updated Controller and Calendar together, preserved the body, restored input focus, and removed temporary recovery. Original settings were restored and the fixture archived. GCM’s current kind key and migration controls were inspected. Calendar’s five rendered key inputs and Apply actions were verified. Health’s timing inputs were checked; an existing archived QA note with potentially relevant malformed frontmatter correctly blocked migration with a path-specific error and no changes. Successful Health confirmation, timing conversion, cancellation and rollback are covered by regression tests. No outbound automation was enabled. Existing mobile CSS/layout is retained; physical iOS testing remains user acceptance.

## 2.6.1 — Two-level frontmatter kinds

GCM owns the configured record classifications. Its existing `nativeRecordKindPropertyKeys` map accepts either a key string (unchanged behavior) or `{key, value, parentKind}`, for example a food-entry record mapped to `{key: "transactionKind", value: "food-entry", parentKind: "transaction"}`. These mappings are opt-in; upgrading never changes notes or classification settings automatically. The additive `api.frontmatterKinds` v1 exposes encode/decode/definition for domain writers. Canonical record IDs and internal domain kinds remain stable while notes store the selected parent and subtype. Current mappings are authoritative; this adds no watcher, automatic repair, or startup migration.

Health library-note creation uses that shared encoding; logged records continue through GCM's record writer. Finances uses it at its existing property read/write boundary for imports, manual entries, updates and generated Base filters, retaining its canonical internal finance types. Controller omits an unsolicited `status: scheduled`; explicit template statuses and cancellation statuses are preserved, and cancellation restoration can return status to absent. Calendar identity remains its stable ID while public kind/subkind fields belong to the note/template.

The user's one-time taxonomy migration is separate from shipped plugin behavior. It must update settings, existing notes, templates, embedded/standalone Base filters and presentation/hide rules together, with conflict checks, source snapshots and preserved identifiers/bodies. Empty optional properties are not created by the classification mapping. GCM custom-property definitions govern the properties panel; removing specialized nutrition/finance definitions does not delete their stored data. Existing settings destinations, disclosures and mobile layouts are unchanged. Physical iPhone acceptance remains outstanding. Full test/build and test-vault verification results are recorded in release notes.

Validation for 2.6.1 (2026-09-26): 592 checks passed; 3 explicitly skipped by the existing suite; TypeScript and production build passed. The installed test-vault plugins were reloaded by manifest ID after refreshing manifests. Synthetic API creation/update checks verified food-entry parent/subtype encoding, stable IDs, calendar template classifications, preserved calendar body and absent status, plus finance encoding/decoding. Temporary in-memory classification/root settings were restored without saving, and fixtures moved directly from Inbox to `_archive/Taxonomy QA 2026-09-26`. No external provider was called. Focused finance tests additionally cover investment round trips and dotted Base expressions with renamed keys. Final separate build/deployment and artifact hashes are recorded in the release notes.


## 2.6.2 — Reduce repeated notification calculations

Native notification publication serializes each candidate's comparison key once and groups occurrences by series before hashing audit identities. Previously the series audit hashed the same series once per repeat, including thousands of occurrences that could not fit the 128-item schedule. Every occurrence still participates in the existing selected-series due-time/cadence validation; conflicts beyond the selected 128 items still fail. Chronological/UTF-8 ordering, duplicate handling, live-series fairness, signatures, completion/snooze behavior, repeat cadence, horizon and refresh triggers are unchanged. No reminder setting, persisted cache, watcher, repair loop or note migration is added.

GCM 3.5.1 separately removes repeated property-profile resolution from Controller's full-vault event-matching path; install both patches for the measured improvement. Controller still projects up to 128 repeats per reminder and rebuilds the event-match index. This patch removes demonstrated redundant work without introducing an index invalidation scheme or changing notification policy.

Validation includes the command-bridge suite and a 21,504-candidate regression whose complete item/audit hash matches the installed 2.6.1 output; it also exercises duplicate candidates and inconsistent unselected repeats. Required validation is `npm test`, a separate `npm run build`, test-only deployment and targeted reload. Installed benchmarks directly call the pure item/audit builders with synthetic inputs; no pairing, credentials, external provider or outbound publication is used. Results and artifact hashes are recorded in release notes. Minimum Obsidian remains 1.12.3. This backward-compatible performance fix is a patch release; physical iPhone timing and production BRAT installation are separate.

Installed test-vault validation on 2026-09-26: the identical 21,504-candidate synthetic workload produced the same 128 items, one series and SHA-256 output digest before/after. Audit generation fell from 588.9 ms to 10.1 ms; item selection fell from 56.8 ms to 46.6 ms. These are one desktop before/after sample, not a device guarantee. All 593 declared-suite tests passed, with three existing optional historical-comparison tests skipped because no comparison checkout was configured. TypeScript and the separate production build passed. Targeted reload loaded 2.6.2. The clock override was restored, no publication was invoked, and runtime `data.json` remained byte-identical. No production artifacts or settings were changed.
