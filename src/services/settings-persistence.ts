type SettingsRecord = Record<string, unknown>;

const hasOwn = (record: SettingsRecord, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, key);

const cloneSettingValue = <T>(value: T): T => {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value)) as T;
};

export function requireSettingsRecord(value: unknown): SettingsRecord {
    if (value == null) return {};
    if (typeof value === "object" && !Array.isArray(value)) return value as SettingsRecord;
    throw new Error("TPS Controller settings data must be an object.");
}

/** Apply only locally changed top-level fields to the newest data.json payload. */
export function mergeSettingsChangeSet(
    latest: unknown,
    local: SettingsRecord,
    changedKeys: readonly string[],
): SettingsRecord {
    const merged: SettingsRecord = { ...requireSettingsRecord(latest) };
    for (const key of changedKeys) {
        if (hasOwn(local, key)) merged[key] = cloneSettingValue(local[key]);
        else delete merged[key];
    }
    for (const key of ["syncIntervalMinutes", "calendarImportHorizonDays", "missingEventStatusValue", "inlineTaskReminders", "enableTimeTrackingHourlyReminders", "batchNotifications", "previousStatusKey", "noLossSyncMode", "syncOnEventDelete"]) delete merged[key];
    return merged;
}

/** Serializes snapshots and makes every requester await its save or a newer one. */
export class CoalescedSettingsSaveQueue<T> {
    private activePromise: Promise<void> | null = null;
    private saveRequested = false;

    constructor(
        private readonly capture: () => T,
        private readonly persist: (snapshot: T) => Promise<void>,
        private readonly afterDrain?: () => void | Promise<void>,
    ) {}

    requestSave(): Promise<void> {
        this.saveRequested = true;
        if (!this.activePromise) this.startDrain();
        return this.activePromise!;
    }

    async waitForIdle(): Promise<void> {
        while (this.activePromise) {
            await this.activePromise;
        }
    }

    private async drain(): Promise<void> {
        try {
            while (true) {
                do {
                    this.saveRequested = false;
                    try {
                        await this.persist(this.capture());
                    } catch (error) {
                        // A newer requested snapshot is allowed to supersede a failed
                        // in-flight write. Without one, every waiter observes failure.
                        if (!this.saveRequested) throw error;
                    }
                } while (this.saveRequested);

                await this.afterDrain?.();
                if (!this.saveRequested) return;
            }
        } finally {
            this.activePromise = null;
        }
    }

    private startDrain(): void {
        // Install the field before drain() can settle. drain() clears it
        // synchronously, so a completion-window request starts a fresh drain.
        this.activePromise = Promise.resolve().then(() => this.drain());
    }
}
