import type { ExternalCalendarEvent } from "../types";

/**
 * Canonical calendar-record IDs are privacy-safe and stable across feed URL
 * rotation and event rescheduling:
 *
 *   calendar:v1:<source scope>:<logical occurrence digest>
 *
 * The source scope is the first 12 bytes of SHA-256(config.id), while the
 * occurrence digest is the first 20 bytes of
 * SHA-256(config.id + NUL + occurrence identity). Both are unpadded base64url.
 * Source-keying the occurrence digest prevents equal or low-entropy UIDs from
 * being correlated across feeds. The structured source scope lets Controller
 * apply missing-event policy only after that exact configured feed succeeds,
 * without persisting a second calendar/source identifier on every note.
 */
export const CALENDAR_RECORD_ID_PREFIX = "calendar:v1";
export const CALENDAR_RECORD_SOURCE_DIGEST_BYTES = 12;
export const CALENDAR_RECORD_OCCURRENCE_DIGEST_BYTES = 20;

const SOURCE_SCOPE_LENGTH = 16;
const OCCURRENCE_DIGEST_LENGTH = 27;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CALENDAR_RECORD_ID_PATTERN = new RegExp(
    `^calendar:v1:([A-Za-z0-9_-]{${SOURCE_SCOPE_LENGTH}}):([A-Za-z0-9_-]{${OCCURRENCE_DIGEST_LENGTH}})$`,
    "u",
);

export interface CalendarRecordIdParts {
    version: 1;
    sourceScope: string;
    occurrenceDigest: string;
}

export function calendarEventOccurrenceIdentity(
    event: Pick<ExternalCalendarEvent, "occurrenceIdentity" | "id" | "uid" | "isRecurring">,
): string {
    // Non-recurring UIDs survive a reschedule, while recurring occurrences
    // need the recurrence-specific event ID when the parser did not supply its
    // explicit occurrenceIdentity.
    const fallbacks = event.isRecurring === true
        ? [event.id, event.uid]
        : [event.uid, event.id];
    const identity = [event.occurrenceIdentity, ...fallbacks]
        .map((value) => String(value || "").trim())
        .find(Boolean);
    if (!identity) throw new Error("Calendar event is missing a logical occurrence identity.");
    return identity;
}

export async function deriveCalendarRecordSourceScope(calendarConfigId: unknown): Promise<string> {
    const configId = requiredIdentityPart(calendarConfigId, "calendar configuration ID");
    return digestPrefix(configId, CALENDAR_RECORD_SOURCE_DIGEST_BYTES);
}

export async function deriveCalendarRecordId(
    calendarConfigId: unknown,
    occurrenceIdentity: unknown,
): Promise<string> {
    const configId = requiredIdentityPart(calendarConfigId, "calendar configuration ID");
    const occurrence = requiredIdentityPart(occurrenceIdentity, "calendar occurrence identity");
    const [sourceScope, occurrenceDigest] = await Promise.all([
        deriveCalendarRecordSourceScope(configId),
        digestPrefix(
            `${configId}\u0000${occurrence}`,
            CALENDAR_RECORD_OCCURRENCE_DIGEST_BYTES,
        ),
    ]);
    return `${CALENDAR_RECORD_ID_PREFIX}:${sourceScope}:${occurrenceDigest}`;
}

export function parseCalendarRecordId(value: unknown): CalendarRecordIdParts | null {
    const match = String(value || "").trim().match(CALENDAR_RECORD_ID_PATTERN);
    if (!match) return null;
    return {
        version: 1,
        sourceScope: match[1],
        occurrenceDigest: match[2],
    };
}

export function calendarRecordSourceScope(value: unknown): string | null {
    return parseCalendarRecordId(value)?.sourceScope || null;
}

function requiredIdentityPart(value: unknown, label: string): string {
    const normalized = String(value || "").trim();
    if (!normalized) throw new Error(`Cannot derive canonical calendar record identity without a ${label}.`);
    return normalized;
}

async function digestPrefix(value: string, byteLength: number): Promise<string> {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle) throw new Error("Web Crypto is unavailable; calendar record identity cannot be derived safely.");
    const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return encodeBase64Url(digest.subarray(0, byteLength));
}

function encodeBase64Url(bytes: Uint8Array): string {
    let encoded = "";
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index];
        const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
        const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
        const bits = (first << 16) | (second << 8) | third;
        encoded += BASE64URL_ALPHABET[(bits >>> 18) & 63];
        encoded += BASE64URL_ALPHABET[(bits >>> 12) & 63];
        if (index + 1 < bytes.length) encoded += BASE64URL_ALPHABET[(bits >>> 6) & 63];
        if (index + 2 < bytes.length) encoded += BASE64URL_ALPHABET[bits & 63];
    }
    return encoded;
}
