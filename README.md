# TPS Controller

Device roles, calendar synchronization, reminders, encrypted attachment sync, and shared Plaid transport.

Current release: [1.3.0](https://github.com/ZachTish/tps-controller/releases/tag/1.3.0) · Obsidian 1.12.3+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-controller` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Configure Controller

The settings hub keeps Overview, Automations, Reminders, and Advanced separate. Controller/User is a device role: select the device that should run shared automation. Pairing, attachment enrollment, and periodic reload preferences are local to each device.

- Configure calendar sources and maintenance in Automations. Calendar views themselves belong to TPS Calendar Base.
- Configure reminder rules in Reminders. Inline-task eligibility can follow GCM's Atomic note/Atomic line mode, require the task's own scheduled value, or use an explicit override.
- Configure **Advanced → Plaid** for TPS Finances 1.3.0+. Environment, credential references, and OAuth redirect URI are marked **This device**. Secret values stay in Obsidian SecretStorage. Finances owns institution linking, account records, and ledger reconciliation.
- Attachment sync preserves local files and ordinary links. It uses encrypted GCS objects, device enrollment, and a recovery key; it is independent of Controller/User role. Markdown, Canvas, Bases, configuration, hidden files, and excluded paths stay outside this attachment collection.

## Integration and limits

The enabled plugin exposes `api.plaid` version 1 and `api.openPlaidSettings()`. Plaid requests are restricted to supported environments and endpoints. The service does not introduce scheduled finance calls.

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
