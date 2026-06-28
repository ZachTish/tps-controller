import { App, Modal, Setting, Notice } from "obsidian";

interface SnoozeOption {
    label: string;
    minutes: number;
}

export class SnoozeModal extends Modal {
    onSubmit: (minutes: number) => void;
    private options: SnoozeOption[];
    private customMinutes: number | null = null;

    constructor(app: App, onSubmit: (minutes: number) => void, options: SnoozeOption[]) {
        super(app);
        this.onSubmit = onSubmit;
        this.options = Array.isArray(options) ? options : [];
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Snooze Reminder" });

        const buttonsDiv = contentEl.createDiv({ cls: "tps-snooze-buttons" });
        buttonsDiv.style.display = "flex";
        buttonsDiv.style.flexDirection = "column";
        buttonsDiv.style.gap = "10px";

        // Pre-defined Options
        const defaultOptions = [
            { label: "15 Minutes", value: 15 },
            { label: "1 Hour", value: 60 },
            { label: "4 Hours", value: 240 },
            { label: "1 Day", value: 1440 }
        ];

        const snoozeOptions = this.options.length > 0
            ? this.options.map((opt) => ({ label: opt.label, value: opt.minutes }))
            : defaultOptions;

        snoozeOptions.forEach(opt => {
            new Setting(buttonsDiv)
                .setName(opt.label)
                .addButton(btn => btn
                    .setButtonText("Select")
                    .onClick(() => {
                        this.handleSelection(opt.value);
                    }));
        });

        // Custom Input
        const customDiv = contentEl.createDiv({ cls: "tps-snooze-custom" });
        customDiv.style.marginTop = "15px";
        customDiv.style.borderTop = "1px solid var(--background-modifier-border)";
        customDiv.style.paddingTop = "10px";

        new Setting(customDiv)
            .setName("Custom Duration")
            .setDesc("Enter minutes")
            .addText(text => text
                .setPlaceholder("e.g. 30")
                .onChange(value => {
                    const parsed = parseInt(value);
                    this.customMinutes = isNaN(parsed) ? null : parsed;
                }))
            .addButton(btn => btn
                .setButtonText("Snooze")
                .setCta()
                .onClick(() => {
                    if (this.customMinutes && this.customMinutes > 0) {
                        this.handleSelection(this.customMinutes);
                    } else {
                        new Notice("Please enter a valid number of minutes.");
                    }
                }));
    }

    handleSelection(value: number) {
        let minutes = 0;
        if (typeof value === 'number') minutes = value;
        this.onSubmit(minutes);
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
