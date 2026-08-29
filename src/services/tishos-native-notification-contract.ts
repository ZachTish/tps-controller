import {
    compareUTF8,
    isCanonicalBase64URLSHA256,
    isCanonicalGeneratedAt,
    isValidCommandName,
    isValidVaultName,
    normalizeUUID,
    utf8ByteCount,
} from "./tishos-command-bridge-contract";

export const TISHOS_NATIVE_NOTIFICATION_ROOT = ".tishos/native-notifications/v1";
export const TISHOS_NATIVE_NOTIFICATION_MAX_FILE_BYTES = 262_144;
export const TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS = 128;
export const TISHOS_NATIVE_NOTIFICATION_MAX_LATE_MS = 5 * 60 * 1000;
export const TISHOS_NATIVE_NOTIFICATION_MAX_BODY_BYTES = 1_024;
export const TISHOS_NATIVE_NOTIFICATION_MAX_SOURCE_PATH_BYTES = 512;
export const TISHOS_NATIVE_NOTIFICATION_MAX_REPEAT_SECONDS = 60 * 24 * 60 * 60;

export interface TishOSNativeNotificationItem {
    id: string;
    seriesID: string;
    title: string;
    body: string;
    fireAt: string;
    sourcePath?: string;
}

export interface TishOSNativeNotificationSchedule {
    schemaVersion: 2;
    clientID: string;
    vaultName: string;
    generatedAt: string;
    publisher: { id: string; version: string };
    items: TishOSNativeNotificationItem[];
    mac: string;
}

export interface TishOSNativeNotificationSeriesAuditItem {
    seriesID: string;
    dueAt: string;
    repeatEverySeconds: number | null;
}

export interface TishOSNativeNotificationSeriesAudit {
    schemaVersion: 1;
    clientID: string;
    vaultName: string;
    generatedAt: string;
    publisher: { id: string; version: string };
    scheduleMAC: string;
    series: TishOSNativeNotificationSeriesAuditItem[];
    mac: string;
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function field(name: string, value: string): string {
    return `${name}:${utf8ByteCount(value)}:${value}\n`;
}

export function isValidNotificationBody(value: unknown): value is string {
    return typeof value === "string"
        && utf8ByteCount(value) <= TISHOS_NATIVE_NOTIFICATION_MAX_BODY_BYTES
        && !CONTROL_PATTERN.test(value);
}

export function isValidNotificationSourcePath(value: unknown): value is string {
    if (typeof value !== "string" || !value || utf8ByteCount(value) > TISHOS_NATIVE_NOTIFICATION_MAX_SOURCE_PATH_BYTES) {
        return false;
    }
    if (
        value !== value.trim()
        || value.startsWith("/")
        || value.endsWith("/")
        || value.includes("\\")
        || value.includes("#")
        || value.includes("?")
        || !value.toLowerCase().endsWith(".md")
        || CONTROL_PATTERN.test(value)
    ) return false;
    const components = value.split("/");
    return components.every((component) => component && component !== "." && component !== "..");
}

export function isCanonicalNotificationDate(value: unknown): value is string {
    return isCanonicalGeneratedAt(value);
}

export function canonicalNotificationSeries(
    sourceKey: string,
    reminderID: string,
): Uint8Array {
    return new TextEncoder().encode(
        "tishos-native-notification-series-v1\n"
        + field("source", sourceKey)
        + field("reminder", reminderID),
    );
}

export function canonicalNotificationItem(item: TishOSNativeNotificationItem): Uint8Array {
    return new TextEncoder().encode(
        "tishos-native-notification-item-v2\n"
        + field("series", item.seriesID)
        + field("title", item.title)
        + field("body", item.body)
        + field("fire", item.fireAt)
        + field("source", item.sourcePath || ""),
    );
}

export function canonicalNotificationSchedule(
    schedule: Omit<TishOSNativeNotificationSchedule, "mac">,
): Uint8Array {
    let value = "tishos-native-notification-schedule-v2\n";
    value += "schema:2\n";
    value += field("client", schedule.clientID);
    value += field("vault", schedule.vaultName);
    value += field("generated", schedule.generatedAt);
    value += field("publisher-id", schedule.publisher.id);
    value += field("publisher-version", schedule.publisher.version);
    value += `items:${schedule.items.length}\n`;
    for (const item of schedule.items) value += field("item", item.id);
    return new TextEncoder().encode(value);
}

export function canonicalNotificationSeriesAudit(
    audit: Omit<TishOSNativeNotificationSeriesAudit, "mac">,
): Uint8Array {
    let value = "tishos-native-notification-series-audit-v1\n";
    value += "schema:1\n";
    value += field("client", audit.clientID);
    value += field("vault", audit.vaultName);
    value += field("generated", audit.generatedAt);
    value += field("publisher-id", audit.publisher.id);
    value += field("publisher-version", audit.publisher.version);
    value += field("schedule-mac", audit.scheduleMAC);
    value += `series:${audit.series.length}\n`;
    for (const item of audit.series) {
        value += field("series-id", item.seriesID);
        value += field("due", item.dueAt);
        value += `repeat-seconds:${item.repeatEverySeconds ?? 0}\n`;
    }
    return new TextEncoder().encode(value);
}

export function validateNotificationSeriesAuditItems(
    values: readonly TishOSNativeNotificationSeriesAuditItem[],
): TishOSNativeNotificationSeriesAuditItem[] | null {
    if (values.length > TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS) return null;
    const ids = new Set<string>();
    const result: TishOSNativeNotificationSeriesAuditItem[] = [];
    for (const item of values) {
        if (
            !isCanonicalBase64URLSHA256(item.seriesID)
            || ids.has(item.seriesID)
            || !isCanonicalNotificationDate(item.dueAt)
            || (item.repeatEverySeconds !== null && (
                !Number.isSafeInteger(item.repeatEverySeconds)
                || item.repeatEverySeconds <= 0
                || item.repeatEverySeconds > TISHOS_NATIVE_NOTIFICATION_MAX_REPEAT_SECONDS
            ))
        ) return null;
        ids.add(item.seriesID);
        result.push({ ...item });
    }
    return result;
}

export function validateNotificationItems(
    values: readonly TishOSNativeNotificationItem[],
): TishOSNativeNotificationItem[] | null {
    if (values.length > TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS) return null;
    const ids = new Set<string>();
    let previousFireAt = "";
    let previousID = "";
    const result: TishOSNativeNotificationItem[] = [];
    for (const item of values) {
        if (
            !isCanonicalBase64URLSHA256(item.id)
            || !isCanonicalBase64URLSHA256(item.seriesID)
            || ids.has(item.id)
            || !isValidCommandName(item.title)
            || !isValidNotificationBody(item.body)
            || !isCanonicalNotificationDate(item.fireAt)
            || (item.sourcePath !== undefined && !isValidNotificationSourcePath(item.sourcePath))
        ) return null;
        const fireAtOrder = previousFireAt ? compareUTF8(previousFireAt, item.fireAt) : -1;
        if (fireAtOrder > 0 || (fireAtOrder === 0 && compareUTF8(previousID, item.id) >= 0)) return null;
        ids.add(item.id);
        previousFireAt = item.fireAt;
        previousID = item.id;
        result.push({ ...item });
    }
    return result;
}

export function validateNotificationScheduleShape(
    value: Omit<TishOSNativeNotificationSchedule, "mac">,
): boolean {
    return value.schemaVersion === 2
        && normalizeUUID(value.clientID) === value.clientID
        && isValidVaultName(value.vaultName)
        && isCanonicalGeneratedAt(value.generatedAt)
        && value.publisher.id === "tps-controller"
        && /^\d+\.\d+\.\d+$/.test(value.publisher.version)
        && validateNotificationItems(value.items) !== null;
}
