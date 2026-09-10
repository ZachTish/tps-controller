import { App, Modal, Notice, SecretComponent, Setting } from "obsidian";
import type TPSControllerPlugin from "../../main";
import { generateRecoveryKey, normalizeRecoveryKey, randomId } from "./crypto";

class AttachmentKeyModal extends Modal {
    constructor(app: App, private readonly action: "import" | "export", private readonly existing: string,
        private readonly save: (value: string) => Promise<void>) { super(app); }
    onOpen(): void {
        this.titleEl.setText(this.action === "import" ? "Import recovery key" : "Attachment sync recovery key");
        this.contentEl.createEl("p", { text: "Use the same recovery key on every device. Store a separate copy securely; Controller cannot recover encrypted files without it." });
        const input = this.contentEl.createEl("textarea", { cls: "tps-controller-attachment-sync-key" });
        input.setAttribute("aria-label", "Attachment sync recovery key");
        input.spellcheck = false;
        input.autocomplete = "off";
        input.value = this.existing;
        if (this.action === "export") {
            input.readOnly = true;
            new Setting(this.contentEl).addButton(button => button.setButtonText("Copy key").onClick(async () => {
                await navigator.clipboard.writeText(input.value);
                new Notice("Recovery key copied. Keep it somewhere secure.");
            }));
        } else {
            new Setting(this.contentEl).addButton(button => button.setButtonText("Import key").setCta().onClick(async () => {
                try { await this.save(normalizeRecoveryKey(input.value)); input.value = ""; this.close(); }
                catch (error) { new Notice(error instanceof Error ? error.message : "Could not import recovery key."); }
            }));
        }
        input.focus();
    }
    onClose(): void { this.contentEl.empty(); }
}

export function renderAttachmentSyncSettings(container: HTMLElement, plugin: TPSControllerPlugin): () => void {
    const service = plugin.attachmentSyncService;
    const settings = () => plugin.settings.attachmentSync;
    const section = container.createDiv({ cls: "tps-controller-attachment-sync-settings" });
    section.createEl("h3", { text: "Sync attachments" });
    if (settings().schema !== 1 || settings().provider !== "gcs") {
        section.createEl("p", { text: "These attachment sync settings require a newer Controller version. They have been preserved; other Controller features remain available." });
        return () => {};
    }
    section.createEl("p", { text: "Keep attachments and other files locally on every device, with encrypted Google Cloud Storage sync. Obsidian Sync continues to own notes, canvases, bases, plugins, and settings." });
    const status = section.createDiv({ cls: "tps-controller-attachment-sync-status", attr: { role: "status", "aria-live": "polite" } });
    const progress = section.createDiv({ cls: "tps-controller-attachment-sync-progress" });
    const warnings = section.createDiv({ cls: "tps-controller-attachment-sync-warnings" });
    const refreshStatus = () => {
        const state = service.getStatus();
        status.setText(state.message);
        progress.setText(state.result ? `Last pass: ${state.result.uploaded} uploaded, ${state.result.downloaded} downloaded, ${state.result.deleted} removed locally, ${state.result.pending} pending.` : "");
        warnings.empty();
        for (const warning of state.warnings) warnings.createEl("p", { text: warning });
    };
    refreshStatus();
    const dispose = service.subscribe(refreshStatus);
    const run = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); }
        catch (error) { new Notice(error instanceof Error ? error.message : "Attachment sync action failed.", 10000); }
        refreshStatus();
    };
    const save = async () => { service.stop(); await plugin.saveSettings(); service.start(); };

    new Setting(section).setName("Sync now").setDesc("Reconcile additions, edits, and deletions on this device.")
        .addButton(button => button.setButtonText("Sync now").setCta().onClick(() => run(() => service.runNow())));
    new Setting(section).setName("Enable attachment sync").setDesc("Shared master switch. Each device must also join with its own credentials and the recovery key.")
        .addToggle(toggle => toggle.setValue(settings().enabled).onChange(async value => { settings().enabled = value; await run(save); }));
    new Setting(section).setName("This device").setDesc("Join after entering the connection and recovery key. Pausing preserves local files and queued changes.")
        .addButton(button => button.setButtonText("Join / resume").onClick(() => run(async () => {
            settings().enabled = true; await save(); await service.enroll("join");
        })))
        .addButton(button => button.setButtonText("Pause this device").onClick(() => run(() => service.pauseDevice())));
    new Setting(section).setName("Create an encrypted collection").setDesc("First device only. Creates a collection ID and recovery key if none are configured, then uploads local files.")
        .addButton(button => button.setButtonText("Create collection").onClick(() => run(async () => {
            service.stop();
            if (!settings().collectionId) {
                const id = randomId();
                const secretName = `tps-controller-attachment-sync-${id}`;
                const key = generateRecoveryKey();
                plugin.app.secretStorage.setSecret(secretName, key);
                if (plugin.app.secretStorage.getSecret(secretName) !== key) throw new Error("SecretStorage did not confirm the recovery key.");
                settings().collectionId = id;
                settings().recoveryKeySecretName = secretName;
            }
            settings().enabled = true;
            await save();
            await service.enroll("create");
            new Notice("Collection created. Export its recovery key and import it on your other devices.", 12000);
        })));

    section.createEl("h4", { text: "Connection" });
    const text = (key: "endpoint" | "bucket" | "prefix" | "collectionId", label: string, description: string) => {
        new Setting(section).setName(label).setDesc(description).addText(component => {
            component.setValue(settings()[key]);
            component.inputEl.setAttribute("aria-label", label);
            const commit = () => run(async () => { settings()[key] = component.getValue().trim(); await save(); });
            component.inputEl.addEventListener("blur", commit);
            component.inputEl.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void commit(); } });
        });
    };
    text("endpoint", "GCS endpoint", "Google Cloud Storage XML endpoint, normally https://storage.googleapis.com.");
    text("bucket", "Bucket", "Reuse the existing bucket. Sync writes encrypted objects in its own namespace.");
    text("prefix", "Sync folder", "A dedicated object prefix, separate from old public uploads.");
    text("collectionId", "Collection ID", "Shared across devices. Changing it requires joining the selected collection again.");
    const secret = (key: "accessKeySecretName" | "secretKeySecretName" | "recoveryKeySecretName", label: string, description: string) => {
        new Setting(section).setName(label).setDesc(description).addComponent(element => new SecretComponent(plugin.app, element)
            .setValue(settings()[key]).onChange(async value => { settings()[key] = value; await run(save); }));
    };
    secret("accessKeySecretName", "Access key", "Select this device's Google Cloud Storage HMAC access key.");
    secret("secretKeySecretName", "Secret key", "Select this device's matching HMAC secret.");
    secret("recoveryKeySecretName", "Recovery key", "Select this device's copy of the shared encryption key.");
    new Setting(section).setName("Transfer recovery key").setDesc("Key values are stored in device-local SecretStorage, never in synced Controller settings.")
        .addButton(button => button.setButtonText("Import key").onClick(() => {
            new AttachmentKeyModal(plugin.app, "import", "", async value => {
                const reference = settings().recoveryKeySecretName;
                if (!reference) throw new Error("Choose a recovery-key secret name first.");
                const existing = plugin.app.secretStorage.getSecret(reference);
                if (existing && normalizeRecoveryKey(existing) !== value) throw new Error("That secret already contains another key. Select a different secret name before importing.");
                service.stop();
                plugin.app.secretStorage.setSecret(reference, value);
                if (plugin.app.secretStorage.getSecret(reference) !== value) throw new Error("SecretStorage did not confirm the imported key.");
                service.start();
            }).open();
        }))
        .addButton(button => button.setButtonText("Export key").onClick(() => {
            const value = plugin.app.secretStorage.getSecret(settings().recoveryKeySecretName);
            if (!value) { new Notice("No recovery key is stored in the selected secret."); return; }
            new AttachmentKeyModal(plugin.app, "export", value, async () => {}).open();
        }));
    new Setting(section).setName("Excluded paths").setDesc("One vault-relative file or folder per line. Excluding content stops syncing it; it does not delete existing copies.")
        .addTextArea(component => {
            component.setValue(settings().excludedPaths.join("\n"));
            component.inputEl.setAttribute("aria-label", "Excluded attachment paths");
            component.inputEl.addEventListener("blur", () => run(async () => {
                settings().excludedPaths = component.getValue().split("\n").map(value => value.trim()).filter(Boolean);
                await save();
            }));
        });
    section.createEl("p", { text: "Newest recorded edit or deletion wins, without conflict copies. Deletions made while Obsidian is closed are recorded at the next scan. Remote changes use this device's configured trash behavior; Controller keeps no cloud history." });
    section.createEl("p", { text: "Turn off image, audio, video, PDF, and other attachment syncing in Obsidian Sync on each device. Already-synced files remain in its remote storage until you reclaim that space separately." });

    section.createEl("h4", { text: "Restore old uploads" });
    section.createEl("p", { text: "The old public-link uploader and source archiver are retired. Preview recognized uploads before restoring local files and links; cloud originals are removed only after verification." });
    const migrationPreview = section.createDiv({ cls: "tps-controller-attachment-sync-migration" });
    new Setting(section).setName("Legacy attachments")
        .addButton(button => button.setButtonText("Preview restoration").onClick(() => run(async () => {
            const preview = await service.previewLegacy();
            migrationPreview.empty();
            migrationPreview.createEl("p", { text: `${preview.items.length} recognized uploads. ${preview.unfinished.length} items need attention.` });
            for (const item of preview.items) migrationPreview.createEl("p", { text: `${item.sourcePath} — ${item.size === null ? "unavailable" : `${item.size} bytes`}` });
            for (const issue of preview.unfinished) migrationPreview.createEl("p", { text: issue });
        })))
        .addButton(button => button.setButtonText("Restore recognized uploads").onClick(() => run(() => service.restoreLegacy())));
    const verification = section.createEl("details");
    verification.createEl("summary", { text: "Device verification" });
    verification.createEl("p", { text: "Creates two synthetic 500 MB files in Inbox, checks chunked transfers, and archives completed fixtures. Run on iPhone and iPad with Obsidian open; desktop results do not prove mobile support." });
    new Setting(verification).setName("Large-file diagnostic").addButton(button => button.setButtonText("Run diagnostic").onClick(() => run(() => service.runDiagnostic())));
    return dispose;
}
