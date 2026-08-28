import { TFile } from "obsidian";
import type { ExternalCalendarEvent, TPSControllerSettings } from "../types";
import { buildCalendarExternalId, getDailyNoteTaskSchedulePolicyViaGcm } from "../tps-gcm-api";

export type ReminderTargetType = "file" | "external-event";

export interface ReminderEvaluationTarget {
    sourceKey: string;
    sourceType: ReminderTargetType;
    targetKind?: "note" | "task" | "external-event";
    taskTitle?: string;
    taskRawLine?: string;
    taskLine?: number;
    taskPropertyKeys?: string[];
    reminderTags?: string[];
    suppressInheritedDailyNoteSchedule?: boolean;
    noteTitle?: string;
    taskFrontmatter?: Record<string, unknown>;
    externalEvent?: ExternalCalendarEvent;
}

export interface EffectiveReminderContext {
    frontmatter: Record<string, unknown>;
    propertyValue: unknown;
}

const FENCED_CODE_BLOCK_PATTERN = /^\s*(```|~~~)/;

function formatEventDateTime(date: Date, allDay: boolean): string {
    const dateOnly = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (allDay) return dateOnly;
    return `${dateOnly} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export async function buildReminderTargetsForFile(
    app: unknown,
    file: TFile,
    frontmatter: Record<string, unknown>,
    _settings: TPSControllerSettings,
): Promise<ReminderEvaluationTarget[]> {
    const noteTitle = buildNoteDisplayName(file, frontmatter);
    const noteTarget: ReminderEvaluationTarget = {
        sourceKey: file.path,
        sourceType: "file",
        targetKind: "note",
        noteTitle,
    };
    const targets: ReminderEvaluationTarget[] = [noteTarget];

    const vault = (app as any)?.vault;
    if (!vault || typeof vault.cachedRead !== "function" || file.extension?.toLowerCase() !== "md") return targets;

    let content = "";
    try {
        content = await vault.cachedRead(file);
    } catch {
        return targets;
    }

    const lines = content.split(/\r?\n/);
    const noteTags = new Set(getFrontmatterReminderTags(frontmatter));
    noteTarget.reminderTags = [...noteTags];
    const dailyNotePolicy = getDailyNoteTaskSchedulePolicyViaGcm(app as any, file);
    const suppressInheritedDailyNoteSchedule = dailyNotePolicy.available
        && dailyNotePolicy.isDailyNote
        && !dailyNotePolicy.inheritUnscheduled;
    let inFencedCodeBlock = false;
    let migratedTaskIndent: number | null = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] || "";
        if (FENCED_CODE_BLOCK_PATTERN.test(line)) {
            inFencedCodeBlock = !inFencedCodeBlock;
            continue;
        }
        if (inFencedCodeBlock) continue;
        const indent = getIndentWidth(line);
        if (migratedTaskIndent !== null) {
            if (!line.trim() || indent > migratedTaskIndent) continue;
            migratedTaskIndent = null;
        }
        const parsed = parseTaskReminderLine(line);
        if (!parsed) {
            for (const tag of getLineReminderTags(line)) noteTags.add(tag);
            noteTarget.reminderTags = [...noteTags];
            continue;
        }
        if (parsed.properties.status === "migrated") {
            migratedTaskIndent = indent;
            continue;
        }
        const noteStatus = getFrontmatterValueCaseInsensitive(frontmatter, "status");
        targets.push({
            sourceKey: `${file.path}::task:${index}`,
            sourceType: "file",
            targetKind: "task",
            taskTitle: parsed.title,
            taskRawLine: lines[index],
            taskLine: index,
            taskPropertyKeys: Object.keys(parsed.properties),
            reminderTags: getLineReminderTags(line),
            suppressInheritedDailyNoteSchedule,
            noteTitle,
            taskFrontmatter: {
                ...frontmatter,
                ...parsed.properties,
                noteStatus,
                title: parsed.title,
                taskTitle: parsed.title,
                noteTitle: buildNoteDisplayName(file),
                line: index,
                lineNumber: index + 1,
            },
        });
    }

    return targets;
}

function getIndentWidth(line: string): number {
    return String(line || "").match(/^[\t ]*/)?.[0].replace(/\t/g, "    ").length ?? 0;
}

export function buildEffectiveReminderContextForTarget(
    target: ReminderEvaluationTarget,
    baseFrontmatter: Record<string, unknown>,
    reminderProperty: string,
    settings: TPSControllerSettings,
): EffectiveReminderContext | null {
    if (target.sourceType === "external-event" && target.externalEvent) {
        const event = target.externalEvent;
        const durationMinutes = Math.max(1, Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000));
        const scheduledValue = formatEventDateTime(event.startDate, event.isAllDay);
        const frontmatter: Record<string, unknown> = {
            ...baseFrontmatter,
            title: event.title,
            scheduled: scheduledValue,
            [settings.startProperty || "scheduled"]: scheduledValue,
            timeEstimate: durationMinutes,
            [settings.endProperty || "timeEstimate"]: durationMinutes,
            allDay: event.isAllDay,
            externalId: buildCalendarExternalId(null, event),
            location: event.location || "",
            organizer: event.organizer || "",
            status: event.isCancelled ? "cancelled" : "scheduled",
        };
        return {
            frontmatter,
            propertyValue: frontmatter[reminderProperty],
        };
    }

    if (target.targetKind === "task" && target.taskFrontmatter) {
        const normalizedProperty = String(reminderProperty || "").trim().toLowerCase();
        const taskPropertyKeys = new Set(
            (target.taskPropertyKeys || []).map((key) => String(key || "").trim().toLowerCase()),
        );
        if (
            target.suppressInheritedDailyNoteSchedule
            && ["scheduled", "start", "date"].includes(normalizedProperty)
            && !taskPropertyKeys.has(normalizedProperty)
        ) {
            return null;
        }
        return {
            frontmatter: target.taskFrontmatter,
            propertyValue: target.taskFrontmatter[reminderProperty],
        };
    }

    return {
        frontmatter: baseFrontmatter,
        propertyValue: baseFrontmatter[reminderProperty],
    };
}

function getFrontmatterReminderTags(frontmatter: Record<string, unknown>): string[] {
    const tags: string[] = [];
    for (const key of Object.keys(frontmatter || {})) {
        if (key.trim().toLowerCase() !== "tag" && key.trim().toLowerCase() !== "tags") continue;
        const value = frontmatter[key];
        const values = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
        for (const entry of values) {
            const normalized = String(entry ?? "").trim().replace(/^#/, "");
            if (normalized) tags.push(`#${normalized}`);
        }
    }
    return [...new Set(tags)];
}

function getLineReminderTags(line: string): string[] {
    const tags: string[] = [];
    const pattern = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(String(line || ""))) !== null) {
        tags.push(`#${match[2]}`);
    }
    return [...new Set(tags)];
}

export function getReminderTagsForTarget(target: ReminderEvaluationTarget): string[] | undefined {
    if (target.reminderTags !== undefined) return target.reminderTags;
    if (target.targetKind === "task") return getLineReminderTags(target.taskRawLine || "");
    return undefined;
}

export function buildReminderDisplayName(file: Pick<TFile, "basename">, target: ReminderEvaluationTarget): string {
    if (target.sourceType === "external-event" && target.externalEvent) {
        return target.externalEvent.title || "External calendar event";
    }

    if (target.targetKind === "task" && target.taskTitle) {
        return target.taskTitle;
    }

    return target.noteTitle || buildNoteDisplayName(file);
}

function buildNoteDisplayName(
    file: Pick<TFile, "basename">,
    frontmatter: Record<string, unknown> = {},
): string {
    const kind = String(getFrontmatterValueCaseInsensitive(frontmatter, "kind") ?? "")
        .trim()
        .toLowerCase();
    if (kind === "calendar-event") {
        const eventTitle = String(getFrontmatterValueCaseInsensitive(frontmatter, "eventTitle") ?? "")
            .replace(/[\r\n]+/gu, " ")
            .replace(/\s+/gu, " ")
            .trim();
        if (eventTitle) return eventTitle;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) return file.basename;
    return file.basename.replace(/ \d{4}-\d{2}-\d{2}$/, "");
}

function getFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown>, key: string): unknown {
    const normalizedKey = key.trim().toLowerCase();
    const match = Object.keys(frontmatter || {}).find((candidate) => candidate.trim().toLowerCase() === normalizedKey);
    return match ? frontmatter[match] : undefined;
}

function parseTaskReminderLine(line: string): { title: string; properties: Record<string, unknown> } | null {
    const taskMatch = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]?)]\s+/);
    if (!taskMatch) return null;

    const properties = parseInlineProperties(line);
    const marker = String(taskMatch[1] || " ").trim().toLowerCase();
    const checkboxState = normalizeTaskCheckboxState(taskMatch[1]);
    const markerStatus = getStatusFromTaskMarker(marker);
    const parsedStatus = typeof properties.status === "string" ? properties.status.trim() : properties.status;
    if (parsedStatus) properties.inlineStatus = parsedStatus;
    properties.status = markerStatus;
    properties.checkboxStatus = markerStatus;
    properties.checkboxState = checkboxState;
    properties.taskCheckboxState = checkboxState;
    properties.taskStatus = markerStatus;

    const title = cleanTaskTitle(line);
    if (!title) return null;
    return { title, properties };
}

function normalizeTaskCheckboxState(value: unknown): string {
    const raw = String(value ?? "");
    const trimmed = raw.trim().toLowerCase();
    return trimmed || " ";
}

function getStatusFromTaskMarker(marker: string): string {
    if (marker === ">") return "migrated";
    if (marker === "x") return "complete";
    if (marker === "-" || marker === "~") return "wont-do";
    if (marker === "/" || marker === "\\") return "working";
    if (marker === "?" || marker === "!") return "holding";
    return "todo";
}

function parseInlineProperties(line: string): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    const regex = /\[([^\[\]:]+)::\s*([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!key) continue;
        props[key] = value;
        props[key.toLowerCase()] = value;
    }
    return props;
}

function cleanTaskTitle(line: string): string {
    return line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]?]\s+/, "")
        .replace(/(?:<span\b[^>]*data-tps-inline-props="[^"]*"[^>]*>\s*<\/span>|<!--\s*tps-inline-props:[\s\S]*?\s*-->|\s*%%\s*tps-inline-props:[\s\S]*?\s*%%)/g, "")
        .replace(/\[\^tps-inline:[^\]]+]/g, "")
        .replace(/\[[^\[\]:]+::\s*[^\]]+\]/g, "")
        .replace(/#[\w/-]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
