# TPS Controller 1.4.0

One always-running desktop can now own the Plaid connection for paired phones, tablets, and desktops.

- Adds an encrypted, device-paired finance request queue with device-local configuration, SecretStorage keys, and durable journals.
- Serializes bank operations across reloads, retries temporary failures, resumes hosted sign-in, repairs missing responses, and retires expired transport files.
- Saves exchange receipts to prevent blind replay of a one-time token exchange. Missing or corrupt state pauses processing.
- Adds host setup, pairing, pause/resume, refresh interval, status, client unpairing, and direct Finances handoff within Advanced.
- Preserves all existing settings, commands, local bank connections, and other Controller functions.

This is a backward-compatible minor release. Minimum Obsidian: **1.12.3**.

## Setup and compatibility

Update **both TPS Controller and TPS Finances to 1.4.0** on every participating device. On the desktop that already owns the bank connection, choose the Controller role and use **Controller → Advanced → Finance server → Use this Controller**. Configure its local Plaid credentials, export a pairing code, then import that code on each other device. Keep `_assets/TPS Finance Relay` included in vault sync. Connect/Reconnect/Sync/Disconnect remain in **Finances → Connections**.

The host must stay awake with Obsidian and vault sync running. Delivery follows vault-sync latency; there is no public listener, tunnel, automatic host failover, or OS background daemon. Hosted sign-in opens in the browser; return to Obsidian to receive completion. Imported notes use ordinary vault sync. Existing independent bank connections are preserved and are not automatically merged. Pairing codes grant access to this shared connection and must remain private.

Physical iPhone/iPad sign-in and production institutions remain device acceptance tests. This release was tested in the isolated test vault and is ready for the user's BRAT pull; it is not installed in production. Plaid product/OAuth access and charges remain governed by the user's Plaid account.

## Validation

- `npm test`: **475 passed, 0 failed; 3 existing optional historical-baseline comparison tests skipped** because their separate comparison checkout was not configured. All 16 new transport tests passed.
- Separate final `npm run build`: passed; `[runtime-deploy] target=test`, final deployed files match the release artifacts.
- Test-vault plugin reload verified version 1.4.0 and API version 1. Final Controller/Finances settings handoffs, native pairing dialog, keyboard dismissal/focus, paused/user-role host guard, and mobile-emulated request controls were inspected through computer use.
- Real Plaid Sandbox Hosted Link: synthetic First Platypus Bank OAuth completed; 4 account notes and 241 transaction notes imported into an isolated fixture. Fixtures were archived, mobile emulation disabled, temporary pairing removed, and existing runtime settings hashes remained unchanged.
- Independent simulated devices cover encryption/tampering, delayed delivery, restart, retry bounds, exchange interruption, role/pause guards, stale heartbeat, unpairing, and cleanup/replay.

## SHA-256 of tested release artifacts

| Artifact | SHA-256 |
| --- | --- |
| `main.js` | `ec581a7aa6c5286f4d623db070dbfeb600df507cc4371d0f236ad93bb3928961` |
| `manifest.json` | `1a0d4d7792e5d84862bfeae8c567fcaca898a2a8fd73fd546fffcf7d69265f94` |
| `styles.css` | `49f1ed583fbff50249f07cba2dd36e114087cea9a237a2b8b5adc6ebb88a93ca` |
| `styles-ui.css` | `8129e84100c4a03a967083f1021744d5fa4530adb239e1ca07beadf0f9f6126b` |
