import { App, parseYaml } from "obsidian";
import type { ExternalCalendarEvent } from "../types";
import { prepareInstanceSourceViaGcm } from "../tps-gcm-api";
import { resolveTemplateFile } from "../utils/template-resolution-service";
import { applyTemplateVars, buildExternalEventTemplateVars } from "../utils/template-variable-service";

export interface NativeCalendarTemplateInstance {
    properties: Record<string, unknown>;
    body: string;
}

// A template is a new note's content/defaults, never its identity. Keep source
// IDs out of the public record and let the canonical occurrence ID own sync.
const COPIED_IDENTITY_KEYS = new Set([
    "tpsid", "tpsschemaversion", "createddate", "modifieddate", "externalid",
    "externaleventid", "tpscalendaruid", "tpscalendarsourceurl", "calendarid",
    "calendarsourceid", "calendaruid", "calendaroccurrenceid", "calendaroccurrenceidentity",
    "calendaroccurrencekey", "calendarrecurring", "calendarsyncstate", "calendarmissingat",
]);

export async function readNativeCalendarTemplate(app: App, path: string): Promise<string> {
    const file = resolveTemplateFile(app, path, {
        allowBasenameMatchInTemplaterRoot: true,
        warnOnAmbiguousBasename: true,
    });
    if (!file || file.extension !== "md") throw new Error(`Configured calendar template was not found: ${path}`);
    const source = await app.vault.read(file);
    const prepared = prepareInstanceSourceViaGcm(app, source);
    if (prepared === null) throw new Error(`TPS GCM rejected calendar template instance content: ${path}`);
    // Executable Templater commands require an already-created physical file.
    // Reject before the atomic batch instead of publishing a partial record.
    if (prepared.includes("<%")) {
        throw new Error(`Native calendar template ${path} contains executable Templater commands; use static content and calendar variables such as {{title}} instead.`);
    }
    return prepared;
}

export function renderNativeCalendarTemplate(
    source: string,
    event: ExternalCalendarEvent,
    templatePath: string,
): NativeCalendarTemplateInstance {
    const variables = buildExternalEventTemplateVars(null, {
        ...event,
        startISO: event.startDate.toISOString(),
        endISO: event.endDate.toISOString(),
    });
    // Parse YAML before expanding data from the feed: a quote/newline in an
    // event title must stay a property value, never become another YAML key.
    const expandValue = (value: unknown, depth = 0): unknown => {
        if (depth > 32) throw new Error(`Calendar template properties are too deeply nested: ${templatePath}`);
        if (typeof value === "string") return applyTemplateVars(value, variables);
        if (Array.isArray(value)) return value.map((item) => expandValue(item, depth + 1));
        if (value && typeof value === "object" && !(value instanceof Date)) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item, depth + 1)]));
        }
        return value;
    };
    const opening = source.match(/^(?:\uFEFF)?---[ \t]*\r?\n/u);
    if (!opening) return { properties: {}, body: applyTemplateVars(source, variables) };
    const remainder = source.slice(opening[0].length);
    const closing = remainder.match(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/u);
    if (!closing || closing.index === undefined) throw new Error(`Calendar template has an unclosed frontmatter block: ${templatePath}`);
    let parsed: unknown;
    try {
        parsed = parseYaml(remainder.slice(0, closing.index));
    } catch {
        throw new Error(`Calendar template frontmatter is invalid: ${templatePath}`);
    }
    if (parsed !== null && parsed !== undefined
        && (typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error(`Calendar template frontmatter must be a property mapping: ${templatePath}`);
    }
    const properties: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    for (const [key, sourceValue] of Object.entries(parsed || {})) {
        const normalized = key.trim().toLocaleLowerCase();
        if (!normalized || seen.has(normalized)) throw new Error(`Calendar template has duplicate property names: ${templatePath}`);
        seen.add(normalized);
        if (COPIED_IDENTITY_KEYS.has(normalized)) continue;
        const value = expandValue(sourceValue);
        if (normalized === "kind") {
            if (value === null || value === undefined || (typeof value === "string" && !value.trim())) continue;
            if (typeof value !== "string") throw new Error(`Calendar template kind must be text: ${templatePath}`);
            properties.kind = value;
        } else {
            properties[key] = value;
        }
    }
    return { properties, body: applyTemplateVars(remainder.slice(closing.index + closing[0].length), variables) };
}
