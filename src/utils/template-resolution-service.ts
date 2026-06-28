import { App, TFile, normalizePath } from "obsidian";
import * as logger from "../logger";
import { getPluginById } from "../core";

export interface TemplateResolutionOptions {
  allowBasenameMatchInTemplaterRoot?: boolean;
  warnOnAmbiguousBasename?: boolean;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function normalizeInputPath(path: string): string {
  return normalizePath(path.trim()).replace(/^\/+/, "");
}

export function getTemplaterRoot(app: App): string | null {
  const templater = getPluginById(app, 'templater-obsidian');
  const folder = (templater as any)?.settings?.templates_folder;
  if (typeof folder === "string" && folder.trim()) {
    return normalizePath(folder.trim());
  }
  return null;
}

export function resolveTemplateFile(
  app: App,
  path: string | null | undefined,
  options: TemplateResolutionOptions = {},
): TFile | null {
  if (!path || !path.trim()) return null;

  const normalized = normalizeInputPath(path);
  if (!normalized) return null;

  const candidates: string[] = [normalized];
  if (!normalized.toLowerCase().endsWith(".md")) {
    candidates.push(`${normalized}.md`);
  }

  const templaterRoot = getTemplaterRoot(app);
  if (templaterRoot) {
    candidates.push(normalizePath(`${templaterRoot}/${normalized}`));
    if (!normalized.toLowerCase().endsWith(".md")) {
      candidates.push(normalizePath(`${templaterRoot}/${normalized}.md`));
    }
  }

  for (const candidate of unique(candidates)) {
    const file = app.vault.getAbstractFileByPath(candidate);
    if (file instanceof TFile) {
      return file;
    }
  }

  if (!templaterRoot || options.allowBasenameMatchInTemplaterRoot !== true) {
    return null;
  }

  const basenameProbe = normalized.split("/").pop()?.replace(/\.md$/i, "");
  if (!basenameProbe) return null;
  const probeLower = basenameProbe.toLowerCase();
  const rootPrefix = `${templaterRoot}/`;
  const matches = app.vault
    .getMarkdownFiles()
    .filter((file) => file.path.startsWith(rootPrefix))
    .filter((file) => file.basename.toLowerCase() === probeLower);

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1 && options.warnOnAmbiguousBasename !== false) {
    logger.warn("[TemplateResolver] Ambiguous template basename match.", {
      input: path,
      basename: basenameProbe,
      matches: matches.map((file) => file.path),
    });
  }

  return null;
}
