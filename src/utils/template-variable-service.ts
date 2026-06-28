import { TFile } from "obsidian";

export type TemplateVars = Record<string, unknown>;
export type ExternalEventTemplateContext = {
  id: string;
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  organizer?: string | null;
  attendees?: string[] | null;
  url?: string | null;
  startISO: string;
  endISO: string;
};

function pad(num: number): string {
  return String(num).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function flatten(prefix: string, value: unknown, out: TemplateVars): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(source)) {
    const next = prefix ? `${prefix}.${key}` : key;
    out[next] = nested;
    flatten(next, nested, out);
  }
}

export function buildTemplateVars(targetFile: TFile | null, extra: TemplateVars = {}): TemplateVars {
  const now = new Date();
  const vars: TemplateVars = {
    title: targetFile?.basename ?? "",
    date: formatDate(now),
    time: formatTime(now),
    datetime: now.toISOString(),
    timestamp: String(now.getTime()),
    file_name: targetFile?.name ?? "",
    file_basename: targetFile?.basename ?? "",
    file_path: targetFile?.path ?? "",
    file_folder: targetFile ? targetFile.path.replace(/\/[^/]+$/, "") : "",
    ...extra,
  };
  flatten("", vars, vars);
  return vars;
}

export function buildExternalEventTemplateVars(
  targetFile: TFile | null,
  event: ExternalEventTemplateContext,
): TemplateVars {
  return buildTemplateVars(targetFile, {
    title: event.title,
    description: event.description || "",
    location: event.location || "",
    organizer: event.organizer || "",
    attendees: Array.isArray(event.attendees) ? event.attendees : [],
    url: event.url || "",
    start: event.startISO,
    end: event.endISO,
    event: {
      id: event.id,
      uid: event.uid,
      title: event.title,
    },
  });
}

export function applyTemplateVars(content: string, vars: TemplateVars): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, token: string) => {
    const value = vars[token];
    if (value == null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}
