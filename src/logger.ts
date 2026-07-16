/**
 * Centralized logging for TPS Controller.
 * All output is suppressed unless `enableLogging` is toggled on in plugin settings.
 */
const PLUGIN_PREFIX = "[TPS Controller]";

let loggingEnabled = false;
const recentMessages = new Map<string, number>();
const DEDUP_WINDOW_MS = 3000;

export function setLoggingEnabled(value: boolean): void {
    loggingEnabled = !!value;
    if (value) {
        console.log(`${PLUGIN_PREFIX} [Logger] Debug logging enabled — ${new Date().toISOString()}`);
    }
}

function shouldLog(level: string, message: string, params: any[]): boolean {
    const tail = params
        .map(p => {
            if (p instanceof Error) return p.message;
            if (typeof p === "string") return p;
            try { return JSON.stringify(p); } catch { return String(p); }
        })
        .join("|");
    const key = `${level}:${message}:${tail}`;
    const now = Date.now();
    const last = recentMessages.get(key);
    if (last && now - last < DEDUP_WINDOW_MS) return false;
    recentMessages.set(key, now);
    if (recentMessages.size > 300) {
        for (const [k, ts] of recentMessages.entries()) {
            if (now - ts > DEDUP_WINDOW_MS) recentMessages.delete(k);
        }
    }
    return true;
}

export function log(message?: any, ...rest: any[]): void {
    if (!loggingEnabled) return;
    const msg = typeof message === "string" ? message : String(message ?? "");
    if (!shouldLog("log", msg, rest)) return;
    console.log(`${PLUGIN_PREFIX} ${msg}`, ...rest);
}

export const debug = log;
export const info = log;

export function warn(message?: any, ...rest: any[]): void {
    if (!loggingEnabled) return;
    const msg = typeof message === "string" ? message : String(message ?? "");
    if (!shouldLog("warn", msg, rest)) return;
    console.warn(`${PLUGIN_PREFIX} ${msg}`, ...rest);
}

export function error(message?: any, ...rest: any[]): void {
    // Always log errors regardless of toggle
    const msg = typeof message === "string" ? message : String(message ?? "");
    if (!shouldLog("error", msg, rest)) return;
    console.error(`${PLUGIN_PREFIX} ${msg}`, ...rest);
}

export function errorSummary(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (typeof err === "string") return err;
    try { return JSON.stringify(err); } catch { return String(err); }
}

export function flow(scope: string, event: string, data?: Record<string, unknown>): void {
    info(`[${scope}] ${event}`, data || {});
}

export function flowWarn(scope: string, event: string, data?: Record<string, unknown>): void {
    warn(`[${scope}] ${event}`, data || {});
}

export function flowError(scope: string, event: string, err: unknown, data?: Record<string, unknown>): void {
    error(`[${scope}] ${event}`, { ...(data || {}), error: errorSummary(err) }, err);
}

function nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

export async function timeAsync<T>(
    scope: string,
    event: string,
    data: Record<string, unknown>,
    action: () => Promise<T>,
): Promise<T> {
    const start = nowMs();
    flow(scope, `${event}:start`, data);
    try {
        const result = await action();
        flow(scope, `${event}:done`, { ...data, durationMs: Math.round(nowMs() - start) });
        return result;
    } catch (err) {
        flowError(scope, `${event}:failed`, err, { ...data, durationMs: Math.round(nowMs() - start) });
        throw err;
    }
}

export interface ScopedLogger {
    log(message?: any, ...rest: any[]): void;
    debug(message?: any, ...rest: any[]): void;
    info(message?: any, ...rest: any[]): void;
    warn(message?: any, ...rest: any[]): void;
    error(message?: any, ...rest: any[]): void;
}

export function createScoped(scope: string): ScopedLogger {
    return {
        log:   (msg?: any, ...r: any[]) => log(`[${scope}] ${msg ?? ""}`, ...r),
        debug: (msg?: any, ...r: any[]) => log(`[${scope}] ${msg ?? ""}`, ...r),
        info:  (msg?: any, ...r: any[]) => log(`[${scope}] ${msg ?? ""}`, ...r),
        warn:  (msg?: any, ...r: any[]) => warn(`[${scope}] ${msg ?? ""}`, ...r),
        error: (msg?: any, ...r: any[]) => error(`[${scope}] ${msg ?? ""}`, ...r),
    };
}
