# TPS Controller

Device roles, calendar synchronization, reminders, encrypted attachment sync, and shared Plaid transport.

Current release: [1.5.0](https://github.com/ZachTish/tps-controller/releases/tag/1.5.0) · Obsidian 1.12.3+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-controller` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Configure Controller

The settings hub keeps Overview, Automations, Reminders, and Advanced separate. Controller/User is a device role: select the device that should run shared automation. Pairing, attachment enrollment, and periodic reload preferences are local to each device.

- Configure calendar sources and maintenance in Automations. Calendar views themselves belong to TPS Calendar Base.
- Configure reminder rules in Reminders. Inline-task eligibility can follow GCM's Atomic note/Atomic line mode, require the task's own scheduled value, or use an explicit override.
- Configure **Advanced → Plaid** for TPS Finances 1.3.0+. Environment, credential references, and OAuth redirect URI are marked **This device**. Secret values stay in Obsidian SecretStorage. Finances owns institution linking, account records, and ledger reconciliation.
- Attachment sync preserves local files and ordinary links. It uses encrypted GCS objects, device enrollment, and a recovery key; it is independent of Controller/User role. Markdown, Canvas, Bases, configuration, hidden files, and excluded paths stay outside this attachment collection.

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
