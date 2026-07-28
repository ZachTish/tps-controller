export interface DailyNoteTemplateContext {
    title: string;
    formatDate: (format: string) => string;
    formatTime: (format: string) => string;
    defaultDateFormat?: string;
    defaultTimeFormat?: string;
}

/**
 * Expand the variables owned by Obsidian's core Daily Notes template support.
 * Other processors, including Templater, retain their own expressions unchanged.
 */
export function applyDailyNoteTemplateVariables(
    content: string,
    context: DailyNoteTemplateContext,
): string {
    const defaultDateFormat = String(context.defaultDateFormat || "").trim() || "YYYY-MM-DD";
    const defaultTimeFormat = String(context.defaultTimeFormat || "").trim() || "HH:mm";
    return String(content ?? "")
        .replace(/\{\{date:([^}]+)\}\}/g, (_match, format) => context.formatDate(String(format).trim()))
        .replace(/\{\{time:([^}]+)\}\}/g, (_match, format) => context.formatTime(String(format).trim()))
        .replace(/\{\{date\}\}/g, context.formatDate(defaultDateFormat))
        .replace(/\{\{time\}\}/g, context.formatTime(defaultTimeFormat))
        .replace(/\{\{title\}\}/g, context.title);
}
