import type { TFile } from "obsidian";
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
    reminderTags?: string[];
    suppressInheritedDailyNoteSchedule?: boolean;
    noteTitle?: string;
    taskFrontmatter?: Record<string, unknown>;
    sourceFrontmatter?: Record<string, unknown>;
    externalEvent?: ExternalCalendarEvent;
}

export interface EffectiveReminderContext {
    frontmatter: Record<string, unknown>;
    propertyValue: unknown;
}

function formatEventDateTime(date: Date, allDay: boolean): string {
    const dateOnly = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (allDay) return dateOnly;
    return `${dateOnly} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Display uses existing metadata; explicit mutations verify their current source separately. */
export async function buildReminderTargetsForFile(
    _app: unknown,
    file: TFile,
    frontmatter: Record<string, unknown>,
    _settings: TPSControllerSettings,
): Promise<ReminderEvaluationTarget[]> {
    return [{
        sourceKey: file.path,
        sourceType: "file",
        targetKind: "note",
        noteTitle: buildNoteDisplayName(file, frontmatter),
    }];
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
        frontmatter: target.sourceFrontmatter ?? baseFrontmatter,
        propertyValue: (target.sourceFrontmatter ?? baseFrontmatter)[reminderProperty],
    };
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
