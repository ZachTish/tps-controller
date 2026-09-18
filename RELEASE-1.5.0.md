# TPS Controller 1.5.0

Adds **Advanced → Finance server → Request files folder**. Keep the existing default, use `_system/TPS Finance Relay`, or choose another vault-relative folder. Existing hosts move only their own collection using a recoverable move journal. Keys, device identity and pending operations are preserved. Unsafe paths and collisions are rejected.

Pause finance service on all devices, update Controller everywhere, move on the host, then update the pairing code on clients before resuming. Keep the destination included in vault sync. Older pairing codes retain the default. Stale clients do not automatically discover a move.

Validation: 20 focused relay tests; full suite 479 passed with three existing optional historical-comparison skips. TypeScript, a mandatory separate final build, test-vault deployment/reload, settings inspection and a synthetic real-adapter folder move passed. Local configuration and runtime data were preserved; no provider call or production installation occurred. Minimum Obsidian: 1.12.3. Finances remains compatible with 1.4.0.

Tested in **Obsidian Plugin Test Vault** and ready for the user’s BRAT pull. This additive feature uses a minor version. Production was not accessed.

## SHA-256

```text
c5f01bf457a925ca852b68a52a02a7d6f2849de4c04e4e32e4fbebe594a2da9d  main.js
bb979635b2ee11a23a8901b7ed1cdf86d436ac190af34e58055571c9714d1012  manifest.json
49f1ed583fbff50249f07cba2dd36e114087cea9a237a2b8b5adc6ebb88a93ca  styles.css
8129e84100c4a03a967083f1021744d5fa4530adb239e1ca07beadf0f9f6126b  styles-ui.css
```
