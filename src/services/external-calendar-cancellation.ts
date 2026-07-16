const CANCELLED_TITLE_PATTERN = /^\s*cancel(?:l)?ed\s*:/i;

export function isCancelledCalendarTitle(title: unknown): boolean {
    return CANCELLED_TITLE_PATTERN.test(String(title ?? ""));
}

export function cancelOpenInlineTaskLine(line: string): string | null {
    const nextLine = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[\s\]/, "$1[-]");
    return nextLine === line ? null : nextLine;
}
