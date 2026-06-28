# TPS Controller

Controller-owned automation for TPS calendar sync, reminders, overdue items, and cross-device sync requests.

## Commands

- `Set as Controller (Automation Source)` sets the current device role to controller.
- `Set as Replica (Passive)` sets the current device role to replica/user.
- `Force Calendar Sync Now` runs calendar sync immediately on the controller device, or requests a controller-side sync from a replica.
- `Backfill Past Calendar Events` runs the explicit 14-day past-event backfill on the controller device only.
- `Clean Duplicate External Calendar Notes` archives duplicate external-event notes when they share the same external identity and have no body content worth preserving.
- `Review Calendar Sync Quarantine` opens the first quarantined orphan candidate and reports the candidate count.
- `Run Reminder Check Now` runs reminder evaluation immediately on the controller device, or requests a controller-side reminder pass from a replica.
- `Reset Reminder Delivery State` clears stored reminder alert/delivery state.
- `View Notifications` opens the Controller notification surface.
- `View Overdue Items (Modal)` opens the overdue-items modal.
- `Run Parent/Child Link Reconcile Now` runs the guarded GCM-backed parent/child maintenance pass on the controller device.

## Settings surface

- Device role: controller vs replica/user.
- External calendars: URL, color, enabled state, auto-create toggle, create-as mode, task destination, task target note, type folder, folder, tag, and template.
- Calendar sync rules: sync interval, no-loss sync mode, deletion behavior, archive folder, calendar filter, canceled status value, and shared frontmatter keys (`title`, `status`, previous status, start, end/duration).
- Reminder controls: enable reminders, hourly time-tracking reminders, poll interval, batch notifications, default all-day base time, global ignore lists, per-rule reminder definitions, and a recommended three-rule install/reset flow.
- Notification sort direction: choose oldest due items first or newest due items first for the notification sidebar and overdue reminder modal.
- Snooze: snooze property name plus configurable preset durations.
- Debug: logging toggle and alert-state reset.

## Calendar sync

- Normal calendar sync processes events from today forward. It does not backfill past external calendar events.
- Historical sync is explicit: run the `Backfill Past Calendar Events` command on the controller device to process the previous 14 days.
- `Force Calendar Sync Now` uses the normal non-backfill window.
- Task-mode calendar events are written as inline Markdown tasks in the configured target note.
- Task-mode calendar events keep external calendar identity in hidden `%% tps-inline-props:... %%` metadata instead of a visible `[tpsInlineProps:: ...]` inline field, so large source URLs/UIDs do not leak into rendered task text.
- External-event reminder matching indexes both event-note frontmatter and inline task calendar payloads, so synced task-mode events are not re-emitted as unmatched external reminders.
- Calendar identity matching scans the whole vault for `externalId`, legacy event id, UID/start, event URL, and title/day matches before creating anything. This prevents duplicate event notes if an existing synced file was moved out of the configured calendar folder.
- Orphan quarantine/delete handling remains limited to configured sync roots and non-ignored paths, so moved notes are recognized for matching without being treated as managed cleanup targets.
- Calendar sync settlement ignores Obsidian/plugin/internal storage paths such as `.obsidian/**`, `.tps/**`, `.trash/**`, and TPS line-base virtual files. Real vault content such as notes and attachments still delays sync until vault events settle.

## Reminder completion

- Completing a task-level reminder updates both the inline task status metadata and the Markdown checkbox marker.
- Calendar task reminders therefore move from `- [ ]` to `- [x]` when completed from the notification/reminder UI.
- Reminder target parsing treats Markdown checkbox markers as task status, so `[x]` is complete and `[-]` is wont-do even if inline status metadata is missing.
- The notification view exposes direct complete and wont-do actions so mobile/iPad users do not have to rely on the status menu.
- The overdue reminders modal uses explicit check and x icon actions for complete and wont-do. Action rows are removed optimistically, duplicate clicks are ignored while the mutation is running, follow-up refreshes keep just-completed rows suppressed until the backend stops returning them, and the modal preserves scroll position while rerendering. Right-clicking a reminder row still opens the full Obsidian file context menu.
- Task-line reminders are independent reminder entities. A checkbox task with an inline reminder property such as `[scheduled:: ...]` is discovered even when the containing note has no matching frontmatter property, and the task checkbox marker supplies the task entity status instead of inheriting parent note status.
- Reminder task discovery ignores fenced Markdown/code examples, so documentation snippets such as ```md blocks containing checklist syntax do not become actionable reminders.
- Completing a note-level reminder now routes through GCM's guarded status setter when available, so notes with open checklist items trigger the incomplete-checklist modal before `status: complete` is written.
- Open checklist/task lines are reminder targets even when they inherit the note-level reminder date. If task rows match a reminder rule, both the reminder delivery engine and notification view show the actionable task rows and suppress the parent note row for that same reminder.
- Task-mode reminder rows do not show the note status pill. They show a schedule-resolution action instead: explicit inline schedule values are cleared from the task line, note-level schedules are cleared from frontmatter, and inherited note/daily-note task schedules prompt for a target note and move the task block there. Clear scheduled actions require a confirmation modal before mutating reminder metadata.
- Task-mode reminder rows carry the original raw Markdown task line. Move/update actions only trust the saved line number when it still resolves to that same task; otherwise they fall back to the raw line and then the cleaned task title so daily-note edits do not move the wrong checkbox line.
- When an inherited Daily Note task is moved from the reminder UI, Controller inserts the original task block into the selected target file unchanged, then keeps the Daily Note block in place with the root checkbox marked and `[completedDate:: null]`. This preserves Daily Notes as scratchpad/inbox records while still making the actionable task live in the destination note.
- Notification sidebar move/clear actions now report whether they actually changed a task before removing the row. Failures show an Obsidian notice, and Controller debug logging includes source path, target path, line number, and title breadcrumbs for move-note troubleshooting.
- Notification sidebar titles render Obsidian markdown links inline, so task text like `[[Note|Label]]` is clickable instead of displayed as raw markdown.
- Notification sidebar task rows use a task icon rather than inheriting the containing note/file icon. Note rows still use their configured note icon/color with a `file-text` fallback.
- Notification sidebar actions are overlaid on the right edge so long titles can use the full row width instead of truncating before the action buttons.
- Notification sidebar refreshes are coalesced so metadata events, file-updated events, and action follow-up refreshes do not stack multiple full reminder scans/redraws. The periodic passive refresh runs every 30 seconds, unchanged item sets skip redraw, and slow refreshes are logged when Controller debug logging is enabled.

## Reminder delivery

- When Batch Notifications is enabled, all reminders triggered in the same run are delivered as one grouped notification.
- Grouping includes timed reminders, all-day reminders, and unmatched external calendar reminders.
- When Batch Notifications is disabled, each reminder is delivered individually.

## Integration surface

- Controller publishes namespaced workspace events for controller role/settings changes, calendar sync start/completion, reminder updates, and file updates.
- Legacy TPS event aliases remain exported for migration compatibility.
- Controller exposes a plugin API with `isController`, `getRole`, `getSettings`, `getCalendarSettingsSnapshot`, `getReminders`, `getOverdueItems`, and `snoozeFile`.
- Calendar integration uses TPS Calendar Base settings as a fallback source for external calendar definitions and respects Calendar Base hidden-external-event state when building unmatched external reminder candidates.
- Global Context Menu integration is used for shared external identity helpers, file-updated event emission, guarded status writes, and parent/child maintenance when the GCM API is available.
- Notifier integration remains optional: Controller falls back to local Obsidian notices when TPS Notifier is unavailable or exposes no send API.

## Validation

- 2026-06-24: `npm test` passed (contract tests, identity-field tests, reminder-engine tests, and nested build).
- 2026-06-24: `npm run build` passed.
- 2026-06-25: Daily Note reminder moves now preserve a checked `[completedDate:: null]` source copy while copying the original task block into the selected target file. Added notification sort direction (`Oldest first` / `Newest first`) and regression coverage in `scripts/test-reminder-engine.mjs`; validation: `npm test`.
- 2026-06-25: Overdue reminder modal complete/wont-do actions now suppress completed rows across follow-up refreshes, disable duplicate clicks during mutation, and restore modal scroll position after render. Added regression coverage in `scripts/test-reminder-engine.mjs`; validation: `npm test`, production build, and Obsidian reload.
- 2026-06-26: Notification sidebar reminder titles now render inline markdown links with `MarkdownRenderer`, while row-level navigation ignores link clicks so Obsidian can open the linked target. Added regression coverage in `scripts/test-reminder-engine.mjs`; validation: focused reminder-engine test, `npm run build`, and Obsidian reload.
- 2026-06-27: Notification sidebar task rows now render a dedicated task icon instead of the containing note/file icon. Added regression coverage in `scripts/test-reminder-engine.mjs`; validation: `npm test`, `npm run build`, and Obsidian reload/UI check.
- 2026-06-27: Notification sidebar action buttons now overlay the right edge of each row, allowing long titles to extend underneath the buttons before row-edge truncation. Added regression coverage in `scripts/test-reminder-engine.mjs`; validation: `npm test`, `npm run build`, and Obsidian reload/UI check.
- 2026-06-28: Task-mode external calendar sync now writes hidden comment metadata for calendar identity and reminder matching reads that format. Migrated existing visible `tpsInlineProps` task metadata in the vault; validation: `npm test`, production build, and Obsidian reload/UI check.
- 2026-06-26: Reminder task candidate and target parsing now skip fenced code blocks, preventing documentation examples with `[scheduled:: ...]` from surfacing as live reminder tasks. Added source and executable fixture coverage in `scripts/test-reminder-engine.mjs`; validation: focused reminder-engine test and `npm run build`.
- 2026-06-24: Added regression coverage for calendar sync settlement path filtering so plugin/config/internal writes do not make calendar sync wait or participate in readiness.
- 2026-06-13: built with `npm run build`.
- 2026-06-14: reminder target parsing now surfaces open checklist/task rows that inherit note-level reminder context. Reminder delivery and overdue dedupe suppress parent note rows when matching task rows exist, and suppressed parent alert state is reset so hidden daily-note notifications do not keep reappearing.
- 2026-06-14: task-mode notification rows now replace the status pill with a schedule-resolution action, using the reminder property source to choose between clearing schedule metadata and moving inherited daily-note tasks to another note.
- 2026-06-20: notification sidebar task move/update resolution was validated against stale daily-note line numbers; the controller now resolves by matching task identity instead of blindly using the old row index.
- 2026-06-20: notification sidebar move-note actions now return a success flag, keep rows visible after canceled/failed moves, and show a user-facing failure notice instead of failing silently.
- 2026-06-20: notification sidebar lag pass coalesced refreshes, removed immediate post-action full scans, and added slow-refresh breadcrumbs.
- 2026-06-20: notification sidebar Clear scheduled action now opens a confirmation modal before clearing task or note schedule metadata.
- 2026-06-22: task-line reminder discovery now includes files with active inline reminder properties on checkbox task lines even when parent note frontmatter lacks the reminder property.
- 2026-06-22: task reminder entities now keep parent note status as `noteStatus` and use checkbox-derived `status`/`checkboxStatus`/`taskStatus` for reminder filtering.
- 2026-06-13: verified overdue external calendar task cleanup left zero open overdue calendar tasks in `Areas/Calendar.md`.
- 2026-06-13: verified note-level reminder completion delegates to GCM before falling back to direct frontmatter writes.
