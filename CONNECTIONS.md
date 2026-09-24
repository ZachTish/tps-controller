# Connection ownership audit — September 24, 2026

Read-only inspection of the enabled TPS plugins and settings in TishOS v0.2 informed this change. Production settings, pairing, credentials and notes were not edited. Implementation and QA use Obsidian Plugin Test Vault.

| Plugin | Settings ownership after cleanup |
| --- | --- |
| Controller | Connection setup/controls: banks and Wallet, AI, food databases, TishOS devices. Existing calendar-feed and attachment-sync pages remain linked from Connections. |
| Finances | Markdown records, destinations, categorization, budgets and property mappings. Dashboard Connections hands off; quick Sync remains. |
| Health | Food/workout logging, nutrient goals, library and record mappings. Food-database credentials and Describe AI configuration hand off. |
| AI Gateway | Request execution/capability API; configuration editor appears in Controller. |
| Calendar | Already delegates feeds/import rules to Controller. View/rendering/filter/default-creation preferences stay in Calendar. |
| Global Context Menu | Shared record/property schemas, menus, note interaction and Navigator rules. No external credential setup to move. |
| Notebook Navigator | Local navigation, presentation and upstream settings import. These are not external service connections. |
| Linter | Local Markdown/filename cleanup and safety scope. No external connection controls. |

Not active in v0.2: Kanban, Watchlist, Messager. They were not changed. Third-party BRAT, Templater and Advanced URI retain their own settings.

## Removed from the settings flow

- Finances' empty Plaid setup route and duplicate Connections route.
- Old Finances instructions to turn on the retired Wallet importer.
- Circular Finances → Controller → Finances connection handoffs.
- Health's separate Provider credentials disclosure and indirect AI configuration hop.
- AI Gateway's duplicate standalone provider editor.
- Bank setup hidden under Advanced; TishOS pairing/catalog management mixed into Overview.

## Retained deliberately; candidates for a separate removal decision

- Atomic-line record modes and their routing controls: v0.2 uses atomic notes, but these still read existing records. Removing them needs an explicit migration/deprecation plan. Hide irrelevant controls progressively before deleting support.
- Finances' legacy localhost Plaid Link adapter: retained for existing unpaired desktop flows and command compatibility. Hosted Controller relay is the preferred multi-device path; retiring the adapter requires a transition test for existing local Items.
- Legacy Wallet relay: retained only to drain existing imports and complete the authenticated phone-writer handoff. Removing it now could strand an in-progress import.
- Health's legacy barcode Shortcut inbox: no longer a scanner UI choice; remove only after checking whether any existing automation still writes to it.
- GCM's historical build-date heading and long introductory explanation: unnecessary settings copy, suitable for its next isolated UI cleanup, not grounds for moving its note schema controls.

## Contract and state

Controller calls version-1 `connectionSettings.render(parent)` on enabled Finances/Health/AI Gateway APIs. It owns navigation and lifecycle; the domain adapter owns validated operations and saves. No secret values cross this UI contract. This is not a new server, secret store, or duplicate sync engine. Existing background behavior and permissions are unchanged. Missing/incompatible adapters show their required versions. Bank pairing and credentials stay device-local; Health's USDA reference names remain shared, while their secret values remain device-local. No navigation/disclosure state is persisted.

The settings inventory, accessibility/mobile behavior and validation are summarized in each owning README and release notes. All four releases must be updated together, Controller first. Physical iPhone bank authorization and Apple Wallet consent were not performed during this configuration-only test.
