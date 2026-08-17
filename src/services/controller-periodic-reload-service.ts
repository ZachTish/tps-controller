export const CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS = 15 * 60 * 1000;
export const CONTROLLER_PERIODIC_RELOAD_WARNING_MS = 60 * 1000;

const WARNING_DELAY_MS = CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS
    - CONTROLLER_PERIODIC_RELOAD_WARNING_MS;
const STORAGE_KEY_PREFIX = "tps-controller-periodic-reload-";

export interface ControllerPeriodicReloadStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/**
 * A vault-scoped, device-local preference. It deliberately does not participate
 * in the Controller's synced data.json settings.
 */
export class ControllerPeriodicReloadPreference {
    private readonly storageKey: string;
    private readonly storage: ControllerPeriodicReloadStorage;
    private sessionFallback: boolean | null = null;

    constructor(vaultName: string, storage?: ControllerPeriodicReloadStorage) {
        this.storageKey = `${STORAGE_KEY_PREFIX}${vaultName}`;
        this.storage = storage ?? window.localStorage;
    }

    get(): boolean {
        if (this.sessionFallback !== null) return this.sessionFallback;
        try {
            return this.storage.getItem(this.storageKey) === "enabled";
        } catch {
            // Storage denial must never turn a disruptive behavior on.
            return false;
        }
    }

    set(enabled: boolean): boolean {
        try {
            if (enabled) this.storage.setItem(this.storageKey, "enabled");
            else this.storage.removeItem(this.storageKey);
            this.sessionFallback = null;
            return true;
        } catch {
            // Some storage implementations can reject deletion while allowing a
            // value replacement. A non-enabled marker is an equally safe persisted
            // representation of disabled.
            if (!enabled) {
                try {
                    this.storage.setItem(this.storageKey, "disabled");
                    this.sessionFallback = null;
                    return true;
                } catch {
                    // Fall through to the session-only safe state.
                }
            }

            // Never surface a storage exception from a settings toggle, and never
            // let a failed write enable this disruptive behavior for this session.
            this.sessionFallback = false;
            return false;
        }
    }
}

export interface ControllerPeriodicReloadTimers {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export type ControllerPeriodicReloadEvent =
    | "scheduled"
    | "warning"
    | "preflight-started"
    | "preflight-completed"
    | "reload-requested"
    | "reload-rejected"
    | "skipped-ineligible"
    | "failed"
    | "stopped";

export interface ControllerPeriodicReloadServiceOptions {
    isEligible(): boolean;
    preflight(): Promise<void>;
    executeReload(): boolean | Promise<boolean>;
    showWarning(): void;
    onEvent?(event: ControllerPeriodicReloadEvent, data?: Record<string, unknown>): void;
    timers?: ControllerPeriodicReloadTimers;
}

const DEFAULT_TIMERS: ControllerPeriodicReloadTimers = {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/**
 * Schedules a guarded reload attempt. Host-specific saving and command dispatch
 * stay in injected callbacks so this lifecycle can be tested without Obsidian.
 */
export class ControllerPeriodicReloadService {
    private readonly timers: ControllerPeriodicReloadTimers;
    private timerHandle: unknown | undefined;
    private timerSequence = 0;
    private generation = 0;
    private running = false;
    private disposed = false;
    private inFlightGeneration: number | null = null;

    constructor(private readonly options: ControllerPeriodicReloadServiceOptions) {
        this.timers = options.timers ?? DEFAULT_TIMERS;
    }

    start(): void {
        if (this.disposed) return;

        if (!this.running) {
            this.running = true;
            this.generation += 1;
        }

        // Repeated starts are idempotent, but a start after a previously
        // ineligible check is allowed to arm the service once eligibility changes.
        if (this.timerHandle !== undefined || this.inFlightGeneration !== null) return;
        if (!this.checkEligibility("start")) return;
        this.scheduleWarning(this.generation);
    }

    stop(): void {
        const hadWork = this.running
            || this.timerHandle !== undefined
            || this.inFlightGeneration !== null;
        this.running = false;
        this.generation += 1;
        this.inFlightGeneration = null;
        this.clearTimer();
        if (hadWork) this.emit("stopped");
    }

    dispose(): void {
        if (this.disposed) return;
        this.stop();
        this.disposed = true;
    }

    private scheduleWarning(generation: number): void {
        if (!this.isCurrent(generation) || this.timerHandle !== undefined) return;
        const sequence = ++this.timerSequence;
        const handle = this.timers.setTimeout(() => {
            if (!this.isCurrentTimer(generation, sequence, handle)) return;
            this.timerHandle = undefined;
            this.timerSequence += 1;
            this.handleWarning(generation);
        }, WARNING_DELAY_MS);
        this.timerHandle = handle;
        this.emit("scheduled", {
            phase: "warning",
            delayMs: WARNING_DELAY_MS,
            reloadInMs: CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS,
        });
    }

    private handleWarning(generation: number): void {
        if (!this.isCurrent(generation)) return;
        if (!this.checkEligibility("warning")) return;

        try {
            this.options.showWarning();
            this.emit("warning", { reloadInMs: CONTROLLER_PERIODIC_RELOAD_WARNING_MS });
        } catch (error) {
            this.emitFailure("warning", error);
            this.scheduleNextFullCycle(generation);
            return;
        }

        const sequence = ++this.timerSequence;
        const handle = this.timers.setTimeout(() => {
            if (!this.isCurrentTimer(generation, sequence, handle)) return;
            this.timerHandle = undefined;
            this.timerSequence += 1;
            this.beginReloadAttempt(generation);
        }, CONTROLLER_PERIODIC_RELOAD_WARNING_MS);
        this.timerHandle = handle;
        this.emit("scheduled", {
            phase: "reload",
            delayMs: CONTROLLER_PERIODIC_RELOAD_WARNING_MS,
        });
    }

    private beginReloadAttempt(generation: number): void {
        if (!this.isCurrent(generation)) return;
        if (!this.checkEligibility("reload")) return;
        if (this.inFlightGeneration !== null) return;

        this.inFlightGeneration = generation;
        void this.runReloadAttempt(generation);
    }

    private async runReloadAttempt(generation: number): Promise<void> {
        try {
            this.emit("preflight-started");
            await this.options.preflight();
            if (!this.isCurrentFlight(generation)) return;
            if (!this.checkEligibility("after-preflight")) return;
            this.emit("preflight-completed");

            const accepted = await this.options.executeReload();
            if (!this.isCurrentFlight(generation)) return;
            if (accepted) this.emit("reload-requested");
            else this.emit("reload-rejected");
        } catch (error) {
            if (this.isCurrentFlight(generation)) this.emitFailure("reload-attempt", error);
        } finally {
            if (!this.isCurrentFlight(generation)) return;
            this.inFlightGeneration = null;
            this.scheduleNextFullCycle(generation);
        }
    }

    private scheduleNextFullCycle(generation: number): void {
        if (!this.isCurrent(generation)) return;
        if (!this.checkEligibility("reschedule")) return;
        this.scheduleWarning(generation);
    }

    private checkEligibility(phase: string): boolean {
        let eligible = false;
        try {
            eligible = this.options.isEligible();
        } catch (error) {
            this.emitFailure("eligibility", error, { phase });
            return false;
        }
        if (!eligible) this.emit("skipped-ineligible", { phase });
        return eligible;
    }

    private isCurrent(generation: number): boolean {
        return this.running && !this.disposed && this.generation === generation;
    }

    private isCurrentFlight(generation: number): boolean {
        return this.isCurrent(generation) && this.inFlightGeneration === generation;
    }

    private isCurrentTimer(generation: number, sequence: number, handle: unknown): boolean {
        return this.isCurrent(generation)
            && this.timerSequence === sequence
            && this.timerHandle === handle;
    }

    private clearTimer(): void {
        this.timerSequence += 1;
        if (this.timerHandle === undefined) return;
        this.timers.clearTimeout(this.timerHandle);
        this.timerHandle = undefined;
    }

    private emitFailure(
        stage: string,
        error: unknown,
        data: Record<string, unknown> = {},
    ): void {
        this.emit("failed", {
            ...data,
            stage,
            reason: error instanceof Error ? error.message : String(error),
        });
    }

    private emit(event: ControllerPeriodicReloadEvent, data?: Record<string, unknown>): void {
        try {
            this.options.onEvent?.(event, data);
        } catch {
            // Observability must not alter the reload lifecycle.
        }
    }
}
