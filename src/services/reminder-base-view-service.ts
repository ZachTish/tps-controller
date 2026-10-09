import { App, TFile, normalizePath, parseYaml } from "obsidian";
import type { PropertyReminder } from "../types";

type ReminderBaseView = { name: string; type: string; filters?: unknown };
type ReminderBaseDefinition = {
    filters?: unknown;
    formulas?: Record<string, unknown>;
    views: ReminderBaseView[];
};
type NativeBaseQuery = {
    handler: (parameters: { path: string; view: string; format: "paths" }) => unknown | Promise<unknown>;
};

export function isBaseViewReminder(reminder: PropertyReminder): boolean {
    return reminder.selectionMode === "base-view";
}

/** A Base owns selection; delivery dates, repeats and stop conditions remain on the reminder. */
export function getReminderMatchingPolicy(reminder: PropertyReminder): PropertyReminder {
    if (!isBaseViewReminder(reminder)) return reminder;
    const policy = { ...reminder };
    delete policy.requiredStatuses;
    delete policy.requiredPaths;
    delete policy.ignorePaths;
    delete policy.ignoreTags;
    delete policy.ignoreStatuses;
    return policy;
}

/** List saved views without evaluating notes or validating an unrelated view's filters. */
export async function readReminderBaseViews(app: App, path: string): Promise<string[]> {
    const normalizedPath = normalizeReminderBasePath(path);
    const definition = await readBaseDefinition(app, normalizedPath);
    return definition.views.map((view) => view.name);
}

/**
 * Run the core Bases query once per distinct saved view in this reminder pass.
 * The registry is an internal Obsidian capability and is deliberately feature-detected.
 * Nothing is mounted, observed, cached between passes, or repaired on failure.
 */
export async function resolveReminderBaseViews(
    app: App,
    reminders: readonly PropertyReminder[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const selected = reminders.filter((reminder) => reminder.enabled && isBaseViewReminder(reminder));
    const results = new Map<string, ReadonlySet<string>>();
    if (!selected.length) return results;

    const registry = (app as unknown as {
        cli?: { handlers?: { get?: (name: string) => unknown } };
    }).cli?.handlers;
    const query = typeof registry?.get === "function" ? registry.get("base:query") as NativeBaseQuery | undefined : undefined;
    if (typeof query?.handler !== "function") {
        throw new Error("Reminder Base views require Obsidian's native Bases query capability and the Bases core plugin.");
    }

    const definitions = new Map<string, ReminderBaseDefinition>();
    const memberships = new Map<string, ReadonlySet<string>>();
    for (const reminder of selected) {
        const path = normalizeReminderBasePath(reminder.basePath || "");
        const viewName = typeof reminder.baseView === "string" ? reminder.baseView : "";
        if (!viewName.trim()) throw new Error(`Choose a saved view for reminder Base "${path}".`);
        let definition = definitions.get(path);
        if (!definition) {
            definition = await readBaseDefinition(app, path);
            definitions.set(path, definition);
        }
        const view = definition.views.find((candidate) => candidate.name === viewName);
        if (!view) throw new Error(`Reminder Base "${path}" has no saved view named "${viewName}".`);
        const key = JSON.stringify([path, viewName]);
        let membership = memberships.get(key);
        if (!membership) {
            validateSelectedView(definition, view, path);
            let output: unknown;
            try {
                output = await query.handler({ path, view: viewName, format: "paths" });
            } catch {
                throw new Error(`Obsidian could not query reminder Base "${path}", view "${viewName}".`);
            }
            membership = decodeNativePaths(app, output, path, viewName);
            memberships.set(key, membership);
        }
        results.set(reminder.id, membership);
    }
    return results;
}

export function reminderMatchesBaseView(
    reminder: PropertyReminder,
    sourceType: "file" | "external-event",
    sourcePath: string,
    memberships?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
    if (!isBaseViewReminder(reminder)) return true;
    return sourceType === "file" && memberships?.get(reminder.id)?.has(sourcePath) === true;
}

/** Reuse query results instead of taking another vault inventory when every enabled reminder uses a Base. */
export function getReminderBaseCandidateFiles(
    app: App, reminders: readonly PropertyReminder[], memberships: ReadonlyMap<string, ReadonlySet<string>>,
): TFile[] | undefined {
    const enabled = reminders.filter(reminder => reminder.enabled);
    if (!enabled.length || !enabled.every(isBaseViewReminder)) return undefined;
    const paths = new Set<string>();
    for (const reminder of enabled) for (const path of memberships.get(reminder.id) || []) paths.add(path);
    return [...paths].map(path => {
        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") throw new Error("A reminder Base result changed before evaluation.");
        return file;
    });
}

function normalizeReminderBasePath(raw: string): string {
    const path = typeof raw === "string" ? raw.trim() : "";
    if (!path || /^[\\/]/u.test(path) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(path)
        || path.replace(/\\/gu, "/").split("/").some((part) => part === "." || part === "..")
        || /[\r\n\0#]/u.test(path) || !/\.base$/iu.test(path)) {
        throw new Error("Choose a vault-relative .base file path for the reminder.");
    }
    return normalizePath(path);
}

async function readBaseDefinition(app: App, path: string): Promise<ReminderBaseDefinition> {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "base") {
        throw new Error(`Reminder Base "${path}" was not found.`);
    }
    let source: string;
    try {
        source = await app.vault.cachedRead(file);
    } catch {
        throw new Error(`Cannot read reminder Base "${path}".`);
    }
    let parsed: unknown;
    try {
        parsed = parseYaml(source);
    } catch {
        throw new Error(`Reminder Base "${path}" contains invalid YAML.`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.views) || !parsed.views.length) {
        throw new Error(`Reminder Base "${path}" must contain saved views.`);
    }
    const names = new Set<string>();
    for (const view of parsed.views) {
        if (!isRecord(view) || typeof view.name !== "string" || !view.name.trim()
            || typeof view.type !== "string" || !view.type.trim()) {
            throw new Error(`Reminder Base "${path}" contains an invalid saved view.`);
        }
        if (names.has(view.name)) throw new Error(`Reminder Base "${path}" has duplicate view name "${view.name}".`);
        names.add(view.name);
    }
    return parsed as unknown as ReminderBaseDefinition;
}

function validateSelectedView(definition: ReminderBaseDefinition, view: ReminderBaseView, path: string): void {
    const location = `Reminder Base "${path}", view "${view.name}"`;
    if (definition.filters !== undefined) validateFilter(definition.filters, location);
    if (view.filters !== undefined) validateFilter(view.filters, location);
    if (definition.formulas !== undefined) {
        if (!isRecord(definition.formulas)) throw new Error(`${location} has an invalid formulas section.`);
        for (const expression of Object.values(definition.formulas)) {
            if (typeof expression !== "string" || !expression.trim()) {
                throw new Error(`${location} has an invalid formula definition.`);
            }
            rejectContextDependentExpression(expression, location);
        }
    }
}

function validateFilter(filter: unknown, location: string, depth = 0): void {
    if (depth > 64) throw new Error(`${location} has filters nested too deeply.`);
    if (typeof filter === "string" && filter.trim()) {
        rejectContextDependentExpression(filter, location);
        return;
    }
    if (!isRecord(filter)) throw new Error(`${location} has an invalid filter.`);
    const keys = Object.keys(filter);
    const key = keys[0];
    if (keys.length !== 1 || !["and", "or", "not"].includes(key) || !Array.isArray(filter[key])) {
        throw new Error(`${location} filters must use a string or an and/or/not list.`);
    }
    for (const child of filter[key] as unknown[]) validateFilter(child, location, depth + 1);
}

function rejectContextDependentExpression(expression: string, location: string): void {
    // Ignore quoted literals and property members named "this". The native
    // background query supplies no embedding/active-note context for global this.
    const unquoted = expression.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/gu, " ");
    const identifiers = /[A-Za-z_$][A-Za-z\d_$]*/gu;
    let token: RegExpExecArray | null;
    while ((token = identifiers.exec(unquoted)) !== null) {
        if (token[0].toLowerCase() !== "this") continue;
        const prefix = unquoted.slice(0, token.index).trimEnd();
        if (prefix.endsWith(".")) continue;
        throw new Error(`${location} uses context-dependent this; choose a view with fixed note/file filters.`);
    }
}

function decodeNativePaths(app: App, output: unknown, path: string, view: string): ReadonlySet<string> {
    const malformed = () => new Error(`Obsidian returned invalid paths for reminder Base "${path}", view "${view}".`);
    if (typeof output !== "string") throw malformed();
    const paths = new Set<string>();
    for (const line of output.split(/\r?\n/u)) {
        if (!line) continue;
        const file = app.vault.getAbstractFileByPath(line);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md" || file.path !== line) throw malformed();
        paths.add(line);
    }
    return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
