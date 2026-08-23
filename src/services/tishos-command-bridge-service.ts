import { App, Modal, Notice, type PluginManifest } from "obsidian";
import { executeCommandById, listCommands } from "../core/type-guards";
import type { OverdueItem } from "../types";
import * as logger from "../logger";
import {
    TISHOS_COMMAND_BRIDGE_CATALOG_ROOT,
    TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES,
    TISHOS_COMMAND_BRIDGE_MAX_FUTURE_SKEW_MS,
    TISHOS_COMMAND_BRIDGE_MAX_REQUEST_AGE_MS,
    canonicalCommandCatalog,
    canonicalCommandRevokeRequest,
    canonicalCommandRunRequest,
    canonicalNotificationActionRequest,
    compareUTF8,
    commandEntryDigest,
    decodeBase64URL,
    hmacSHA256Base64URL,
    isCanonicalBase64URLSHA256,
    isCanonicalGeneratedAt,
    isCanonicalIssuedAt,
    isFreshIssuedAt,
    isValidCommandID,
    isValidCommandName,
    isValidDeviceName,
    isValidPlatform,
    isValidVaultName,
    normalizeCommandRegistry,
    normalizeUUID,
    portableVaultNamesMatch,
    sha256Base64URL,
    utf8ByteCount,
    verifyHmacSHA256Base64URL,
    type TishOSCommandCatalog,
    type TishOSCommandCatalogEntry,
    type TishOSCommandRevokeRequest,
    type TishOSCommandRunRequest,
    type TishOSNotificationActionRequest,
} from "./tishos-command-bridge-contract";
import {
    TISHOS_NATIVE_NOTIFICATION_MAX_FILE_BYTES,
    TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS,
    TISHOS_NATIVE_NOTIFICATION_MAX_LATE_MS,
    TISHOS_NATIVE_NOTIFICATION_ROOT,
    canonicalNotificationItem,
    canonicalNotificationSeries,
    canonicalNotificationSchedule,
    isValidNotificationBody,
    isValidNotificationSourcePath,
    validateNotificationItems,
    type TishOSNativeNotificationItem,
    type TishOSNativeNotificationSchedule,
} from "./tishos-native-notification-contract";

export const TISHOS_COMMAND_BRIDGE_PAIR_ROUTE = "tps-controller-command-bridge-pair";
export const TISHOS_COMMAND_BRIDGE_RUN_ROUTE = "tps-controller-run-command";
export const TISHOS_COMMAND_BRIDGE_REVOKE_ROUTE = "tps-controller-command-bridge-revoke";
export const TISHOS_NOTIFICATION_ACTION_ROUTE =
    "tps-controller-native-notification-action";

const POLL_INTERVAL_MS = 60_000;
const MAX_PAIRED_CLIENTS = 32;
const PAIRING_MODAL_HANDOFF_DELAY_MS = 100;
const MAX_REPLAY_ENTRIES = 2048;
const MAX_REVOCATION_ENTRIES = 64;
const REPLAY_RETENTION_MS = TISHOS_COMMAND_BRIDGE_MAX_REQUEST_AGE_MS + TISHOS_COMMAND_BRIDGE_MAX_FUTURE_SKEW_MS;
const LOCAL_TOKEN = /^[0-9a-f]{32}$/;

type ProtocolParams = Record<string, string | undefined>;

// Obsidian invokes protocol handlers with an already-parsed object, so duplicate
// raw query keys are no longer observable at this boundary. TishOS emits each key
// once; this side still rejects unknown/non-string values and authenticates the
// exact parsed values it acts on.

interface StoredPairing {
    clientID: string;
    generation: string;
    platform: "ios" | "ipados" | "macos";
    device: string;
    secretID: string;
    pairedAt: string;
    catalogFingerprint?: string;
    lastPublishedAt?: string;
    commandCount?: number;
    returnPending?: boolean;
}

interface StoredPairingState {
    schemaVersion: 1;
    vaultName: string;
    clients: StoredPairing[];
}

interface StoredReplayEntry {
    clientID: string;
    requestID: string;
    seenAt: number;
}

interface StoredReplayState {
    schemaVersion: 1;
    vaultName: string;
    entries: StoredReplayEntry[];
}

interface StoredRevocation {
    clientID: string;
    secretID: string;
    createdAt: string;
}

interface StoredRevocationState {
    schemaVersion: 1;
    vaultName: string;
    entries: StoredRevocation[];
}

export interface TishOSCommandBridgeClientStatus {
    clientID: string;
    platform: "ios" | "ipados" | "macos";
    device: string;
    pairedAt: string;
    lastPublishedAt: string | null;
    commandCount: number;
    nativeNotificationState: "ready" | "pending";
    nativeNotificationItemCount: number | null;
    nativeNotificationPublishedAt: string | null;
    nativeNotificationReason: string | null;
}

export interface TishOSCommandBridgeStatus {
    available: boolean;
    vaultName: string;
    clients: TishOSCommandBridgeClientStatus[];
}

export interface TishOSCommandBridgeRefreshResult {
    pairedClients: number;
    publishedClients: number;
    unchangedClients: number;
    failedClients: number;
    commandCount: number;
    invalidCommands: number;
    ambiguousCommands: number;
    unavailableReason?: string;
}

interface TishOSCommandBridgeRefreshOutcome extends TishOSCommandBridgeRefreshResult {
    readyPairings: Array<{ clientID: string; generation: string }>;
}

interface NativeNotificationRefreshOutcome {
    readyClientIDs: Set<string>;
    failedClientIDs: Set<string>;
    publishedClients: number;
    unchangedClients: number;
}

export interface TishOSCommandBridgeRouteResult {
    accepted: boolean;
    reason: string;
    clientID?: string;
    executed?: boolean;
}

interface TishOSCommandBridgeServiceOptions {
    now?: () => number;
    confirmPairing?: (request: PairingRequest) => Promise<boolean>;
    confirmLocalRevoke?: (pairing: StoredPairing, vaultName: string) => Promise<boolean>;
    notificationScheduleReadiness?: () => { ready: boolean; reason?: string };
    notificationScheduleProvider?: () => Promise<readonly NativeNotificationProjectionValue[]>;
    completeNotification?: (value: NativeNotificationProjectionValue) => Promise<boolean>;
}

interface NativeNotificationClientStatus {
    state: "ready" | "pending";
    itemCount: number | null;
    publishedAt: string | null;
    reason: string | null;
}

interface NativeNotificationProjectionValue {
    title: string;
    body: string;
    fireAt: number;
    sourceKey: string;
    reminderId: string;
    sourcePath?: string;
    completionTarget?: OverdueItem;
}

interface PairingRequest {
    vaultName: string;
    clientID: string;
    secret: string;
    platform: "ios" | "ipados" | "macos";
    device: string;
}

interface ActivePairingLane {
    request: PairingRequest;
    lifecycle: number;
    promise: Promise<TishOSCommandBridgeRouteResult>;
}

interface PairingCommitResult {
    result: TishOSCommandBridgeRouteResult;
    generation?: string;
}

class CommandBridgeConfirmationModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        private readonly title: string,
        private readonly message: string,
        private readonly approveLabel: string,
        private readonly resolveResult: (approved: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.title);
        this.contentEl.createEl("p", { text: this.message });
        this.contentEl.createEl("p", {
            text: "The bridge can list command names and request one no-argument command at a time. Every request still opens this exact Obsidian vault.",
            cls: "setting-item-description",
        });
        const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.setAttr("type", "button");
        cancel.addEventListener("click", () => this.finish(false));
        const approve = actions.createEl("button", { text: this.approveLabel, cls: "mod-cta" });
        approve.setAttr("type", "button");
        approve.addEventListener("click", () => this.finish(true));
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.settled) this.finish(false, false);
    }

    private finish(approved: boolean, close = true): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveResult(approved);
        if (close) this.close();
    }
}

function confirmWithModal(
    app: App,
    title: string,
    message: string,
    approveLabel: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        new CommandBridgeConfirmationModal(app, title, message, approveLabel, resolve).open();
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(params: ProtocolParams, allowed: ReadonlySet<string>): boolean {
    return Object.keys(params).every((key) => allowed.has(key) && typeof params[key] === "string");
}

function isCanonicalISO(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function pairingStateIsValid(value: unknown, vaultName: string): value is StoredPairingState {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["schemaVersion", "vaultName", "clients"])
        || value.schemaVersion !== 1
        || value.vaultName !== vaultName
        || !Array.isArray(value.clients)
    ) {
        return false;
    }
    if (value.clients.length > MAX_PAIRED_CLIENTS) return false;
    const ids = new Set<string>();
    for (const candidate of value.clients) {
        if (!isRecord(candidate)) return false;
        const allowedKeys = new Set([
            "clientID",
            "generation",
            "platform",
            "device",
            "secretID",
            "pairedAt",
            "catalogFingerprint",
            "lastPublishedAt",
            "commandCount",
            "returnPending",
        ]);
        if (
            Object.keys(candidate).some((key) => !allowedKeys.has(key))
            || !["clientID", "generation", "platform", "device", "secretID", "pairedAt"].every((key) => key in candidate)
        ) return false;
        const clientID = normalizeUUID(String(candidate.clientID || ""));
        if (!clientID || candidate.clientID !== clientID || ids.has(clientID)) return false;
        if (typeof candidate.generation !== "string" || !LOCAL_TOKEN.test(candidate.generation)) return false;
        if (!isValidPlatform(candidate.platform) || !isValidDeviceName(candidate.device)) return false;
        if (typeof candidate.secretID !== "string" || !/^[a-z0-9-]{1,128}$/.test(candidate.secretID)) return false;
        if (!isCanonicalISO(candidate.pairedAt)) return false;
        if (candidate.catalogFingerprint !== undefined && !isCanonicalBase64URLSHA256(String(candidate.catalogFingerprint))) return false;
        if (candidate.lastPublishedAt !== undefined && !isCanonicalISO(candidate.lastPublishedAt)) return false;
        if (candidate.commandCount !== undefined
            && (!Number.isInteger(candidate.commandCount) || Number(candidate.commandCount) < 0 || Number(candidate.commandCount) > 4096)) {
            return false;
        }
        if (candidate.returnPending !== undefined && typeof candidate.returnPending !== "boolean") return false;
        ids.add(clientID);
    }
    return true;
}

function replayStateIsValid(value: unknown, vaultName: string): value is StoredReplayState {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["schemaVersion", "vaultName", "entries"])
        || value.schemaVersion !== 1
        || value.vaultName !== vaultName
        || !Array.isArray(value.entries)
    ) {
        return false;
    }
    if (value.entries.length > MAX_REPLAY_ENTRIES) return false;
    const keys = new Set<string>();
    return value.entries.every((candidate) => {
        if (!isRecord(candidate)) return false;
        if (!hasExactKeys(candidate, ["clientID", "requestID", "seenAt"])) return false;
        const clientID = normalizeUUID(String(candidate.clientID || ""));
        const requestID = normalizeUUID(String(candidate.requestID || ""));
        const key = `${clientID}:${requestID}`;
        if (keys.has(key)) return false;
        keys.add(key);
        return clientID !== null
            && requestID !== null
            && candidate.clientID === clientID
            && candidate.requestID === requestID
            && Number.isSafeInteger(candidate.seenAt)
            && Number(candidate.seenAt) >= 0;
    });
}

function revocationStateIsValid(value: unknown, vaultName: string): value is StoredRevocationState {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["schemaVersion", "vaultName", "entries"])
        || value.schemaVersion !== 1
        || value.vaultName !== vaultName
        || !Array.isArray(value.entries)
        || value.entries.length > MAX_REVOCATION_ENTRIES
    ) return false;
    const ids = new Set<string>();
    return value.entries.every((candidate) => {
        if (!isRecord(candidate) || !hasExactKeys(candidate, ["clientID", "secretID", "createdAt"])) return false;
        const clientID = normalizeUUID(String(candidate.clientID || ""));
        if (!clientID || candidate.clientID !== clientID || ids.has(clientID)) return false;
        if (typeof candidate.secretID !== "string" || !/^[a-z0-9-]{1,128}$/.test(candidate.secretID)) return false;
        if (!isCanonicalISO(candidate.createdAt)) return false;
        ids.add(clientID);
        return true;
    });
}

export class TishOSCommandBridgeService {
    private readonly now: () => number;
    private readonly confirmPairing: (request: PairingRequest) => Promise<boolean>;
    private readonly confirmLocalRevoke: (pairing: StoredPairing, vaultName: string) => Promise<boolean>;
    private commandRouteQueue: Promise<void> = Promise.resolve();
    private revocationQueue: Promise<void> = Promise.resolve();
    private layoutReady = false;
    private stopped = false;
    private refreshPromise: Promise<TishOSCommandBridgeRefreshOutcome> | null = null;
    private pollIntervalID: number | null = null;
    private readonly pendingReturnGenerations = new Map<string, string>();
    private activePairingLane: ActivePairingLane | null = null;
    private lifecycleGeneration = 1;
    private stopPromise: Promise<void> | null = null;
    private readonly notificationScheduleProvider:
        (() => Promise<readonly NativeNotificationProjectionValue[]>) | null;
    private readonly notificationScheduleReadiness:
        (() => { ready: boolean; reason?: string }) | null;
    private readonly completeNotification:
        ((value: NativeNotificationProjectionValue) => Promise<boolean>) | null;
    private readonly nativeNotificationStatusByClientID = new Map<string, NativeNotificationClientStatus>();

    constructor(
        private readonly app: App,
        private readonly publisher: Pick<PluginManifest, "id" | "version">,
        options: TishOSCommandBridgeServiceOptions = {},
    ) {
        this.now = options.now || (() => Date.now());
        this.notificationScheduleProvider = options.notificationScheduleProvider || null;
        this.notificationScheduleReadiness = options.notificationScheduleReadiness || null;
        this.completeNotification = options.completeNotification || null;
        this.confirmPairing = options.confirmPairing || (async (request) => {
            // Obsidian dismisses an open Settings modal while handing off an
            // external protocol URL. Opening our confirmation in that same
            // turn lets the Settings teardown remove it without settling the
            // route. Give the host transition one short macrotask window first.
            await new Promise<void>((resolve) => globalThis.setTimeout(resolve, PAIRING_MODAL_HANDOFF_DELAY_MS));
            if (this.stopped) return false;
            return confirmWithModal(
                this.app,
                "Connect TishOS to Obsidian commands?",
                `${request.device} (${request.platform}) is requesting access to commands registered in “${request.vaultName}”.`,
                "Connect",
            );
        });
        this.confirmLocalRevoke = options.confirmLocalRevoke || ((pairing, vaultName) => confirmWithModal(
            this.app,
            "Revoke TishOS command access?",
            `Remove command access for ${pairing.device} (${pairing.platform}) from “${vaultName}”? Other paired devices are not affected.`,
            "Revoke",
        ));
    }

    start(): void {
        if (!this.stopped && this.layoutReady) return;
        this.stopped = false;
        this.stopPromise = null;
        this.restorePendingReturnClients();
        this.app.workspace.onLayoutReady(() => {
            if (this.stopped || this.layoutReady) return;
            this.layoutReady = true;
            void this.refreshCatalogs("layout-ready");
            this.pollIntervalID = window.setInterval(() => {
                void this.refreshCatalogs("poll");
            }, POLL_INTERVAL_MS);
        });
    }

    stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.stopped = true;
        this.lifecycleGeneration += 1;
        this.layoutReady = false;
        if (this.pollIntervalID !== null) window.clearInterval(this.pollIntervalID);
        this.pollIntervalID = null;
        this.pendingReturnGenerations.clear();
        this.nativeNotificationStatusByClientID.clear();
        const commandDrain = this.commandRouteQueue;
        const refreshDrain = this.refreshPromise;
        const revocationDrain = this.revocationQueue;
        this.stopPromise = Promise.allSettled([
            commandDrain,
            revocationDrain,
            ...(refreshDrain ? [refreshDrain] : []),
        ]).then(() => {
            this.nativeNotificationStatusByClientID.clear();
        });
        return this.stopPromise;
    }

    getStatus(): TishOSCommandBridgeStatus {
        const vaultName = this.app.vault.getName();
        try {
            const state = this.loadPairingState();
            const revoking = new Set(this.loadRevocationState().entries.map((entry) => entry.clientID));
            return {
                available: true,
                vaultName,
                clients: state.clients.filter((pairing) => !revoking.has(pairing.clientID)).map((pairing) => {
                    const native = this.nativeNotificationStatusByClientID.get(pairing.clientID) || {
                        state: "pending" as const,
                        itemCount: null,
                        publishedAt: null,
                        reason: this.layoutReady ? "awaiting-refresh" : "layout-not-ready",
                    };
                    return {
                        clientID: pairing.clientID,
                        platform: pairing.platform,
                        device: pairing.device,
                        pairedAt: pairing.pairedAt,
                        lastPublishedAt: pairing.lastPublishedAt || null,
                        commandCount: pairing.commandCount || 0,
                        nativeNotificationState: native.state,
                        nativeNotificationItemCount: native.itemCount,
                        nativeNotificationPublishedAt: native.publishedAt,
                        nativeNotificationReason: native.reason,
                    };
                }),
            };
        } catch {
            return { available: false, vaultName, clients: [] };
        }
    }

    handlePairRoute(params: ProtocolParams): Promise<TishOSCommandBridgeRouteResult> {
        const validation = this.validatePairRoute(params);
        if (!validation.request) return Promise.resolve(this.reject("pair", validation.reason));
        if (this.stopped) return Promise.resolve(this.reject("pair", "service-stopped", validation.request.clientID));
        const request = validation.request;
        const active = this.activePairingLane;
        if (active && this.isLifecycleActive(active.lifecycle)) {
            if (this.samePairingRequest(active.request, request)) return active.promise;
            return Promise.resolve(this.reject("pair", "pairing-busy", request.clientID));
        }
        const lifecycle = this.lifecycleGeneration;
        let operation: Promise<TishOSCommandBridgeRouteResult>;
        operation = this.processPairRequest(request, lifecycle).finally(() => {
            if (this.activePairingLane?.promise === operation) this.activePairingLane = null;
        });
        this.activePairingLane = { request, lifecycle, promise: operation };
        return operation;
    }

    handleRunRoute(params: ProtocolParams): Promise<TishOSCommandBridgeRouteResult> {
        const lifecycle = this.lifecycleGeneration;
        if (!this.isLifecycleActive(lifecycle)) return Promise.resolve(this.reject("run", "service-stopped"));
        return this.enqueueCommandRoute(
            () => this.processRunRoute(params, lifecycle),
            () => this.reject("run", "service-stopped"),
            lifecycle,
        );
    }

    handleNotificationActionRoute(
        params: ProtocolParams,
    ): Promise<TishOSCommandBridgeRouteResult> {
        const lifecycle = this.lifecycleGeneration;
        if (!this.isLifecycleActive(lifecycle)) {
            return Promise.resolve(this.reject("notification-action", "service-stopped"));
        }
        return this.enqueueCommandRoute(
            () => this.processNotificationActionRoute(params, lifecycle),
            () => this.reject("notification-action", "service-stopped"),
            lifecycle,
        );
    }

    handleRevokeRoute(params: ProtocolParams): Promise<TishOSCommandBridgeRouteResult> {
        const lifecycle = this.lifecycleGeneration;
        if (!this.isLifecycleActive(lifecycle)) return Promise.resolve(this.reject("revoke", "service-stopped"));
        return this.enqueueCommandRoute(
            () => this.processRevokeRoute(params, lifecycle),
            () => this.reject("revoke", "service-stopped"),
            lifecycle,
        );
    }

    async requestLocalRevoke(clientID: string): Promise<boolean> {
        const normalized = normalizeUUID(clientID);
        if (!normalized) return false;
        const lifecycle = this.lifecycleGeneration;
        if (!this.isLifecycleActive(lifecycle)) return false;
        let pairing: StoredPairing;
        let vaultName: string;
        try {
            const state = this.loadPairingState();
            const found = state.clients.find((candidate) => candidate.clientID === normalized);
            if (!found) return false;
            pairing = found;
            vaultName = state.vaultName;
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "revoke:settings-state-unavailable", { errorType: this.errorType(error) });
            return false;
        }
        let approved = false;
        try {
            approved = await this.confirmLocalRevoke(pairing, vaultName);
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "revoke:settings-confirmation-failed", { errorType: this.errorType(error) });
            return false;
        }
        if (!approved || !this.isLifecycleActive(lifecycle)) return false;
        return this.enqueueCommandRoute(async () => {
            try {
                const current = this.loadPairingState().clients.find((candidate) => candidate.clientID === normalized);
                if (!current || current.generation !== pairing.generation) return false;
                if (!await this.beginRevocation(pairing.clientID, lifecycle)) return false;
                await this.settleActiveRefresh();
                const cleaned = await this.retryPendingRevocation(pairing.clientID, "settings");
                if (this.isLifecycleActive(lifecycle)) {
                    new Notice(cleaned
                        ? `Revoked TishOS command access for ${pairing.device}.`
                        : `Revoked TishOS command access for ${pairing.device}; local cleanup will retry automatically.`);
                }
                return true;
            } catch (error) {
                logger.flowWarn("TishOSCommandBridge", "revoke:settings-failed", { errorType: this.errorType(error) });
                if (this.isLifecycleActive(lifecycle)) new Notice("TishOS command access could not be revoked cleanly.");
                return false;
            }
        }, () => false, lifecycle);
    }

    refreshCatalogs(reason = "manual"): Promise<TishOSCommandBridgeRefreshOutcome> {
        if (this.stopped) return Promise.resolve(this.unavailableRefresh("service-stopped"));
        if (this.refreshPromise) return this.refreshPromise;
        const operation = this.refreshCatalogsInternal(reason).catch((error) => {
            let pairedClients = 0;
            try {
                pairedClients = this.loadPairingState().clients.length;
            } catch {
                // The failure result remains useful even when local state is unreadable.
            }
            logger.flowWarn("TishOSCommandBridge", "catalog-refresh:failed", {
                reason,
                pairedClients,
                errorType: this.errorType(error),
            });
            return this.unavailableRefresh("refresh-failure", pairedClients);
        });
        this.refreshPromise = operation;
        const clear = (): void => {
            if (this.refreshPromise === operation) this.refreshPromise = null;
        };
        void operation.then((outcome) => {
            clear();
            this.returnToTishOSIfReady(outcome.readyPairings);
        }, clear);
        return operation;
    }

    private async refreshCatalogsInternal(reason: string): Promise<TishOSCommandBridgeRefreshOutcome> {
        await this.retryPendingRevocations(`refresh:${reason}`);
        let state: StoredPairingState;
        let clients: StoredPairing[];
        try {
            state = this.loadPairingState();
            const revoking = new Set(this.loadRevocationState().entries.map((entry) => entry.clientID));
            clients = state.clients.filter((pairing) => !revoking.has(pairing.clientID));
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "catalog-refresh:state-unavailable", {
                reason,
                errorType: this.errorType(error),
            });
            return this.unavailableRefresh("pairing-state-unavailable");
        }
        if (!clients.length) {
            return this.unavailableRefresh(state.clients.length ? "revocation-cleanup-pending" : "not-paired", 0);
        }
        if (!this.layoutReady) return this.unavailableRefresh("layout-not-ready", clients.length);

        let nativeNotificationReadyClientIDs: Set<string> | null = null;
        const nativeNotificationFailedClientIDs = new Set<string>();
        if (this.notificationScheduleProvider) {
            nativeNotificationReadyClientIDs = new Set<string>();
            let readiness: { ready: boolean; reason?: string } = { ready: true };
            try {
                readiness = this.notificationScheduleReadiness?.() || readiness;
            } catch {
                readiness = { ready: false, reason: "readiness-check-failed" };
            }
            if (!readiness.ready) {
                const unavailableReason = String(readiness.reason || "projection-not-ready");
                for (const pairing of clients) {
                    nativeNotificationFailedClientIDs.add(pairing.clientID);
                    this.setNativeNotificationPending(pairing.clientID, unavailableReason);
                }
                logger.flow("TishOSCommandBridge", "native-notification-refresh:not-ready", {
                    reason,
                    pairedClients: clients.length,
                    unavailableReason,
                });
            } else {
                try {
                    const notificationItems = await this.buildNativeNotificationItems(
                        await this.notificationScheduleProvider(),
                    );
                    const notificationRefresh = await this.refreshNativeNotificationSchedules(
                        state.vaultName,
                        clients,
                        notificationItems,
                        reason,
                    );
                    nativeNotificationReadyClientIDs = notificationRefresh.readyClientIDs;
                    for (const clientID of notificationRefresh.failedClientIDs) {
                        nativeNotificationFailedClientIDs.add(clientID);
                    }
                } catch (error) {
                    for (const pairing of clients) {
                        nativeNotificationFailedClientIDs.add(pairing.clientID);
                        this.setNativeNotificationPending(pairing.clientID, "projection-failed");
                    }
                    logger.flowWarn("TishOSCommandBridge", "native-notification-refresh:failed", {
                        reason,
                        pairedClients: clients.length,
                        errorType: this.errorType(error),
                    });
                }
            }
        }

        const registryValues = listCommands(this.app);
        if (!registryValues) {
            logger.flowWarn("TishOSCommandBridge", "catalog-refresh:registry-unavailable", { reason, pairedClients: clients.length });
            return this.unavailableRefresh("command-registry-unavailable", clients.length);
        }
        const normalized = normalizeCommandRegistry(registryValues);
        if (normalized.rejectedForLimit) {
            logger.flowWarn("TishOSCommandBridge", "catalog-refresh:command-limit", {
                reason,
                pairedClients: clients.length,
                rawCommands: registryValues.length,
                invalidCommands: normalized.invalidCount,
                duplicateCommands: normalized.duplicateCount,
                ambiguousCommands: normalized.ambiguousDuplicateCount,
            });
            return {
                ...this.unavailableRefresh("command-limit", clients.length),
                invalidCommands: normalized.invalidCount,
                ambiguousCommands: normalized.ambiguousDuplicateCount,
            };
        }

        const entries: TishOSCommandCatalogEntry[] = [];
        for (const command of normalized.commands) {
            entries.push({ ...command, digest: await commandEntryDigest(command) });
        }
        let publishedClients = 0;
        let unchangedClients = 0;
        const failedClientIDs = new Set(nativeNotificationFailedClientIDs);
        const readyPairings: Array<{ clientID: string; generation: string }> = [];
        const metadataChangedClients = new Set<string>();
        const publishedCatalogClientIDs = new Set<string>();
        for (const pairing of clients) {
            try {
                const fingerprint = await sha256Base64URL(canonicalCommandCatalog({
                    schemaVersion: 1,
                    clientID: pairing.clientID,
                    vaultName: state.vaultName,
                    generatedAt: "",
                    publisher: { id: this.publisher.id, version: this.publisher.version },
                    commands: entries,
                }));
                const path = this.catalogPath(pairing.clientID);
                const secret = this.readPairingSecret(pairing);
                if (!secret) throw new Error("Pairing secret is unavailable.");
                await this.recoverCatalogArtifacts(path, pairing, entries, secret);
                const exists = await this.app.vault.adapter.exists(path);
                const existingGeneratedAt = exists
                    ? await this.validExistingCatalogGeneratedAt(path, pairing, entries, secret)
                    : null;
                if (existingGeneratedAt !== null) {
                    if (
                        pairing.catalogFingerprint !== fingerprint
                        || pairing.lastPublishedAt !== existingGeneratedAt
                        || pairing.commandCount !== entries.length
                    ) {
                        pairing.catalogFingerprint = fingerprint;
                        pairing.lastPublishedAt = existingGeneratedAt;
                        pairing.commandCount = entries.length;
                        metadataChangedClients.add(pairing.clientID);
                    }
                    unchangedClients += 1;
                    if (
                        nativeNotificationReadyClientIDs === null
                        || nativeNotificationReadyClientIDs.has(pairing.clientID)
                    ) {
                        readyPairings.push({ clientID: pairing.clientID, generation: pairing.generation });
                    }
                    continue;
                }
                const generatedAt = new Date(this.now()).toISOString();
                const unsigned: Omit<TishOSCommandCatalog, "mac"> = {
                    schemaVersion: 1,
                    clientID: pairing.clientID,
                    vaultName: state.vaultName,
                    generatedAt,
                    publisher: { id: this.publisher.id, version: this.publisher.version },
                    commands: entries,
                };
                const catalog: TishOSCommandCatalog = {
                    ...unsigned,
                    mac: await hmacSHA256Base64URL(secret, canonicalCommandCatalog(unsigned)),
                };
                const serialized = `${JSON.stringify(catalog)}\n`;
                if (utf8ByteCount(serialized) > TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES) {
                    throw new Error("Catalog exceeds the one-megabyte bound.");
                }
                await this.publishCatalog(path, pairing, entries, secret, serialized, generatedAt);
                pairing.catalogFingerprint = fingerprint;
                pairing.lastPublishedAt = generatedAt;
                pairing.commandCount = entries.length;
                metadataChangedClients.add(pairing.clientID);
                publishedClients += 1;
                publishedCatalogClientIDs.add(pairing.clientID);
                if (
                    nativeNotificationReadyClientIDs === null
                    || nativeNotificationReadyClientIDs.has(pairing.clientID)
                ) {
                    readyPairings.push({ clientID: pairing.clientID, generation: pairing.generation });
                }
            } catch (error) {
                failedClientIDs.add(pairing.clientID);
                if (logger.errorSummary(error).includes("one-megabyte bound")) {
                    logger.flowWarn("TishOSCommandBridge", "catalog-refresh:file-limit", {
                        reason,
                    });
                } else {
                    logger.flowWarn("TishOSCommandBridge", "catalog-refresh:client-failed", {
                        reason,
                        errorType: this.errorType(error),
                    });
                }
            }
        }
        if (metadataChangedClients.size > 0) {
            try {
                const latestState = this.loadPairingState();
                const latestRevoking = new Set(this.loadRevocationState().entries.map((entry) => entry.clientID));
                let mergedMetadata = false;
                for (const updated of clients) {
                    if (!metadataChangedClients.has(updated.clientID)) continue;
                    if (latestRevoking.has(updated.clientID)) continue;
                    const latest = latestState.clients.find((candidate) => candidate.clientID === updated.clientID);
                    if (
                        !latest
                        || latest.generation !== updated.generation
                        || latest.pairedAt !== updated.pairedAt
                        || latest.secretID !== updated.secretID
                    ) continue;
                    latest.catalogFingerprint = updated.catalogFingerprint;
                    latest.lastPublishedAt = updated.lastPublishedAt;
                    latest.commandCount = updated.commandCount;
                    mergedMetadata = true;
                }
                if (mergedMetadata) this.savePairingState(latestState);
            } catch (error) {
                logger.flowWarn("TishOSCommandBridge", "catalog-refresh:metadata-save-failed", {
                    reason,
                    publishedClients,
                    errorType: this.errorType(error),
                });
                for (const clientID of publishedCatalogClientIDs) failedClientIDs.add(clientID);
                publishedClients = 0;
            }
        }
        const failedClients = failedClientIDs.size;
        const unavailableReason = nativeNotificationFailedClientIDs.size > 0
            ? "native-notification-schedule-unavailable"
            : undefined;
        logger.flow("TishOSCommandBridge", "catalog-refresh:done", {
            reason,
            pairedClients: clients.length,
            publishedClients,
            unchangedClients,
            failedClients,
            commandCount: entries.length,
            invalidCommands: normalized.invalidCount,
            duplicateCommands: normalized.duplicateCount,
            ambiguousCommands: normalized.ambiguousDuplicateCount,
            nativeNotificationReadyClients: nativeNotificationReadyClientIDs?.size ?? null,
            unavailableReason: unavailableReason || null,
        });
        return {
            pairedClients: clients.length,
            publishedClients,
            unchangedClients,
            failedClients,
            commandCount: entries.length,
            invalidCommands: normalized.invalidCount,
            ambiguousCommands: normalized.ambiguousDuplicateCount,
            readyPairings,
            ...(unavailableReason ? { unavailableReason } : {}),
        };
    }

    private async buildNativeNotificationItems(
        values: readonly NativeNotificationProjectionValue[],
    ): Promise<TishOSNativeNotificationItem[]> {
        const now = this.now();
        const maximumFireAt = now + 60 * 24 * 60 * 60 * 1000;
        const unique = new Map<string, TishOSNativeNotificationItem>();
        const exactCandidates = new Set<string>();
        const orderedValues = [...values].sort((left, right) => {
            const leftFireAt = Number.isSafeInteger(left.fireAt) ? left.fireAt : Number.MAX_SAFE_INTEGER;
            const rightFireAt = Number.isSafeInteger(right.fireAt) ? right.fireAt : Number.MAX_SAFE_INTEGER;
            if (leftFireAt !== rightFireAt) return leftFireAt - rightFireAt;
            return compareUTF8(
                this.nativeNotificationCandidateKey(left),
                this.nativeNotificationCandidateKey(right),
            );
        });
        for (const value of orderedValues) {
            const candidateKey = this.nativeNotificationCandidateKey(value);
            if (exactCandidates.has(candidateKey)) continue;
            exactCandidates.add(candidateKey);
            const item = await this.buildNativeNotificationItem(value, now, maximumFireAt);
            if (item && !unique.has(item.id)) unique.set(item.id, item);
            if (unique.size >= TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS) break;
        }
        const items = [...unique.values()].sort((left, right) =>
            compareUTF8(left.fireAt, right.fireAt) || compareUTF8(left.id, right.id),
        );
        if (validateNotificationItems(items) === null) {
            throw new Error("Native notification projection failed validation.");
        }
        return items;
    }

    private nativeNotificationCandidateKey(value: NativeNotificationProjectionValue): string {
        return JSON.stringify([
            value.fireAt,
            value.sourceKey,
            value.reminderId,
            value.title,
            value.body,
            value.sourcePath,
        ]);
    }

    private async buildNativeNotificationItem(
        value: NativeNotificationProjectionValue,
        now = this.now(),
        maximumFireAt = now + 60 * 24 * 60 * 60 * 1000,
    ): Promise<TishOSNativeNotificationItem | null> {
        if (
            !Number.isSafeInteger(value.fireAt)
            || value.fireAt < now - TISHOS_NATIVE_NOTIFICATION_MAX_LATE_MS
            || value.fireAt > maximumFireAt
            || typeof value.sourceKey !== "string"
            || value.sourceKey.length === 0
            || utf8ByteCount(value.sourceKey) > 4_096
            || typeof value.reminderId !== "string"
            || value.reminderId.length === 0
            || utf8ByteCount(value.reminderId) > 256
        ) return null;
        const title = this.boundedNotificationText(value.title, 256, "Obsidian reminder");
        const body = this.boundedNotificationText(value.body, 1_024, "", true);
        const sourcePath = isValidNotificationSourcePath(value.sourcePath) ? value.sourcePath : undefined;
        if (!isValidCommandName(title) || !isValidNotificationBody(body)) return null;
        const seriesID = await sha256Base64URL(canonicalNotificationSeries(
            value.sourceKey,
            value.reminderId,
        ));
        const unsignedItem: TishOSNativeNotificationItem = {
            id: "",
            seriesID,
            title,
            body,
            fireAt: new Date(value.fireAt).toISOString(),
            ...(sourcePath ? { sourcePath } : {}),
        };
        const id = await sha256Base64URL(canonicalNotificationItem(unsignedItem));
        return { ...unsignedItem, id };
    }

    private boundedNotificationText(
        value: unknown,
        maximumBytes: number,
        fallback: string,
        allowsEmpty = false,
    ): string {
        let normalized = String(value ?? "")
            .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim();
        if (!normalized && !allowsEmpty) normalized = fallback;
        while (utf8ByteCount(normalized) > maximumBytes) {
            normalized = Array.from(normalized).slice(0, -1).join("").trimEnd();
        }
        return normalized;
    }

    private async refreshNativeNotificationSchedules(
        vaultName: string,
        clients: readonly StoredPairing[],
        items: readonly TishOSNativeNotificationItem[],
        reason: string,
    ): Promise<NativeNotificationRefreshOutcome> {
        let published = 0;
        let unchanged = 0;
        const readyClientIDs = new Set<string>();
        const failedClientIDs = new Set<string>();
        for (const pairing of clients) {
            try {
                const secret = this.readPairingSecret(pairing);
                if (!secret) throw new Error("Pairing secret is unavailable.");
                const path = this.nativeNotificationPath(pairing.clientID);
                await this.recoverNativeNotificationArtifacts(path, pairing, items, secret);
                const existingGeneratedAt = await this.validExistingNativeNotificationGeneratedAt(
                    path,
                    pairing,
                    items,
                    secret,
                );
                if (existingGeneratedAt) {
                    unchanged += 1;
                    readyClientIDs.add(pairing.clientID);
                    this.setNativeNotificationReady(pairing.clientID, items.length, existingGeneratedAt);
                    continue;
                }
                const generatedAt = new Date(this.now()).toISOString();
                const unsigned: Omit<TishOSNativeNotificationSchedule, "mac"> = {
                    schemaVersion: 2,
                    clientID: pairing.clientID,
                    vaultName,
                    generatedAt,
                    publisher: { id: this.publisher.id, version: this.publisher.version },
                    items: [...items],
                };
                const schedule: TishOSNativeNotificationSchedule = {
                    ...unsigned,
                    mac: await hmacSHA256Base64URL(secret, canonicalNotificationSchedule(unsigned)),
                };
                const serialized = `${JSON.stringify(schedule)}\n`;
                if (utf8ByteCount(serialized) > TISHOS_NATIVE_NOTIFICATION_MAX_FILE_BYTES) {
                    throw new Error("Native notification schedule exceeds its file bound.");
                }
                await this.publishNativeNotificationSchedule(
                    path,
                    pairing,
                    items,
                    secret,
                    serialized,
                    generatedAt,
                );
                published += 1;
                readyClientIDs.add(pairing.clientID);
                this.setNativeNotificationReady(pairing.clientID, items.length, generatedAt);
            } catch (error) {
                failedClientIDs.add(pairing.clientID);
                this.setNativeNotificationPending(pairing.clientID, "schedule-write-failed");
                logger.flowWarn("TishOSCommandBridge", "native-notification-refresh:client-failed", {
                    reason,
                    errorType: this.errorType(error),
                });
            }
        }
        logger.flow("TishOSCommandBridge", "native-notification-refresh:done", {
            reason,
            pairedClients: clients.length,
            projectedItems: items.length,
            publishedClients: published,
            unchangedClients: unchanged,
            failedClients: failedClientIDs.size,
        });
        return {
            readyClientIDs,
            failedClientIDs,
            publishedClients: published,
            unchangedClients: unchanged,
        };
    }

    private setNativeNotificationReady(clientID: string, itemCount: number, publishedAt: string): void {
        if (this.stopped) return;
        this.nativeNotificationStatusByClientID.set(clientID, {
            state: "ready",
            itemCount,
            publishedAt,
            reason: null,
        });
    }

    private setNativeNotificationPending(clientID: string, reason: string): void {
        if (this.stopped) return;
        const previous = this.nativeNotificationStatusByClientID.get(clientID);
        this.nativeNotificationStatusByClientID.set(clientID, {
            state: "pending",
            itemCount: previous?.itemCount ?? null,
            publishedAt: previous?.publishedAt ?? null,
            reason,
        });
    }

    private async processPairRequest(
        request: PairingRequest,
        lifecycle: number,
    ): Promise<TishOSCommandBridgeRouteResult> {
        if (!this.isLifecycleActive(lifecycle)) return this.reject("pair", "service-stopped", request.clientID);
        let approved = false;
        try {
            approved = await this.confirmPairing(request);
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "pair:confirmation-failed", {
                platform: request.platform,
                errorType: this.errorType(error),
            });
            return { accepted: false, reason: "confirmation-failure", clientID: request.clientID };
        }
        if (!this.isLifecycleActive(lifecycle)) return this.reject("pair", "service-stopped", request.clientID);
        if (!approved) {
            logger.flow("TishOSCommandBridge", "pair:cancelled", { platform: request.platform });
            return { accepted: false, reason: "user-cancelled", clientID: request.clientID };
        }

        const committed = await this.enqueueCommandRoute<PairingCommitResult>(
            () => this.commitPairingRequest(request, lifecycle),
            () => ({ result: this.reject("pair", "service-stopped", request.clientID) }),
            lifecycle,
        );
        if (!committed.result.accepted || !committed.generation) return committed.result;
        if (this.layoutReady && this.isLifecycleActive(lifecycle)) {
            const refresh = await this.refreshAfterPairing(request.clientID, committed.generation);
            if (
                this.isLifecycleActive(lifecycle)
                && (!refresh.readyPairings.some(
                    (ready) => ready.clientID === request.clientID && ready.generation === committed.generation,
                ) || this.pendingReturnGenerations.get(request.clientID) === committed.generation)
            ) {
                new Notice("Pairing was saved, but its signed command catalog and notification schedule are not both ready yet. TPS Controller will retry automatically.");
            }
        }
        return committed.result;
    }

    private async commitPairingRequest(
        request: PairingRequest,
        lifecycle: number,
    ): Promise<PairingCommitResult> {
        try {
            const pending = this.loadRevocationState().entries.find((entry) => entry.clientID === request.clientID);
            if (pending) {
                await this.settleActiveRefresh();
                if (!this.isLifecycleActive(lifecycle)) {
                    return { result: this.reject("pair", "service-stopped", request.clientID) };
                }
                if (!await this.retryPendingRevocation(request.clientID, "pairing-preflight")) {
                    return { result: this.reject("pair", "revocation-cleanup-pending", request.clientID) };
                }
                if (!this.isLifecycleActive(lifecycle)) {
                    return { result: this.reject("pair", "service-stopped", request.clientID) };
                }
            }
            const state = this.loadPairingState();
            const replayState = this.loadReplayState();
            const existingIndex = state.clients.findIndex((pairing) => pairing.clientID === request.clientID);
            if (existingIndex < 0 && state.clients.length >= MAX_PAIRED_CLIENTS) {
                return { result: this.reject("pair", "pairing-limit") };
            }
            if (!this.isLifecycleActive(lifecycle)) {
                return { result: this.reject("pair", "service-stopped", request.clientID) };
            }
            const existingPairing = existingIndex >= 0 ? state.clients[existingIndex] : null;
            const secretID = `tps-controller-command-bridge-${this.randomLocalToken()}`;
            const generation = this.randomLocalToken();
            const previousSecret = this.app.secretStorage.getSecret(secretID);
            const previousPairingValue = this.app.loadLocalStorage(this.pairingStorageKey());
            const previousReplayValue = this.app.loadLocalStorage(this.replayStorageKey());
            const pairedAt = new Date(this.now()).toISOString();
            const pairing: StoredPairing = {
                clientID: request.clientID,
                generation,
                platform: request.platform,
                device: request.device,
                secretID,
                pairedAt,
                commandCount: 0,
                returnPending: true,
            };
            if (existingIndex >= 0) state.clients[existingIndex] = pairing;
            else state.clients.push(pairing);
            state.clients.sort((left, right) => left.clientID < right.clientID ? -1 : left.clientID > right.clientID ? 1 : 0);
            replayState.entries = replayState.entries.filter((entry) => entry.clientID !== request.clientID);
            try {
                this.app.secretStorage.setSecret(secretID, request.secret);
                if (this.app.secretStorage.getSecret(secretID) !== request.secret) throw new Error("SecretStorage did not confirm the bridge secret.");
                this.savePairingState(state);
                this.saveReplayState(replayState);
                const persistedPairing = this.loadPairingState().clients.find((candidate) => candidate.clientID === request.clientID);
                if (
                    !persistedPairing
                    || persistedPairing.generation !== generation
                    || persistedPairing.secretID !== secretID
                    || persistedPairing.returnPending !== true
                    || this.loadReplayState().entries.some((entry) => entry.clientID === request.clientID)
                ) {
                    throw new Error("Vault-local storage did not confirm the command bridge pairing transaction.");
                }
            } catch (error) {
                try {
                    this.app.saveLocalStorage(this.pairingStorageKey(), previousPairingValue);
                    this.app.saveLocalStorage(this.replayStorageKey(), previousReplayValue);
                } catch (storageRollbackError) {
                    logger.flowWarn("TishOSCommandBridge", "pair:storage-rollback-failed", {
                        platform: request.platform,
                        errorType: this.errorType(storageRollbackError),
                    });
                }
                try {
                    this.app.secretStorage.setSecret(secretID, previousSecret || "");
                } catch (secretRollbackError) {
                    logger.flowWarn("TishOSCommandBridge", "pair:secret-rollback-failed", {
                        platform: request.platform,
                        errorType: this.errorType(secretRollbackError),
                    });
                }
                throw error;
            }
            if (existingPairing && existingPairing.secretID !== secretID) {
                try {
                    this.app.secretStorage.setSecret(existingPairing.secretID, "");
                    if (this.app.secretStorage.getSecret(existingPairing.secretID)) {
                        throw new Error("SecretStorage did not confirm retirement of the previous bridge secret.");
                    }
                } catch (error) {
                    logger.flowWarn("TishOSCommandBridge", "pair:retired-secret-clear-failed", {
                        platform: request.platform,
                        errorType: this.errorType(error),
                    });
                }
            }
            logger.flow("TishOSCommandBridge", "pair:accepted", {
                platform: request.platform,
                pairedClients: state.clients.length,
            });
            new Notice(`TishOS access approved for ${request.device}. Preparing its signed command catalog and notification schedule.`);
            this.pendingReturnGenerations.set(request.clientID, generation);
            this.nativeNotificationStatusByClientID.set(request.clientID, {
                state: "pending",
                itemCount: null,
                publishedAt: null,
                reason: "pairing-publication-pending",
            });
            return {
                result: { accepted: true, reason: "paired", clientID: request.clientID },
                generation,
            };
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "pair:failed", {
                platform: request.platform,
                errorType: this.errorType(error),
            });
            new Notice("TishOS command access could not be saved on this device.");
            return { result: { accepted: false, reason: "storage-failure", clientID: request.clientID } };
        }
    }

    private async processRunRoute(params: ProtocolParams, lifecycle: number): Promise<TishOSCommandBridgeRouteResult> {
        const validation = this.validateRunRoute(params);
        if (!validation.request) return this.reject("run", validation.reason);
        const request = validation.request;
        if (!this.isLifecycleActive(lifecycle)) return this.reject("run", "service-stopped", request.clientID);
        try {
            if (this.loadRevocationState().entries.some((entry) => entry.clientID === request.clientID)) {
                return this.reject("run", "revocation-pending", request.clientID);
            }
            const state = this.loadPairingState();
            const pairing = state.clients.find((candidate) => candidate.clientID === request.clientID);
            if (!pairing) return this.reject("run", "unknown-client", request.clientID);
            const secret = this.readPairingSecret(pairing);
            if (!secret) return this.reject("run", "secret-unavailable", request.clientID);
            if (!await verifyHmacSHA256Base64URL(
                secret,
                canonicalCommandRunRequest({
                    vaultName: request.vaultName,
                    clientID: request.clientID,
                    commandID: request.commandID,
                    entryDigest: request.entryDigest,
                    requestID: request.requestID,
                    issuedAt: request.issuedAt,
                }),
                request.mac,
            )) return this.reject("run", "bad-mac", request.clientID);
            if (!this.isLifecycleActive(lifecycle)) return this.reject("run", "service-stopped", request.clientID);

            const replayState = this.loadReplayState();
            if (replayState.entries.some((entry) => entry.clientID === request.clientID && entry.requestID === request.requestID)) {
                return this.reject("run", "replay", request.clientID);
            }
            const registryValues = listCommands(this.app);
            if (!registryValues) return this.reject("run", "command-registry-unavailable", request.clientID);
            const normalized = normalizeCommandRegistry(registryValues);
            if (normalized.rejectedForLimit) return this.reject("run", "command-limit", request.clientID);
            const command = normalized.commands.find((candidate) => candidate.id === request.commandID);
            if (!command) return this.reject("run", "command-unavailable", request.clientID);
            const currentDigest = await commandEntryDigest(command);
            if (!this.isLifecycleActive(lifecycle)) return this.reject("run", "service-stopped", request.clientID);
            if (currentDigest !== request.entryDigest) return this.reject("run", "stale-entry", request.clientID);

            if (!this.consumeReplayRequest(replayState, request.clientID, request.requestID)) {
                return this.reject("run", "replay-capacity", request.clientID);
            }
            const executed = executeCommandById(this.app, request.commandID);
            logger.flow("TishOSCommandBridge", executed ? "run:executed" : "run:execution-failed");
            if (!executed) new Notice("Obsidian accepted the TishOS request, but the selected command could not run in the current context.");
            return { accepted: true, reason: executed ? "executed" : "execution-failed", clientID: request.clientID, executed };
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "run:failed", { errorType: this.errorType(error) });
            new Notice("TishOS command request was rejected.");
            return { accepted: false, reason: "runtime-failure", clientID: request.clientID, executed: false };
        }
    }

    private async processNotificationActionRoute(
        params: ProtocolParams,
        lifecycle: number,
    ): Promise<TishOSCommandBridgeRouteResult> {
        const validation = this.validateNotificationActionRoute(params);
        if (!validation.request) return this.reject("notification-action", validation.reason);
        const request = validation.request;
        if (!this.isLifecycleActive(lifecycle)) {
            return this.reject("notification-action", "service-stopped", request.clientID);
        }
        try {
            if (this.loadRevocationState().entries.some((entry) => entry.clientID === request.clientID)) {
                return this.reject("notification-action", "revocation-pending", request.clientID);
            }
            const state = this.loadPairingState();
            const pairing = state.clients.find((candidate) => candidate.clientID === request.clientID);
            if (!pairing) return this.reject("notification-action", "unknown-client", request.clientID);
            const secret = this.readPairingSecret(pairing);
            if (!secret) return this.reject("notification-action", "secret-unavailable", request.clientID);
            if (!await verifyHmacSHA256Base64URL(
                secret,
                canonicalNotificationActionRequest({
                    vaultName: request.vaultName,
                    clientID: request.clientID,
                    itemID: request.itemID,
                    action: request.action,
                    requestID: request.requestID,
                    issuedAt: request.issuedAt,
                }),
                request.mac,
            )) return this.reject("notification-action", "bad-mac", request.clientID);
            if (!this.isLifecycleActive(lifecycle)) {
                return this.reject("notification-action", "service-stopped", request.clientID);
            }

            const replayState = this.loadReplayState();
            if (replayState.entries.some((entry) =>
                entry.clientID === request.clientID && entry.requestID === request.requestID
            )) return this.reject("notification-action", "replay", request.clientID);
            if (!this.notificationScheduleProvider || !this.completeNotification) {
                return this.reject("notification-action", "provider-unavailable", request.clientID);
            }
            const values = await this.notificationScheduleProvider();
            const matches: NativeNotificationProjectionValue[] = [];
            for (const value of values) {
                const item = await this.buildNativeNotificationItem(value);
                if (item?.id === request.itemID && value.completionTarget) matches.push(value);
            }
            if (!this.isLifecycleActive(lifecycle)) {
                return this.reject("notification-action", "service-stopped", request.clientID);
            }
            if (matches.length !== 1) {
                return this.reject(
                    "notification-action",
                    matches.length === 0 ? "item-unavailable" : "item-ambiguous",
                    request.clientID,
                );
            }
            if (!this.consumeReplayRequest(replayState, request.clientID, request.requestID)) {
                return this.reject("notification-action", "replay-capacity", request.clientID);
            }
            const executed = await this.completeNotification(matches[0]);
            logger.flow(
                "TishOSCommandBridge",
                executed ? "notification-action:completed" : "notification-action:execution-failed",
            );
            if (this.isLifecycleActive(lifecycle)) {
                new Notice(executed
                    ? "Completed from TishOS."
                    : "The reminder changed before it could be completed.");
            }
            return {
                accepted: true,
                reason: executed ? "completed" : "execution-failed",
                clientID: request.clientID,
                executed,
            };
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "notification-action:failed", {
                errorType: this.errorType(error),
            });
            if (this.isLifecycleActive(lifecycle)) new Notice("TishOS completion request was rejected.");
            return {
                accepted: false,
                reason: "runtime-failure",
                clientID: request.clientID,
                executed: false,
            };
        }
    }

    private async processRevokeRoute(params: ProtocolParams, lifecycle: number): Promise<TishOSCommandBridgeRouteResult> {
        const validation = this.validateRevokeRoute(params);
        if (!validation.request) return this.reject("revoke", validation.reason);
        const request = validation.request;
        if (!this.isLifecycleActive(lifecycle)) return this.reject("revoke", "service-stopped", request.clientID);
        try {
            if (this.loadRevocationState().entries.some((entry) => entry.clientID === request.clientID)) {
                return this.reject("revoke", "revocation-pending", request.clientID);
            }
            const state = this.loadPairingState();
            const pairing = state.clients.find((candidate) => candidate.clientID === request.clientID);
            if (!pairing) return this.reject("revoke", "unknown-client", request.clientID);
            const secret = this.readPairingSecret(pairing);
            if (!secret) return this.reject("revoke", "secret-unavailable", request.clientID);
            if (!await verifyHmacSHA256Base64URL(
                secret,
                canonicalCommandRevokeRequest({
                    vaultName: request.vaultName,
                    clientID: request.clientID,
                    requestID: request.requestID,
                    issuedAt: request.issuedAt,
                }),
                request.mac,
            )) return this.reject("revoke", "bad-mac", request.clientID);
            if (!this.isLifecycleActive(lifecycle)) return this.reject("revoke", "service-stopped", request.clientID);
            if (!await this.beginRevocation(request.clientID, lifecycle)) {
                return this.reject("revoke", "service-stopped", request.clientID);
            }
            await this.settleActiveRefresh();
            const cleaned = await this.retryPendingRevocation(request.clientID, "signed-route");
            if (this.isLifecycleActive(lifecycle)) {
                new Notice(cleaned
                    ? `TishOS command access revoked for ${pairing.device}.`
                    : `TishOS command access revoked for ${pairing.device}; local cleanup will retry automatically.`);
            }
            return {
                accepted: true,
                reason: cleaned ? "revoked" : "revocation-cleanup-pending",
                clientID: request.clientID,
            };
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "revoke:failed", { errorType: this.errorType(error) });
            new Notice("TishOS command access could not be revoked cleanly.");
            return { accepted: false, reason: "runtime-failure", clientID: request.clientID };
        }
    }

    private validatePairRoute(params: ProtocolParams): { request?: PairingRequest; reason: string } {
        const allowed = new Set(["action", "vault", "v", "expected-vault", "client", "secret", "platform", "device"]);
        const vaultName = this.app.vault.getName();
        if (!hasOnlyKeys(params, allowed)) return { reason: "unknown-or-malformed-parameter" };
        if (params.action !== TISHOS_COMMAND_BRIDGE_PAIR_ROUTE || params.v !== "1") return { reason: "route-or-version" };
        if (!isValidVaultName(params["expected-vault"])) return { reason: "invalid-vault" };
        if (
            !portableVaultNamesMatch(params["expected-vault"], vaultName)
            || (params.vault !== undefined && params.vault !== params["expected-vault"])
        ) return { reason: "wrong-vault" };
        const clientID = normalizeUUID(params.client || "");
        if (!clientID || params.client !== clientID) return { reason: "invalid-client" };
        const secret = params.secret || "";
        if (!isCanonicalBase64URLSHA256(secret)) return { reason: "invalid-secret" };
        if (!isValidPlatform(params.platform)) return { reason: "invalid-platform" };
        if (!isValidDeviceName(params.device)) return { reason: "invalid-device" };
        return {
            request: { vaultName, clientID, secret, platform: params.platform, device: params.device },
            reason: "valid",
        };
    }

    private validateRunRoute(params: ProtocolParams): { request?: TishOSCommandRunRequest; reason: string } {
        const allowed = new Set(["action", "vault", "v", "expected-vault", "client", "command", "entry", "request", "issuedAt", "mac"]);
        const vaultName = this.app.vault.getName();
        if (!hasOnlyKeys(params, allowed)) return { reason: "unknown-or-malformed-parameter" };
        if (params.action !== TISHOS_COMMAND_BRIDGE_RUN_ROUTE || params.v !== "1") return { reason: "route-or-version" };
        if (!isValidVaultName(params["expected-vault"])) return { reason: "invalid-vault" };
        if (
            !portableVaultNamesMatch(params["expected-vault"], vaultName)
            || (params.vault !== undefined && params.vault !== params["expected-vault"])
        ) return { reason: "wrong-vault" };
        const clientID = normalizeUUID(params.client || "");
        const requestID = normalizeUUID(params.request || "");
        if (!clientID || params.client !== clientID) return { reason: "invalid-client" };
        if (!requestID || params.request !== requestID) return { reason: "invalid-request" };
        if (!isValidCommandID(params.command)) return { reason: "invalid-command" };
        if (!isCanonicalBase64URLSHA256(params.entry || "")) return { reason: "invalid-entry" };
        if (!isCanonicalIssuedAt(params.issuedAt) || !isFreshIssuedAt(params.issuedAt, this.now())) return { reason: "stale-issued-at" };
        if (!isCanonicalBase64URLSHA256(params.mac || "")) return { reason: "invalid-mac" };
        return {
            request: {
                vaultName: params["expected-vault"],
                clientID,
                commandID: params.command,
                entryDigest: params.entry,
                requestID,
                issuedAt: params.issuedAt,
                mac: params.mac,
            },
            reason: "valid",
        };
    }

    private validateNotificationActionRoute(
        params: ProtocolParams,
    ): { request?: TishOSNotificationActionRequest; reason: string } {
        const allowed = new Set([
            "action", "operation", "vault", "v", "expected-vault", "client", "item",
            "request", "issuedAt", "mac",
        ]);
        const vaultName = this.app.vault.getName();
        if (!hasOnlyKeys(params, allowed)) return { reason: "unknown-or-malformed-parameter" };
        if (
            params.action !== TISHOS_NOTIFICATION_ACTION_ROUTE
            || params.operation !== "complete"
            || params.v !== "1"
        ) return { reason: "route-or-version" };
        if (!isValidVaultName(params["expected-vault"])) return { reason: "invalid-vault" };
        if (
            !portableVaultNamesMatch(params["expected-vault"], vaultName)
            || (params.vault !== undefined && params.vault !== params["expected-vault"])
        ) return { reason: "wrong-vault" };
        const clientID = normalizeUUID(params.client || "");
        const requestID = normalizeUUID(params.request || "");
        if (!clientID || params.client !== clientID) return { reason: "invalid-client" };
        if (!requestID || params.request !== requestID) return { reason: "invalid-request" };
        if (!isCanonicalBase64URLSHA256(params.item || "")) return { reason: "invalid-item" };
        if (!isCanonicalIssuedAt(params.issuedAt) || !isFreshIssuedAt(params.issuedAt, this.now())) {
            return { reason: "stale-issued-at" };
        }
        if (!isCanonicalBase64URLSHA256(params.mac || "")) return { reason: "invalid-mac" };
        return {
            request: {
                vaultName: params["expected-vault"],
                clientID,
                itemID: params.item,
                action: "complete",
                requestID,
                issuedAt: params.issuedAt,
                mac: params.mac,
            },
            reason: "valid",
        };
    }

    private validateRevokeRoute(params: ProtocolParams): { request?: TishOSCommandRevokeRequest; reason: string } {
        const allowed = new Set(["action", "vault", "v", "expected-vault", "client", "request", "issuedAt", "mac"]);
        const vaultName = this.app.vault.getName();
        if (!hasOnlyKeys(params, allowed)) return { reason: "unknown-or-malformed-parameter" };
        if (params.action !== TISHOS_COMMAND_BRIDGE_REVOKE_ROUTE || params.v !== "1") return { reason: "route-or-version" };
        if (!isValidVaultName(params["expected-vault"])) return { reason: "invalid-vault" };
        if (
            !portableVaultNamesMatch(params["expected-vault"], vaultName)
            || (params.vault !== undefined && params.vault !== params["expected-vault"])
        ) return { reason: "wrong-vault" };
        const clientID = normalizeUUID(params.client || "");
        const requestID = normalizeUUID(params.request || "");
        if (!clientID || params.client !== clientID) return { reason: "invalid-client" };
        if (!requestID || params.request !== requestID) return { reason: "invalid-request" };
        if (!isCanonicalIssuedAt(params.issuedAt) || !isFreshIssuedAt(params.issuedAt, this.now())) return { reason: "stale-issued-at" };
        if (!isCanonicalBase64URLSHA256(params.mac || "")) return { reason: "invalid-mac" };
        return {
            request: {
                vaultName: params["expected-vault"],
                clientID,
                requestID,
                issuedAt: params.issuedAt,
                mac: params.mac,
            },
            reason: "valid",
        };
    }

    private reject(route: string, reason: string, clientID?: string): TishOSCommandBridgeRouteResult {
        logger.flowWarn("TishOSCommandBridge", `${route}:rejected`, { reason });
        return { accepted: false, reason, clientID };
    }

    private beginRevocation(clientID: string, lifecycle: number): Promise<boolean> {
        return this.enqueueRevocation(async () => {
            if (!this.isLifecycleActive(lifecycle)) return false;
            const state = this.loadPairingState();
            const pairing = state.clients.find((candidate) => candidate.clientID === clientID);
            const revocations = this.loadRevocationState();
            if (revocations.entries.some((candidate) => candidate.clientID === clientID)) {
                this.pendingReturnGenerations.delete(clientID);
                this.nativeNotificationStatusByClientID.delete(clientID);
                return true;
            }
            if (!pairing) return false;
            if (revocations.entries.length >= MAX_REVOCATION_ENTRIES) {
                throw new Error("Command bridge revocation cleanup queue is full.");
            }
            if (!this.isLifecycleActive(lifecycle)) return false;
            revocations.entries.push({
                clientID,
                secretID: pairing.secretID,
                createdAt: new Date(this.now()).toISOString(),
            });
            revocations.entries.sort((left, right) => left.clientID < right.clientID ? -1 : left.clientID > right.clientID ? 1 : 0);
            this.saveRevocationState(revocations);
            const persisted = this.loadRevocationState().entries.find((candidate) => candidate.clientID === clientID);
            if (
                !persisted
                || persisted.secretID !== pairing.secretID
                || persisted.createdAt !== revocations.entries.find((candidate) => candidate.clientID === clientID)?.createdAt
            ) {
                throw new Error("Vault-local storage did not confirm the command bridge revocation tombstone.");
            }
            this.pendingReturnGenerations.delete(clientID);
            this.nativeNotificationStatusByClientID.delete(clientID);
            return true;
        });
    }

    private retryPendingRevocation(clientID: string, source: string): Promise<boolean> {
        return this.enqueueRevocation(async () => {
            const revocation = this.loadRevocationState().entries.find((candidate) => candidate.clientID === clientID);
            return revocation ? this.retryRevocationUnlocked(revocation, source) : true;
        });
    }

    private retryPendingRevocations(source: string): Promise<void> {
        return this.enqueueRevocation(async () => {
            const pending = [...this.loadRevocationState().entries];
            if (!pending.length) return;
            let completed = 0;
            for (const revocation of pending) {
                if (await this.retryRevocationUnlocked(revocation, source)) completed += 1;
            }
            logger.flow("TishOSCommandBridge", "revoke:cleanup-pass", {
                source,
                pending: pending.length - completed,
                completed,
            });
        });
    }

    private async retryRevocationUnlocked(revocation: StoredRevocation, source: string): Promise<boolean> {
        let complete = true;
        try {
            const state = this.loadPairingState();
            const pairing = state.clients.find((candidate) => candidate.clientID === revocation.clientID);
            if (pairing && pairing.secretID !== revocation.secretID) {
                logger.flowWarn("TishOSCommandBridge", "revoke:pairing-generation-conflict", { source });
                return false;
            }
            if (pairing) {
                state.clients = state.clients.filter((candidate) => candidate.clientID !== revocation.clientID);
                this.savePairingState(state);
            }
        } catch (error) {
            complete = false;
            logger.flowWarn("TishOSCommandBridge", "revoke:pairing-cleanup-failed", {
                source,
                errorType: this.errorType(error),
            });
        }
        this.pendingReturnGenerations.delete(revocation.clientID);
        this.nativeNotificationStatusByClientID.delete(revocation.clientID);

        try {
            const replay = this.loadReplayState();
            const retained = replay.entries.filter((entry) => entry.clientID !== revocation.clientID);
            if (retained.length !== replay.entries.length) {
                replay.entries = retained;
                this.saveReplayState(replay);
            }
        } catch (error) {
            complete = false;
            logger.flowWarn("TishOSCommandBridge", "revoke:replay-cleanup-failed", {
                source,
                errorType: this.errorType(error),
            });
        }

        try {
            const existingSecret = this.app.secretStorage.getSecret(revocation.secretID);
            if (existingSecret) this.app.secretStorage.setSecret(revocation.secretID, "");
            if (this.app.secretStorage.getSecret(revocation.secretID)) {
                throw new Error("SecretStorage did not confirm command bridge revocation.");
            }
        } catch (error) {
            complete = false;
            logger.flowWarn("TishOSCommandBridge", "revoke:secret-clear-failed", {
                source,
                errorType: this.errorType(error),
            });
        }

        const artifactPaths = [
            this.catalogPath(revocation.clientID),
            this.catalogStagingPath(revocation.clientID),
            this.catalogBackupPath(revocation.clientID),
            this.nativeNotificationPath(revocation.clientID),
            this.nativeNotificationStagingPath(revocation.clientID),
            this.nativeNotificationBackupPath(revocation.clientID),
        ];
        for (const path of artifactPaths) {
            try {
                if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
                if (await this.app.vault.adapter.exists(path)) throw new Error("Command bridge catalog artifact remains after removal.");
            } catch (error) {
                complete = false;
                logger.flowWarn("TishOSCommandBridge", "revoke:catalog-cleanup-failed", {
                    source,
                    errorType: this.errorType(error),
                });
                if (
                    path === this.catalogPath(revocation.clientID)
                    || path === this.nativeNotificationPath(revocation.clientID)
                ) {
                    try {
                        await this.app.vault.adapter.write(path, "{}\n");
                    } catch (invalidateError) {
                        logger.flowWarn("TishOSCommandBridge", "revoke:catalog-invalidate-failed", {
                            source,
                            errorType: this.errorType(invalidateError),
                        });
                    }
                }
            }
        }

        if (complete) {
            try {
                if (this.loadPairingState().clients.some((candidate) => candidate.clientID === revocation.clientID)) {
                    throw new Error("Pairing authority remains after command bridge revocation.");
                }
                if (this.loadReplayState().entries.some((entry) => entry.clientID === revocation.clientID)) {
                    throw new Error("Replay state remains after command bridge revocation.");
                }
                if (this.app.secretStorage.getSecret(revocation.secretID)) {
                    throw new Error("Secret remains after command bridge revocation.");
                }
                for (const path of artifactPaths) {
                    if (await this.app.vault.adapter.exists(path)) {
                        throw new Error("Catalog artifact remains after command bridge revocation.");
                    }
                }
            } catch (error) {
                complete = false;
                logger.flowWarn("TishOSCommandBridge", "revoke:cleanup-verification-failed", {
                    source,
                    errorType: this.errorType(error),
                });
            }
        }

        if (complete) {
            try {
                const latest = this.loadRevocationState();
                latest.entries = latest.entries.filter((candidate) => candidate.clientID !== revocation.clientID);
                this.saveRevocationState(latest);
                if (this.loadRevocationState().entries.some((candidate) => candidate.clientID === revocation.clientID)) {
                    throw new Error("Vault-local storage did not confirm command bridge revocation cleanup.");
                }
            } catch (error) {
                complete = false;
                logger.flowWarn("TishOSCommandBridge", "revoke:tombstone-cleanup-failed", {
                    source,
                    errorType: this.errorType(error),
                });
            }
        }
        logger.flow("TishOSCommandBridge", complete ? "revoke:done" : "revoke:cleanup-pending", { source });
        return complete;
    }

    private consumeReplayRequest(state: StoredReplayState, clientID: string, requestID: string): boolean {
        const now = this.now();
        const retained = state.entries.filter((entry) => now - entry.seenAt <= REPLAY_RETENTION_MS);
        if (retained.length >= MAX_REPLAY_ENTRIES) return false;
        state.entries = retained.concat({ clientID, requestID, seenAt: now });
        this.saveReplayState(state);
        const persisted = this.loadReplayState().entries.filter(
            (entry) => entry.clientID === clientID && entry.requestID === requestID,
        );
        if (persisted.length !== 1 || persisted[0].seenAt !== now) {
            throw new Error("Vault-local storage did not confirm command bridge replay consumption.");
        }
        return true;
    }

    private readPairingSecret(pairing: StoredPairing): Uint8Array | null {
        try {
            const encoded = this.app.secretStorage.getSecret(pairing.secretID) || "";
            if (!isCanonicalBase64URLSHA256(encoded)) return null;
            const secret = decodeBase64URL(encoded);
            return secret.byteLength === 32 ? secret : null;
        } catch {
            return null;
        }
    }

    private randomLocalToken(): string {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    private catalogPath(clientID: string): string {
        return `${TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${clientID}.json`;
    }

    private catalogStagingPath(clientID: string): string {
        return `${TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/.${clientID}.pending`;
    }

    private catalogBackupPath(clientID: string): string {
        return `${TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/.${clientID}.backup`;
    }

    private nativeNotificationPath(clientID: string): string {
        return `${TISHOS_NATIVE_NOTIFICATION_ROOT}/${clientID}.json`;
    }

    private nativeNotificationStagingPath(clientID: string): string {
        return `${TISHOS_NATIVE_NOTIFICATION_ROOT}/.${clientID}.pending`;
    }

    private nativeNotificationBackupPath(clientID: string): string {
        return `${TISHOS_NATIVE_NOTIFICATION_ROOT}/.${clientID}.backup`;
    }

    private async ensureCatalogDirectory(): Promise<void> {
        for (const path of [".tishos", ".tishos/command-bridge", TISHOS_COMMAND_BRIDGE_CATALOG_ROOT]) {
            if (await this.app.vault.adapter.exists(path)) continue;
            try {
                await this.app.vault.adapter.mkdir(path);
            } catch (error) {
                if (!await this.app.vault.adapter.exists(path)) throw error;
            }
        }
    }

    private async ensureNativeNotificationDirectory(): Promise<void> {
        for (const path of [".tishos", ".tishos/native-notifications", TISHOS_NATIVE_NOTIFICATION_ROOT]) {
            if (await this.app.vault.adapter.exists(path)) continue;
            try {
                await this.app.vault.adapter.mkdir(path);
            } catch (error) {
                if (!await this.app.vault.adapter.exists(path)) throw error;
            }
        }
    }

    private async publishNativeNotificationSchedule(
        path: string,
        pairing: StoredPairing,
        items: readonly TishOSNativeNotificationItem[],
        secret: Uint8Array,
        serialized: string,
        generatedAt: string,
    ): Promise<void> {
        await this.ensureNativeNotificationDirectory();
        const stagingPath = this.nativeNotificationStagingPath(pairing.clientID);
        const backupPath = this.nativeNotificationBackupPath(pairing.clientID);
        try {
            if (await this.app.vault.adapter.exists(stagingPath)) await this.app.vault.adapter.remove(stagingPath);
            await this.app.vault.adapter.write(stagingPath, serialized);
            if (await this.validExistingNativeNotificationGeneratedAt(stagingPath, pairing, items, secret) !== generatedAt) {
                throw new Error("Staged native notification schedule verification failed.");
            }
            const previous = await this.readBoundedNativeNotificationFile(path);
            if (previous !== null) {
                if (await this.app.vault.adapter.exists(backupPath)) await this.app.vault.adapter.remove(backupPath);
                await this.app.vault.adapter.copy(path, backupPath);
                if (await this.readBoundedNativeNotificationFile(backupPath) !== previous) {
                    throw new Error("Native notification schedule backup verification failed.");
                }
            }
            if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
            try {
                await this.app.vault.adapter.rename(stagingPath, path);
            } catch (error) {
                await this.restoreNativeNotificationBackup(path, backupPath);
                throw error;
            }
            if (await this.validExistingNativeNotificationGeneratedAt(path, pairing, items, secret) !== generatedAt) {
                await this.restoreNativeNotificationBackup(path, backupPath);
                throw new Error("Published native notification schedule verification failed.");
            }
            if (await this.app.vault.adapter.exists(backupPath)) await this.app.vault.adapter.remove(backupPath);
        } finally {
            if (await this.app.vault.adapter.exists(stagingPath)) {
                try {
                    await this.app.vault.adapter.remove(stagingPath);
                } catch (error) {
                    logger.flowWarn("TishOSCommandBridge", "native-notification-refresh:staging-cleanup-failed", {
                        errorType: this.errorType(error),
                    });
                }
            }
        }
    }

    private async recoverNativeNotificationArtifacts(
        path: string,
        pairing: StoredPairing,
        items: readonly TishOSNativeNotificationItem[],
        secret: Uint8Array,
    ): Promise<void> {
        const stagingPath = this.nativeNotificationStagingPath(pairing.clientID);
        const backupPath = this.nativeNotificationBackupPath(pairing.clientID);
        if (await this.app.vault.adapter.exists(stagingPath)) await this.app.vault.adapter.remove(stagingPath);
        if (!await this.app.vault.adapter.exists(backupPath)) return;
        if (await this.readBoundedNativeNotificationFile(backupPath) === null) {
            await this.app.vault.adapter.remove(backupPath);
            return;
        }
        if (!await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.rename(backupPath, path);
            return;
        }
        if (await this.validExistingNativeNotificationGeneratedAt(path, pairing, items, secret)) {
            await this.app.vault.adapter.remove(backupPath);
            return;
        }
        if (await this.validExistingNativeNotificationGeneratedAt(backupPath, pairing, items, secret)) {
            await this.app.vault.adapter.remove(path);
            await this.app.vault.adapter.rename(backupPath, path);
            return;
        }
        await this.app.vault.adapter.remove(backupPath);
    }

    private async restoreNativeNotificationBackup(path: string, backupPath: string): Promise<void> {
        if (!await this.app.vault.adapter.exists(backupPath)) return;
        if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
        await this.app.vault.adapter.rename(backupPath, path);
    }

    private async readBoundedNativeNotificationFile(path: string): Promise<string | null> {
        const stat = await this.app.vault.adapter.stat(path);
        if (
            !stat
            || stat.type !== "file"
            || !Number.isSafeInteger(stat.size)
            || stat.size < 0
            || stat.size > TISHOS_NATIVE_NOTIFICATION_MAX_FILE_BYTES
        ) return null;
        const content = await this.app.vault.adapter.read(path);
        return utf8ByteCount(content) <= TISHOS_NATIVE_NOTIFICATION_MAX_FILE_BYTES ? content : null;
    }

    private async validExistingNativeNotificationGeneratedAt(
        path: string,
        pairing: StoredPairing,
        expectedItems: readonly TishOSNativeNotificationItem[],
        secret: Uint8Array,
    ): Promise<string | null> {
        try {
            const content = await this.readBoundedNativeNotificationFile(path);
            if (content === null) return null;
            const value = JSON.parse(content);
            if (!isRecord(value) || !hasExactKeys(value, [
                "schemaVersion", "clientID", "vaultName", "generatedAt", "publisher", "items", "mac",
            ])) return null;
            if (
                value.schemaVersion !== 2
                || value.clientID !== pairing.clientID
                || value.vaultName !== this.app.vault.getName()
                || !isCanonicalGeneratedAt(value.generatedAt)
                || !isRecord(value.publisher)
                || !hasExactKeys(value.publisher, ["id", "version"])
                || value.publisher.id !== this.publisher.id
                || value.publisher.version !== this.publisher.version
                || !Array.isArray(value.items)
                || value.items.length !== expectedItems.length
                || !isCanonicalBase64URLSHA256(String(value.mac || ""))
            ) return null;
            for (let index = 0; index < expectedItems.length; index += 1) {
                const actual = value.items[index];
                const expected = expectedItems[index];
                if (!isRecord(actual)) return null;
                const expectedKeys = expected.sourcePath
                    ? ["id", "seriesID", "title", "body", "fireAt", "sourcePath"]
                    : ["id", "seriesID", "title", "body", "fireAt"];
                if (!hasExactKeys(actual, expectedKeys)) return null;
                if (
                    actual.id !== expected.id
                    || actual.seriesID !== expected.seriesID
                    || actual.title !== expected.title
                    || actual.body !== expected.body
                    || actual.fireAt !== expected.fireAt
                    || actual.sourcePath !== expected.sourcePath
                    || await sha256Base64URL(canonicalNotificationItem(actual as unknown as TishOSNativeNotificationItem)) !== expected.id
                ) return null;
            }
            const items = value.items as TishOSNativeNotificationItem[];
            if (validateNotificationItems(items) === null) return null;
            const unsigned: Omit<TishOSNativeNotificationSchedule, "mac"> = {
                schemaVersion: 2,
                clientID: value.clientID as string,
                vaultName: value.vaultName as string,
                generatedAt: value.generatedAt as string,
                publisher: {
                    id: value.publisher.id as string,
                    version: value.publisher.version as string,
                },
                items,
            };
            return await verifyHmacSHA256Base64URL(
                secret,
                canonicalNotificationSchedule(unsigned),
                String(value.mac),
            ) ? unsigned.generatedAt : null;
        } catch {
            return null;
        }
    }

    private async publishCatalog(
        path: string,
        pairing: StoredPairing,
        entries: readonly TishOSCommandCatalogEntry[],
        secret: Uint8Array,
        serialized: string,
        generatedAt: string,
    ): Promise<void> {
        await this.ensureCatalogDirectory();
        const stagingPath = this.catalogStagingPath(pairing.clientID);
        const backupPath = this.catalogBackupPath(pairing.clientID);
        try {
            if (await this.app.vault.adapter.exists(stagingPath)) {
                await this.app.vault.adapter.remove(stagingPath);
            }
            await this.app.vault.adapter.write(stagingPath, serialized);
            if (await this.validExistingCatalogGeneratedAt(stagingPath, pairing, entries, secret) !== generatedAt) {
                throw new Error("Staged catalog verification failed.");
            }
            const previous = await this.readBoundedRegularFile(path);
            if (previous !== null) {
                if (await this.app.vault.adapter.exists(backupPath)) {
                    await this.app.vault.adapter.remove(backupPath);
                }
                await this.app.vault.adapter.copy(path, backupPath);
                if (await this.readBoundedRegularFile(backupPath) !== previous) {
                    throw new Error("Catalog backup verification failed.");
                }
            }
            if (await this.app.vault.adapter.exists(path)) {
                await this.app.vault.adapter.remove(path);
            }
            try {
                await this.app.vault.adapter.rename(stagingPath, path);
            } catch (error) {
                await this.restoreCatalogBackup(path, backupPath);
                throw error;
            }
            if (await this.validExistingCatalogGeneratedAt(path, pairing, entries, secret) !== generatedAt) {
                await this.restoreCatalogBackup(path, backupPath);
                throw new Error("Published catalog verification failed.");
            }
            if (await this.app.vault.adapter.exists(backupPath)) {
                await this.app.vault.adapter.remove(backupPath);
            }
        } finally {
            try {
                if (await this.app.vault.adapter.exists(stagingPath)) {
                    await this.app.vault.adapter.remove(stagingPath);
                }
            } catch (error) {
                logger.flowWarn("TishOSCommandBridge", "catalog-refresh:staging-cleanup-failed", {
                    errorType: this.errorType(error),
                });
            }
        }
    }

    private async recoverCatalogArtifacts(
        path: string,
        pairing: StoredPairing,
        entries: readonly TishOSCommandCatalogEntry[],
        secret: Uint8Array,
    ): Promise<void> {
        const stagingPath = this.catalogStagingPath(pairing.clientID);
        const backupPath = this.catalogBackupPath(pairing.clientID);
        if (await this.app.vault.adapter.exists(stagingPath)) {
            await this.app.vault.adapter.remove(stagingPath);
        }
        if (!await this.app.vault.adapter.exists(backupPath)) return;
        const backup = await this.readBoundedRegularFile(backupPath);
        if (backup === null) {
            await this.app.vault.adapter.remove(backupPath);
            return;
        }
        if (!await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.rename(backupPath, path);
            return;
        }
        if (await this.validExistingCatalogGeneratedAt(path, pairing, entries, secret) !== null) {
            await this.app.vault.adapter.remove(backupPath);
            return;
        }
        if (await this.validExistingCatalogGeneratedAt(backupPath, pairing, entries, secret) !== null) {
            await this.app.vault.adapter.remove(path);
            await this.app.vault.adapter.rename(backupPath, path);
            return;
        }
        await this.app.vault.adapter.remove(backupPath);
    }

    private async restoreCatalogBackup(path: string, backupPath: string): Promise<void> {
        if (!await this.app.vault.adapter.exists(backupPath)) return;
        if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
        await this.app.vault.adapter.rename(backupPath, path);
    }

    private async readBoundedRegularFile(path: string): Promise<string | null> {
        const stat = await this.app.vault.adapter.stat(path);
        if (
            !stat
            || stat.type !== "file"
            || !Number.isSafeInteger(stat.size)
            || stat.size < 0
            || stat.size > TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES
        ) return null;
        const content = await this.app.vault.adapter.read(path);
        return utf8ByteCount(content) <= TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES ? content : null;
    }

    private async validExistingCatalogGeneratedAt(
        path: string,
        pairing: StoredPairing,
        expectedCommands: readonly TishOSCommandCatalogEntry[],
        secret: Uint8Array,
    ): Promise<string | null> {
        try {
            const content = await this.readBoundedRegularFile(path);
            if (content === null) return null;
            const value = JSON.parse(content);
            if (!isRecord(value) || !hasExactKeys(value, [
                "schemaVersion",
                "clientID",
                "vaultName",
                "generatedAt",
                "publisher",
                "commands",
                "mac",
            ])) return null;
            if (
                value.schemaVersion !== 1
                || value.clientID !== pairing.clientID
                || value.vaultName !== this.app.vault.getName()
                || !isCanonicalGeneratedAt(value.generatedAt)
                || !isRecord(value.publisher)
                || !hasExactKeys(value.publisher, ["id", "version"])
                || value.publisher.id !== this.publisher.id
                || value.publisher.version !== this.publisher.version
                || !Array.isArray(value.commands)
                || value.commands.length !== expectedCommands.length
                || !isCanonicalBase64URLSHA256(String(value.mac || ""))
            ) return null;
            for (let index = 0; index < expectedCommands.length; index += 1) {
                const actual = value.commands[index];
                const expected = expectedCommands[index];
                if (
                    !isRecord(actual)
                    || !hasExactKeys(actual, ["id", "name", "digest"])
                    || actual.id !== expected.id
                    || actual.name !== expected.name
                    || actual.digest !== expected.digest
                ) return null;
            }
            const unsigned: Omit<TishOSCommandCatalog, "mac"> = {
                schemaVersion: 1,
                clientID: value.clientID,
                vaultName: value.vaultName,
                generatedAt: value.generatedAt,
                publisher: { id: value.publisher.id as string, version: value.publisher.version as string },
                commands: value.commands as TishOSCommandCatalogEntry[],
            };
            const valid = await verifyHmacSHA256Base64URL(secret, canonicalCommandCatalog(unsigned), String(value.mac));
            return valid ? value.generatedAt : null;
        } catch {
            return null;
        }
    }

    private async refreshAfterPairing(clientID: string, generation: string): Promise<TishOSCommandBridgeRefreshOutcome> {
        await this.settleActiveRefresh();
        const result = await this.refreshCatalogs("pairing");
        logger.flow("TishOSCommandBridge", "pair:catalog-attempt-settled", {
            clientReady: result.readyPairings.some(
                (ready) => ready.clientID === clientID && ready.generation === generation,
            ),
            publishedClients: result.publishedClients,
            unchangedClients: result.unchangedClients,
            failedClients: result.failedClients,
            unavailableReason: result.unavailableReason || null,
        });
        return result;
    }

    private async settleActiveRefresh(): Promise<void> {
        const active = this.refreshPromise;
        if (!active) return;
        await active;
        if (this.refreshPromise === active) this.refreshPromise = null;
    }

    private returnToTishOSIfReady(
        readyPairings: ReadonlyArray<{ clientID: string; generation: string }>,
    ): void {
        if (this.stopped) return;
        const readyPending = readyPairings.filter(
            (ready) => this.pendingReturnGenerations.get(ready.clientID) === ready.generation,
        );
        if (!readyPending.length || !this.savePendingReturnState(readyPending, false)) return;
        if (this.returnToTishOS()) {
            for (const ready of readyPending) this.pendingReturnGenerations.delete(ready.clientID);
            return;
        }
        this.savePendingReturnState(readyPending, true);
    }

    private restorePendingReturnClients(): void {
        try {
            const revoking = new Set(this.loadRevocationState().entries.map((entry) => entry.clientID));
            for (const pairing of this.loadPairingState().clients) {
                if (pairing.returnPending === true && !revoking.has(pairing.clientID)) {
                    this.pendingReturnGenerations.set(pairing.clientID, pairing.generation);
                }
            }
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "pair:return-state-unavailable", {
                errorType: this.errorType(error),
            });
        }
    }

    private savePendingReturnState(
        readyPairings: ReadonlyArray<{ clientID: string; generation: string }>,
        pending: boolean,
    ): boolean {
        try {
            const state = this.loadPairingState();
            const revoking = new Set(this.loadRevocationState().entries.map((entry) => entry.clientID));
            const generations = new Map(readyPairings.map((ready) => [ready.clientID, ready.generation]));
            let changed = false;
            let matched = false;
            for (const pairing of state.clients) {
                if (revoking.has(pairing.clientID)) continue;
                if (generations.get(pairing.clientID) !== pairing.generation) continue;
                matched = true;
                if (pending) {
                    if (pairing.returnPending === true) continue;
                    pairing.returnPending = true;
                } else {
                    if (pairing.returnPending === undefined) continue;
                    delete pairing.returnPending;
                }
                changed = true;
            }
            if (changed) this.savePairingState(state);
            return matched;
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "pair:return-state-save-failed", {
                pending,
                errorType: this.errorType(error),
            });
            return false;
        }
    }

    private returnToTishOS(): boolean {
        logger.flow("TishOSCommandBridge", "pair:return-to-tishos");
        try {
            window.open("tishos://settings?section=command-bridge");
            return true;
        } catch (error) {
            logger.flowWarn("TishOSCommandBridge", "pair:return-failed", { errorType: this.errorType(error) });
            return false;
        }
    }

    private pairingStorageKey(): string {
        return "tps-controller:command-bridge:pairings:v1";
    }

    private replayStorageKey(): string {
        return "tps-controller:command-bridge:replay:v1";
    }

    private revocationStorageKey(): string {
        return "tps-controller:command-bridge:revocations:v1";
    }

    private loadPairingState(): StoredPairingState {
        const vaultName = this.app.vault.getName();
        const value = this.app.loadLocalStorage(this.pairingStorageKey());
        if (value === null) return { schemaVersion: 1, vaultName, clients: [] };
        if (!pairingStateIsValid(value, vaultName)) throw new Error("Invalid device-local command bridge pairing state.");
        return value;
    }

    private savePairingState(state: StoredPairingState): void {
        if (!pairingStateIsValid(state, this.app.vault.getName())) throw new Error("Refusing invalid command bridge pairing state.");
        this.app.saveLocalStorage(this.pairingStorageKey(), state.clients.length ? state : null);
    }

    private loadReplayState(): StoredReplayState {
        const vaultName = this.app.vault.getName();
        const value = this.app.loadLocalStorage(this.replayStorageKey());
        if (value === null) return { schemaVersion: 1, vaultName, entries: [] };
        if (!replayStateIsValid(value, vaultName)) throw new Error("Invalid device-local command bridge replay state.");
        return value;
    }

    private saveReplayState(state: StoredReplayState): void {
        if (!replayStateIsValid(state, this.app.vault.getName())) throw new Error("Refusing invalid command bridge replay state.");
        this.app.saveLocalStorage(this.replayStorageKey(), state.entries.length ? state : null);
    }

    private loadRevocationState(): StoredRevocationState {
        const vaultName = this.app.vault.getName();
        const value = this.app.loadLocalStorage(this.revocationStorageKey());
        if (value === null) return { schemaVersion: 1, vaultName, entries: [] };
        if (!revocationStateIsValid(value, vaultName)) throw new Error("Invalid device-local command bridge revocation state.");
        return value;
    }

    private saveRevocationState(state: StoredRevocationState): void {
        if (!revocationStateIsValid(state, this.app.vault.getName())) {
            throw new Error("Refusing invalid command bridge revocation state.");
        }
        this.app.saveLocalStorage(this.revocationStorageKey(), state.entries.length ? state : null);
    }

    private errorType(error: unknown): string {
        return error instanceof Error ? error.name : typeof error;
    }

    private unavailableRefresh(reason: string, pairedClients = 0): TishOSCommandBridgeRefreshOutcome {
        return {
            pairedClients,
            publishedClients: 0,
            unchangedClients: 0,
            failedClients: 0,
            commandCount: 0,
            invalidCommands: 0,
            ambiguousCommands: 0,
            readyPairings: [],
            unavailableReason: reason,
        };
    }

    private isLifecycleActive(lifecycle: number): boolean {
        return !this.stopped && lifecycle === this.lifecycleGeneration;
    }

    private samePairingRequest(left: PairingRequest, right: PairingRequest): boolean {
        return left.vaultName === right.vaultName
            && left.clientID === right.clientID
            && left.secret === right.secret
            && left.platform === right.platform
            && left.device === right.device;
    }

    private enqueueCommandRoute<T>(
        action: () => Promise<T>,
        stoppedResult: () => T,
        lifecycle: number,
    ): Promise<T> {
        const run = (): Promise<T> => this.isLifecycleActive(lifecycle)
            ? action()
            : Promise.resolve(stoppedResult());
        const operation = this.commandRouteQueue.then(run, run);
        this.commandRouteQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private enqueueRevocation<T>(action: () => Promise<T>): Promise<T> {
        const operation = this.revocationQueue.then(action, action);
        this.revocationQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }
}
