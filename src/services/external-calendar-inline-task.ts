export type ExternalTaskLineMutationOutcome =
    | "changed"
    | "unchanged"
    | "not-found"
    | "ambiguous"
    | "invalid-result"
    | "unsafe-frontmatter";

export interface ExternalTaskLineMutationResult {
    content: string;
    lineIndex: number;
    outcome: ExternalTaskLineMutationOutcome;
}

export interface InlineTaskTemporalValues {
    start: string;
    end: string | number;
}

export interface ExternalTaskLineInsertionResult {
    content: string;
    lineIndex: number;
    inserted: boolean;
    unsafeFrontmatter: boolean;
}

type ExternalTaskLineMatcher = (line: string, lineIndex: number, lines: readonly string[]) => boolean;
type ExternalTaskLineMutator = (line: string, lineIndex: number, lines: readonly string[]) => string;

const CHECKBOX_TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]\r\n]?\](?:\s+|$)/u;
const HIDDEN_METADATA_RE = /\s+(?:\[tpsInlineProps::\s*[^\]]+\]|\[tps-inline-props::\s*[^\]]+\]|\[\^tps-inline:[^\]]+\]|<span\b[^>]*data-tps-inline-props=|<!--\s*tps-inline-props:|%%\s*tps-inline-props:)/iu;

export function isMarkdownCheckboxTaskLine(line: string): boolean {
    return CHECKBOX_TASK_RE.test(String(line || ""));
}

export function getVisibleInlineTaskText(line: string): string {
    const value = String(line || "");
    const boundary = value.match(/\s+(?:\[\^tps-inline:[^\]]+\]|<span\b[^>]*data-tps-inline-props=|<!--\s*tps-inline-props:|%%\s*tps-inline-props:)/iu);
    return boundary?.index == null ? value : value.slice(0, boundary.index);
}

export function resolveInlineTaskTemporalValues(options: {
    isAllDay: boolean;
    useEndDuration: boolean;
    allDayStart: string;
    timedStart: string;
    timedEnd: string;
    durationMinutes: number;
}): InlineTaskTemporalValues {
    if (options.isAllDay) {
        return { start: options.allDayStart, end: "" };
    }
    return {
        start: options.timedStart,
        end: options.useEndDuration
            ? Math.max(1, Math.round(options.durationMinutes))
            : options.timedEnd,
    };
}

export function findMarkdownBodyStartLine(lines: readonly string[]): number {
    if (!/^---[ \t]*$/u.test(String(lines[0] || "").replace(/^\uFEFF/u, ""))) return 0;
    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        if (/^(?:---|\.\.\.)[ \t]*$/u.test(String(lines[lineIndex] || ""))) return lineIndex + 1;
    }
    return -1;
}

export function findMarkdownCheckboxTaskLineIndexes(lines: readonly string[]): number[] {
    const bodyStartLine = findMarkdownBodyStartLine(lines);
    if (bodyStartLine < 0) return [];

    const indexes: number[] = [];
    let openFence: { marker: "`" | "~"; length: number } | null = null;
    for (let lineIndex = bodyStartLine; lineIndex < lines.length; lineIndex += 1) {
        const line = String(lines[lineIndex] || "");
        if (openFence) {
            if (isClosingFence(line, openFence)) openFence = null;
            continue;
        }
        const fence = getOpeningFence(line);
        if (fence) {
            openFence = fence;
            continue;
        }
        if (isMarkdownCheckboxTaskLine(line)) indexes.push(lineIndex);
    }
    return indexes;
}

export function mutateExternalTaskLineContent(
    content: string,
    matches: ExternalTaskLineMatcher,
    mutate: ExternalTaskLineMutator,
): ExternalTaskLineMutationResult {
    const source = String(content || "");
    const { lines, separators } = splitLinesPreservingSeparators(source);
    if (findMarkdownBodyStartLine(lines) < 0) {
        return { content: source, lineIndex: -1, outcome: "unsafe-frontmatter" };
    }

    const matchingIndexes: number[] = [];
    for (const lineIndex of findMarkdownCheckboxTaskLineIndexes(lines)) {
        const line = lines[lineIndex] || "";
        if (matches(line, lineIndex, lines)) matchingIndexes.push(lineIndex);
    }

    if (matchingIndexes.length === 0) {
        return { content: source, lineIndex: -1, outcome: "not-found" };
    }
    if (matchingIndexes.length > 1) {
        return { content: source, lineIndex: -1, outcome: "ambiguous" };
    }

    const lineIndex = matchingIndexes[0];
    const currentLine = lines[lineIndex] || "";
    const nextLine = mutate(currentLine, lineIndex, lines);
    if (!isMarkdownCheckboxTaskLine(nextLine)) {
        return { content: source, lineIndex, outcome: "invalid-result" };
    }
    if (nextLine === currentLine) {
        return { content: source, lineIndex, outcome: "unchanged" };
    }

    lines[lineIndex] = nextLine;
    return {
        content: lines.map((line, index) => `${line}${separators[index] || ""}`).join(""),
        lineIndex,
        outcome: "changed",
    };
}

export function insertTaskLineAfterLeadingTaskBlocks(
    content: string,
    taskLine: string,
    isManagedTask: ExternalTaskLineMatcher,
): ExternalTaskLineInsertionResult {
    const source = String(content || "");
    if (!isMarkdownCheckboxTaskLine(taskLine)) {
        return {
            content: source,
            lineIndex: -1,
            inserted: false,
            unsafeFrontmatter: false,
        };
    }

    const { lines, separators } = splitLinesPreservingSeparators(source);
    const bodyStartLine = findMarkdownBodyStartLine(lines);
    if (bodyStartLine < 0) {
        return {
            content: source,
            lineIndex: -1,
            inserted: false,
            unsafeFrontmatter: true,
        };
    }

    const safeTaskIndexes = new Set(findMarkdownCheckboxTaskLineIndexes(lines));
    let insertionIndex = bodyStartLine;
    while (
        insertionIndex < lines.length
        && safeTaskIndexes.has(insertionIndex)
        && isManagedTask(lines[insertionIndex] || "", insertionIndex, lines)
    ) {
        const parentIndent = getIndentWidth(lines[insertionIndex] || "");
        insertionIndex += 1;
        while (insertionIndex < lines.length) {
            const line = lines[insertionIndex] || "";
            if (!line.trim()) {
                let nextContentLine = insertionIndex + 1;
                while (nextContentLine < lines.length && !(lines[nextContentLine] || "").trim()) {
                    nextContentLine += 1;
                }
                if (
                    nextContentLine < lines.length
                    && getIndentWidth(lines[nextContentLine] || "") > parentIndent
                ) {
                    insertionIndex = nextContentLine;
                    continue;
                }
                break;
            }
            if (getIndentWidth(line) <= parentIndent) break;
            insertionIndex += 1;
        }
    }

    const nearbySeparator = separators[insertionIndex - 1]
        || separators[insertionIndex]
        || "\n";
    lines.splice(insertionIndex, 0, taskLine);
    separators.splice(insertionIndex, 0, nearbySeparator);
    return {
        content: lines.map((line, index) => `${line}${separators[index] || ""}`).join(""),
        lineIndex: insertionIndex,
        inserted: true,
        unsafeFrontmatter: false,
    };
}

export function addTagToInlineTaskLine(line: string, rawTag: string): string {
    if (!isMarkdownCheckboxTaskLine(line)) return line;
    const tag = normalizeInlineTag(rawTag);
    if (!tag) return line;
    const tagPattern = new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?=\\s|$)`, "iu");
    if (tagPattern.test(line)) return line;
    return insertBeforeHiddenMetadata(line, `#${tag}`);
}

export function setInlineTaskFieldValue(line: string, rawKey: string, rawValue: unknown): string {
    if (!isMarkdownCheckboxTaskLine(line)) return line;
    const key = String(rawKey || "").trim();
    if (!key) return line;
    const value = rawValue == null ? "" : String(rawValue).trim();
    const hiddenMatch = findHiddenMetadata(line);
    const hiddenStart = hiddenMatch?.index ?? line.length;
    const visible = line.slice(0, hiddenStart);
    const hidden = line.slice(hiddenStart);
    const fieldPattern = new RegExp(
        `[\\[(]\\s*${escapeRegExp(key)}\\s*::\\s*[^\\]\\)\\r\\n]*[\\]\\)]`,
        "iu",
    );
    const fieldMatch = fieldPattern.exec(visible);
    if (fieldMatch?.index != null) {
        const replacement = value ? `[${key}:: ${value}]` : "";
        return `${visible.slice(0, fieldMatch.index)}${replacement}${visible.slice(fieldMatch.index + fieldMatch[0].length)}${hidden}`;
    }
    if (!value) return line;
    return insertBeforeHiddenMetadata(line, `[${key}:: ${value}]`);
}

export function patchCanonicalInlineTaskMetadata(
    line: string,
    updates: Record<string, unknown | null>,
): { line: string; patched: boolean } {
    if (!isMarkdownCheckboxTaskLine(line)) return { line, patched: false };
    const matches = Array.from(line.matchAll(/%%\s*tps-inline-props:([\s\S]*?)\s*%%/giu));
    if (matches.length !== 1) return { line, patched: false };
    const match = matches[0];
    if (match.index == null) return { line, patched: false };

    let metadata: Record<string, unknown>;
    try {
        const parsed = JSON.parse(String(match[1] || "").trim());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { line, patched: false };
        }
        metadata = parsed as Record<string, unknown>;
    } catch {
        return { line, patched: false };
    }

    let changed = false;
    for (const [key, value] of Object.entries(updates || {})) {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) continue;
        const existingKeys = Object.keys(metadata).filter(
            (candidate) => candidate.trim().toLowerCase() === cleanKey.toLowerCase(),
        );
        const existingKey = existingKeys[0];
        for (const duplicateKey of existingKeys.slice(1)) {
            delete metadata[duplicateKey];
            changed = true;
        }
        if (value == null || value === "") {
            for (const candidate of existingKeys.slice(0, 1)) {
                delete metadata[candidate];
                changed = true;
            }
            continue;
        }
        const targetKey = existingKey || cleanKey;
        if (metadata[targetKey] !== value) {
            metadata[targetKey] = value;
            changed = true;
        }
    }
    if (!changed) return { line, patched: true };

    const replacement = `%% tps-inline-props:${JSON.stringify(metadata)} %%`;
    return {
        line: `${line.slice(0, match.index)}${replacement}${line.slice(match.index + match[0].length)}`,
        patched: true,
    };
}

export function ensureInlineTaskTitle(line: string, rawTitle: string): string {
    if (!isMarkdownCheckboxTaskLine(line)) return line;
    const title = String(rawTitle || "").replace(/\s+/gu, " ").trim();
    if (!title) return line;

    const prefixMatch = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[[^\]\r\n]?\]\s*)(.*)$/u);
    if (!prefixMatch) return line;
    const body = String(prefixMatch[2] || "");
    const metadataIndex = findMetadataStart(body);
    const titlePart = (metadataIndex >= 0 ? body.slice(0, metadataIndex) : body)
        .replace(/#[A-Za-z0-9_/-]+/gu, "")
        .trim();
    if (titlePart) return line;

    return `${prefixMatch[1]}${title}${body ? ` ${body.trimStart()}` : ""}`.trimEnd();
}

function insertBeforeHiddenMetadata(line: string, token: string): string {
    const hiddenMatch = findHiddenMetadata(line);
    if (!hiddenMatch || hiddenMatch.index == null) {
        return `${line.trimEnd()} ${token}`.trimEnd();
    }
    const before = line.slice(0, hiddenMatch.index).trimEnd();
    const after = line.slice(hiddenMatch.index).trimStart();
    return `${before} ${token} ${after}`.trimEnd();
}

function findMetadataStart(body: string): number {
    const candidates = [
        body.search(/(?:^|\s)[\[(]\s*[A-Za-z0-9_.-]+\s*::/u),
        body.search(/(?:^|\s)#[A-Za-z0-9_/-]+/u),
        body.search(/(?:^|\s)(?:%%\s*tps-inline-props:|<!--\s*tps-inline-props:|<span\b[^>]*data-tps-inline-props=|\[\^tps-inline:)/iu),
    ].filter((index) => index >= 0);
    return candidates.length ? Math.min(...candidates) : -1;
}

function findHiddenMetadata(line: string): RegExpExecArray | null {
    HIDDEN_METADATA_RE.lastIndex = 0;
    const match = HIDDEN_METADATA_RE.exec(line);
    HIDDEN_METADATA_RE.lastIndex = 0;
    return match;
}

function splitLinesPreservingSeparators(source: string): { lines: string[]; separators: string[] } {
    const lines: string[] = [];
    const separators: string[] = [];
    const pattern = /\r\n|\n|\r/gu;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        lines.push(source.slice(start, match.index));
        separators.push(match[0]);
        start = match.index + match[0].length;
    }
    lines.push(source.slice(start));
    return { lines, separators };
}

function getOpeningFence(line: string): { marker: "`" | "~"; length: number } | null {
    const match = String(line || "").match(/^\s*(`{3,}|~{3,})/u);
    if (!match) return null;
    return {
        marker: match[1][0] as "`" | "~",
        length: match[1].length,
    };
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
    const candidate = String(line || "").match(/^\s*(`+|~+)\s*$/u)?.[1] || "";
    return candidate[0] === fence.marker && candidate.length >= fence.length;
}

function getIndentWidth(line: string): number {
    const leading = String(line || "").match(/^[\t ]*/u)?.[0] || "";
    let width = 0;
    for (const char of leading) width += char === "\t" ? 4 : 1;
    return width;
}

function normalizeInlineTag(value: string): string {
    return String(value || "")
        .trim()
        .replace(/^#/, "")
        .replace(/[^A-Za-z0-9_/-]/gu, "")
        .replace(/^\/+|\/+$/gu, "");
}

function escapeRegExp(value: string): string {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
