import type { IncomingMessage } from "http";
import {
    hmacSHA256Base64URL,
    utf8ByteCount,
    verifyHmacSHA256Base64URL,
} from "./tishos-command-bridge-contract";
import {
    NATIVE_MAC_REFRESH_BODY_LIMIT,
    NATIVE_MAC_REFRESH_PATH,
    NATIVE_MAC_REFRESH_PORT,
    canonicalNativeMacRefreshRequest,
    canonicalNativeMacRefreshResponse,
    parseNativeMacRefreshResponse,
} from "./tishos-native-mac-refresh-contract";

export interface NativeMacRefreshIntent {
    vaultName: string;
    clientID: string;
    generation: string;
    lifecycle: number;
}

export type NativeMacRefreshTransport = (body: string, signal: AbortSignal) => Promise<{ status: number; body: string }>;
interface PendingSignal { intent: NativeMacRefreshIntent; attempts: number }
interface SenderOptions {
    enabled: () => boolean;
    resolveSecret: (intent: NativeMacRefreshIntent) => Uint8Array | null;
    transport?: NativeMacRefreshTransport;
    now?: () => number;
    requestID?: () => string;
    onOutcome?: (status: "queued" | "unavailable") => void;
    requestTimeoutMs?: number;
    minIntervalMs?: number;
    retryDelayMs?: number;
}

/** Loaded only when an enabled desktop sender actually transmits. No browser
 * fetch, redirects, proxy configuration, Origin header, or caller-selected URL. */
export const sendNativeMacRefreshHTTP: NativeMacRefreshTransport = (body, signal) => {
    const http: typeof import("http") = require("http");
    return new Promise((resolve, reject) => {
        if (signal.aborted || utf8ByteCount(body) > NATIVE_MAC_REFRESH_BODY_LIMIT) {
            reject(new Error("Native refresh unavailable")); return;
        }
        let settled = false;
        const request = http.request({ host: "127.0.0.1", port: NATIVE_MAC_REFRESH_PORT,
            path: NATIVE_MAC_REFRESH_PATH, method: "POST", agent: false, maxHeaderSize: 4096,
            headers: { "Content-Type": "application/json", "Content-Length": utf8ByteCount(body), Connection: "close" } });
        const finish = (value?: { status: number; body: string }) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            if (value) resolve(value); else reject(new Error("Native refresh unavailable"));
        };
        const abort = () => { finish(); request.destroy(); };
        signal.addEventListener("abort", abort, { once: true });
        request.on("error", () => finish());
        request.on("response", (response: IncomingMessage) => {
            const chunks: Buffer[] = []; let size = 0;
            const declared = response.headers["content-length"];
            if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > NATIVE_MAC_REFRESH_BODY_LIMIT)) {
                finish(); response.destroy(); request.destroy(); return;
            }
            response.on("data", (chunk: Buffer) => {
                if (settled) return;
                size += chunk.length;
                if (size > NATIVE_MAC_REFRESH_BODY_LIMIT) { finish(); response.destroy(); request.destroy(); }
                else chunks.push(chunk);
            });
            response.on("aborted", () => finish());
            response.on("error", () => finish());
            response.on("end", () => {
                if (!settled) finish({ status: response.statusCode || 0,
                    body: Buffer.concat(chunks, size).toString("utf8") });
            });
        });
        request.end(body);
    });
};

function randomRequestID(): string {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes).map(value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Best-effort invalidation only. Signed 202 means queued, never uploaded or
 * delivered. Pending intents contain no secret or file payload. */
export class NativeMacRefreshSender {
    private readonly pending = new Map<string, PendingSignal>();
    private stopped = false;
    private epoch = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private active: { clientID: string; controller: AbortController } | null = null;
    private running: Promise<void> | null = null;
    private readonly attemptsAt: number[] = [];
    private lastAttemptAt = -Infinity;
    private retryNotBefore = 0;
    private readonly now: () => number;
    private readonly transport: NativeMacRefreshTransport;
    private readonly timeoutMs: number;
    private readonly intervalMs: number;
    private readonly retryMs: number;

    constructor(private readonly options: SenderOptions) {
        this.now = options.now || (() => Date.now());
        this.transport = options.transport || sendNativeMacRefreshHTTP;
        this.timeoutMs = Math.max(10, Math.min(2000, options.requestTimeoutMs ?? 2000));
        this.intervalMs = Math.max(0, options.minIntervalMs ?? 250);
        this.retryMs = Math.max(0, options.retryDelayMs ?? 1000);
    }

    start(): void { this.stopped = false; }
    stop(): Promise<void> {
        this.stopped = true; this.epoch++; this.pending.clear();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null; this.active?.controller.abort();
        return this.running || Promise.resolve();
    }
    revoke(clientID: string): void {
        this.pending.delete(clientID);
        if (this.active?.clientID === clientID) this.active.controller.abort();
    }
    signal(intent: NativeMacRefreshIntent): void {
        if (this.stopped || !this.supported()) return;
        // One latest pending signal per client, with a hard device-local bound.
        if (!this.pending.has(intent.clientID) && this.pending.size >= 32) return;
        this.pending.set(intent.clientID, { intent: { ...intent }, attempts: 0 });
        this.schedule();
    }
    async whenIdle(): Promise<void> {
        while (this.running || this.timer !== null || this.pending.size) {
            if (this.running) await this.running;
            else await new Promise<void>(resolve => setTimeout(resolve, 1));
        }
    }
    private supported(): boolean {
        try { return this.options.enabled(); } catch { return false; }
    }
    private secret(intent: NativeMacRefreshIntent): Uint8Array | null {
        if (this.stopped || !this.supported()) return null;
        try {
            const secret = this.options.resolveSecret(intent);
            return secret?.byteLength === 32 ? secret : null;
        } catch { return null; }
    }
    private stillAuthorized(intent: NativeMacRefreshIntent, secret: Uint8Array): boolean {
        const current = this.secret(intent);
        if (!current) return false;
        let mismatch = 0;
        for (let index = 0; index < 32; index++) mismatch |= secret[index] ^ current[index];
        return mismatch === 0;
    }
    private outcome(value: "queued" | "unavailable"): void {
        try { this.options.onOutcome?.(value); } catch { /* Diagnostics never reject publication. */ }
    }
    private schedule(): void {
        if (this.stopped || this.running || this.timer !== null || !this.pending.size) return;
        const now = this.now();
        while (this.attemptsAt.length && now - this.attemptsAt[0] >= 60_000) this.attemptsAt.shift();
        const rateReady = this.attemptsAt.length >= 10 ? this.attemptsAt[0] + 60_001 : now;
        const delay = Math.max(0, rateReady - now, this.lastAttemptAt + this.intervalMs - now, this.retryNotBefore - now);
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.stopped) return;
            const next = this.pending.entries().next();
            if (next.done) return;
            this.pending.delete(next.value[0]);
            const run = this.send(next.value[1]).catch(() => this.outcome("unavailable")).finally(() => {
                if (this.running === run) this.running = null;
                this.schedule();
            });
            this.running = run;
        }, delay);
    }
    private async send(pending: PendingSignal): Promise<void> {
        const epoch = this.epoch;
        const sourceSecret = this.secret(pending.intent);
        if (!sourceSecret) return;
        const secret = new Uint8Array(sourceSecret);
        const controller = new AbortController();
        this.active = { clientID: pending.intent.clientID, controller };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let retry = false;
        try {
            const unsigned = { schemaVersion: 1 as const, vaultName: pending.intent.vaultName,
                clientID: pending.intent.clientID, requestID: (this.options.requestID || randomRequestID)(),
                issuedAt: String(this.now()) };
            const body = JSON.stringify({ ...unsigned,
                mac: await hmacSHA256Base64URL(secret, canonicalNativeMacRefreshRequest(unsigned)) });
            if (utf8ByteCount(body) > NATIVE_MAC_REFRESH_BODY_LIMIT || controller.signal.aborted
                || epoch !== this.epoch || !this.stillAuthorized(pending.intent, secret)) return;
            this.lastAttemptAt = this.now(); this.attemptsAt.push(this.lastAttemptAt);
            const deadline = new Promise<null>(resolve => {
                controller.signal.addEventListener("abort", () => resolve(null), { once: true });
                timer = setTimeout(() => controller.abort(), this.timeoutMs);
            });
            let response: { status: number; body: string } | null;
            try { response = await Promise.race([this.transport(body, controller.signal), deadline]); }
            catch { response = null; }
            if (epoch !== this.epoch || !this.stillAuthorized(pending.intent, secret)) return;
            if (response === null) retry = true;
            else if (response.status === 202) {
                const receipt = parseNativeMacRefreshResponse(response.body, unsigned.requestID);
                if (receipt && await verifyHmacSHA256Base64URL(secret,
                    canonicalNativeMacRefreshResponse(receipt), receipt.mac)
                    && epoch === this.epoch && this.stillAuthorized(pending.intent, secret)) {
                    this.outcome("queued"); return;
                }
            } else retry = response.status === 429 || response.status === 503;
            this.outcome("unavailable");
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (this.active?.controller === controller) this.active = null;
            secret.fill(0);
        }
        if (retry && epoch === this.epoch && pending.attempts < 1 && this.secret(pending.intent)
            && !this.pending.has(pending.intent.clientID)) {
            this.retryNotBefore = this.now() + this.retryMs;
            this.pending.set(pending.intent.clientID, { ...pending, attempts: pending.attempts + 1 });
        }
    }
}
