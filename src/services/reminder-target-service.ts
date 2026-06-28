import { TFile } from "obsidian";
import type { ExternalCalendarEvent, TPSControllerSettings } from "../types";
import { buildCalendarExternalId } from "../tps-gcm-api";

export type ReminderTargetType = "file" | "external-event";

export interface ReminderEvaluationTarget {
    sourceKey: string;
    sourceType: ReminderTargetType;
    targetKind?: "note" | "task" | "external-event";
    taskTitle?: string;
    taskRawLine?: string;
    taskLine?: number;
    taskPropertyKeys?: string[];
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
    const targets: ReminderEvaluationTarget[] = [{
        sourceKey: file.path,
        sourceType: "file",
        targetKind: "note",
        noteTitle: buildNoteDisplayName(file),
    }];

    const vault = (app as any)?.vault;
    if (!vault || typeof vault.cachedRead !== "function" || file.extension?.toLowerCase() !== "md") return targets;

    let content = "";
    try {
        content = await vault.cachedRead(file);
    } catch {
        return targets;
    }

    const lines = content.split(/\r?\n/);
    let inFencedCodeBlock = false;
    for (let index = 0; index < lines.length; index++) {
        if (FENCED_CODE_BLOCK_PATTERN.test(lines[index])) {
            inFencedCodeBlock = !inFencedCodeBlock;
            continue;
        }
        if (inFencedCodeBlock) continue;
        const parsed = parseTaskReminderLine(lines[index]);
        if (!parsed) continue;
        const noteStatus = getFrontmatterValueCaseInsensitive(frontmatter, "status");
        targets.push({
            sourceKey: `${file.path}::task:${index}`,
            sourceType: "file",
            targetKind: "task",
            taskTitle: parsed.title,
            taskRawLine: lines[index],
            taskLine: index,
            taskPropertyKeys: Object.keys(parsed.properties),
            noteTitle: buildNoteDisplayName(file),
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

export function buildReminderDisplayName(file: Pick<TFile, "basename">, target: ReminderEvaluationTarget): string {
    if (target.sourceType === "external-event" && target.externalEvent) {
        return target.externalEvent.title || "External calendar event";
    }

    if (target.targetKind === "task" && target.taskTitle) {
        return target.taskTitle;
    }

    return buildNoteDisplayName(file);
}

function buildNoteDisplayName(file: Pick<TFile, "basename">): string {
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
    const markerStatus = getStatusFromTaskMarker(marker);
    const parsedStatus = typeof properties.status === "string" ? properties.status.trim() : properties.status;
    if (parsedStatus) properties.inlineStatus = parsedStatus;
    properties.status = markerStatus;
    properties.checkboxStatus = markerStatus;
    properties.taskStatus = markerStatus;

    const title = cleanTaskTitle(line);
    if (!title) return null;
    return { title, properties };
}

function getStatusFromTaskMarker(marker: string): string {
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
