import { App, Modal, TFile, normalizePath, Notice, moment } from "obsidian";
import { ExternalCalendarEvent } from "../types";
import * as logger from "../logger";
import { formatDateTimeForFrontmatter } from "../utils";
import { createBidirectionalLink } from "./parent-child-link";
import {
  applyTemplateVars,
  buildExternalEventTemplateVars,
  type TemplateVars,
} from "../utils/template-variable-service";
import { resolveTemplateFile as resolveTemplateFilePath } from "../utils/template-resolution-service";
import { mergeTagInputs, normalizeTagValue } from "../utils/tag-utils";
import { getPluginById, getErrorMessage } from "../core";
import {
  buildCalendarExternalId,
  canAutomaticallyMutateSourceViaGcm,
  canAutomaticallyMutateViaGcm,
  ensureInternalIdInFrontmatter,
  getExternalId,
  prepareInstanceSourceViaGcm,
} from "../tps-gcm-api";

const malformedFrontmatterWarnedPaths = new Set<string>();

export class ExternalEventModal extends Modal {
  private event: ExternalCalendarEvent;
  private onCreateNote: (event: ExternalCalendarEvent) => Promise<void>;
  private onHide?: (event: ExternalCalendarEvent) => Promise<void>;

  constructor(
    app: App,
    event: ExternalCalendarEvent,
    onCreateNote: (event: ExternalCalendarEvent) => Promise<void>,
    onHide?: (event: ExternalCalendarEvent) => Promise<void>
  ) {
    super(app);
    this.event = event;
    this.onCreateNote = onCreateNote;
    this.onHide = onHide;
  }

  onOpen() {
    this.modalEl.addClass("tps-keyboard-aware-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("external-event-modal");

    // Title
    contentEl.createEl("h2", { text: this.event.title });

    // Details container
    const detailsEl = contentEl.createDiv({ cls: "external-event-details" });

    // Time
    const timeEl = detailsEl.createDiv({ cls: "external-event-field" });
    timeEl.createEl("strong", { text: "When: " });
    timeEl.createSpan({
      text: this.formatEventTime(this.event.startDate, this.event.endDate, this.event.isAllDay),
    });

    // Location
    if (this.event.location) {
      const locationEl = detailsEl.createDiv({ cls: "external-event-field" });
      locationEl.createEl("strong", { text: "Location: " });
      locationEl.createSpan({ text: this.event.location });
    }

    // Organizer
    if (this.event.organizer) {
      const organizerEl = detailsEl.createDiv({ cls: "external-event-field" });
      organizerEl.createEl("strong", { text: "Organizer: " });
      organizerEl.createSpan({ text: this.event.organizer });
    }

    // Attendees
    if (this.event.attendees && this.event.attendees.length > 0) {
      const attendeesEl = detailsEl.createDiv({ cls: "external-event-field" });
      attendeesEl.createEl("strong", { text: "Attendees: " });
      attendeesEl.createSpan({ text: this.event.attendees.join(", ") });
    }

    // Description
    if (this.event.description) {
      const descEl = detailsEl.createDiv({ cls: "external-event-field" });
      descEl.createEl("strong", { text: "Description: " });
      const descText = detailsEl.createDiv({ cls: "external-event-description" });
      descText.setText(this.event.description);
    }

    // URL
    if (this.event.url) {
      const urlEl = detailsEl.createDiv({ cls: "external-event-field" });
      urlEl.createEl("strong", { text: "Link: " });
      const link = urlEl.createEl("a", {
        text: this.event.url,
        href: this.event.url,
      });
      link.setAttr("target", "_blank");
    }

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    buttonContainer.style.marginTop = "20px";
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.justifyContent = "flex-end";

    if (this.onHide) {
      const hideBtn = buttonContainer.createEl("button", {
        text: "Hide Event",
      });
      hideBtn.addEventListener("click", async () => {
        if (this.onHide) {
          await this.onHide(this.event);
          this.close();
        }
      });
    }

    const createNoteBtn = buttonContainer.createEl("button", {
      text: "Create Meeting Note",
      cls: "mod-cta",
    });
    createNoteBtn.addEventListener("click", async () => {
      await this.onCreateNote(this.event);
      this.close();
    });

    const closeBtn = buttonContainer.createEl("button", {
      text: "Close",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  private formatEventTime(start: Date, end: Date, isAllDay: boolean): string {
    const dateOptions: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    };

    const timeOptions: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    };

    if (isAllDay) {
      return new Intl.DateTimeFormat(undefined, dateOptions).format(start);
    }

    const dateStr = new Intl.DateTimeFormat(undefined, dateOptions).format(start);
    const startTime = new Intl.DateTimeFormat(undefined, timeOptions).format(start);
    const endTime = new Intl.DateTimeFormat(undefined, timeOptions).format(end);

    return `${dateStr}, ${startTime} - ${endTime}`;
  }
}

export async function createMeetingNoteFromExternalEvent(
  app: App,
  event: ExternalCalendarEvent,
  templatePath: string | null,
  folderPath: string | null,
  startProperty: string | null,
  endProperty: string | null,
  useEndDuration: boolean,
  calendarTag: string | null = null,
  parentFile?: TFile | null,
  parentLinkKey?: string,
  childLinkKey?: string,
  frontmatterKeys?: {
    eventIdKey: string;
    uidKey: string;
    sourceUrlKey?: string;
    titleKey: string;
    statusKey: string;
  },
  existingFile?: TFile
): Promise<TFile | null> {
  const externalId = buildCalendarExternalId(app, event);
  const logContext = {
    title: event.title || "",
    externalId,
    eventId: event.id || "",
    uid: event.uid || "",
    sourceUrl: event.sourceUrl || "",
    startDate: event.startDate?.toISOString?.() || "",
    folderPath: folderPath || "",
    templatePath: templatePath || "",
    existingPath: existingFile?.path || "",
  };
  logger.flow("CreateMeetingNote", "start", {
    ...logContext,
    hasParent: parentFile instanceof TFile,
    useEndDuration,
  });

  // Load template (supports templater folder + relative paths)
  let templateContent = "";
  let templateFile = await resolveTemplateFromPath(app, templatePath);
  logger.flow("CreateMeetingNote", "template:resolved", {
    ...logContext,
    templateFile: templateFile?.path || "",
    configured: !!templatePath,
  });

  if (templateFile) {
    const templateVars = buildExternalEventTemplateVars(null, {
      id: event.id,
      uid: event.uid,
      title: event.title,
      description: event.description,
      location: event.location,
      organizer: event.organizer,
      attendees: event.attendees,
      url: event.url,
      startISO: event.startDate.toISOString(),
      endISO: event.endDate.toISOString(),
    });
    const processed = await processTemplate(app, templateFile, templateVars);
    if (processed != null) {
      templateContent = processed;
      logger.flow("CreateMeetingNote", "template:processed", {
        ...logContext,
        templateFile: templateFile.path,
        bytes: processed.length,
      });
    } else {
      templateContent = prepareInstanceSourceOrThrow(
        app,
        await app.vault.read(templateFile),
        templateFile.path,
      );
      logger.flowWarn("CreateMeetingNote", "template:fallback-raw", {
        ...logContext,
        templateFile: templateFile.path,
        bytes: templateContent.length,
      });
    }
  }

  // Build frontmatter object for fields we need to set. Calendar identity is
  // intentionally collapsed to tpsId + externalId; legacy keys are read only
  // for compatibility and removed when this path touches a note.
  const titleKey = frontmatterKeys?.titleKey || "title";
  const statusKey = frontmatterKeys?.statusKey || "status";

  const frontmatter: Record<string, any> = {};
  ensureInternalIdInFrontmatter(app, frontmatter);
  frontmatter[titleKey] = event.title;
  frontmatter.externalId = externalId;
  if (event.isAllDay) {
    frontmatter["allDay"] = true;
  }
  if (event.url) {
    frontmatter.url = event.url.trim().replace(/\/+$/, "");
  }

  if (event.endDate.getTime() < Date.now()) {
    frontmatter[statusKey] = "complete";
  }

  if (startProperty) {
    frontmatter[startProperty] = formatDateTimeForFrontmatter(event.startDate);
  }

  if (endProperty) {
    if (useEndDuration) {
      const durationMinutes = Math.round(
        (event.endDate.getTime() - event.startDate.getTime()) / (60 * 1000)
      );
      // Always use minutes (e.g. 90)
      frontmatter[endProperty] = durationMinutes;
    } else {
      frontmatter[endProperty] = formatDateTimeForFrontmatter(event.endDate);
    }
  }

  // Only explicit templates should write body content. With no configured
  // template, create an empty note and let frontmatter/title carry the event.
  const bodyContent = templateContent || "";

  let file: TFile;
  let createdByThisCall = false;
  if (existingFile) {
    file = existingFile;
    const existingContent = await app.vault.read(file);
    logger.flow("CreateMeetingNote", "reuse:explicit-file", {
      ...logContext,
      path: file.path,
      empty: !existingContent.trim(),
    });
    if (!existingContent.trim()) {
      const written = await writeBodyIfEmptyAutomatically(app, file, bodyContent, "reuse-explicit-file");
      if (!written) return null;
      logger.flow("CreateMeetingNote", "reuse:explicit-file-body-written", { ...logContext, path: file.path });
    }
  } else {
    const resolvedEventIdKey = frontmatterKeys?.eventIdKey || "externalEventId";
    const existingByExternalId = findExistingNoteByExternalId(app, externalId);
    if (existingByExternalId) {
      logger.flow("CreateMeetingNote", "reuse:external-id", { ...logContext, path: existingByExternalId.path });
      return existingByExternalId;
    }

    if (event.id) {
      const existingByEventId = findExistingNoteByLegacyCalendarIdentity(
        app,
        event.id,
        event.sourceUrl,
        resolvedEventIdKey,
        frontmatterKeys?.sourceUrlKey || "tpsCalendarSourceUrl",
      );
      if (existingByEventId) {
        logger.flow("CreateMeetingNote", "reuse:legacy-event-id", { ...logContext, path: existingByEventId.path });
        return existingByEventId;
      }
    }

    if (event.uid) {
      const existingByUidDate = await findExistingNoteByUidAndDate(
        app,
        event.uid,
        event.startDate,
        frontmatterKeys?.uidKey || "tpsCalendarUid",
        startProperty || "scheduled",
        folderPath || null,
      );
      if (existingByUidDate) {
        logger.flow("CreateMeetingNote", "reuse:uid-date", { ...logContext, path: existingByUidDate.path });
        return existingByUidDate;
      }
    }

    // Tertiary check: scan target folder for a file whose title matches and
    // whose frontmatter date is on the same day. Catches old YYYY-MM-DD named
    // files that predate the current event-ID format.
    if (event.title) {
      const sanitizedForSearch = event.title
        .replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const existingByTitleDay = findExistingNoteByTitleAndDay(
        app,
        sanitizedForSearch,
        folderPath,
        event.startDate,
        startProperty || "scheduled",
      );
      if (existingByTitleDay) {
        logger.flow("CreateMeetingNote", "reuse:title-day", { ...logContext, path: existingByTitleDay.path });
        return existingByTitleDay;
      }
    }

    const folder = folderPath ? normalizePath(folderPath) : "";

    if (folder) {
      const folderFile = app.vault.getAbstractFileByPath(folder);
      if (!folderFile) {
        try {
          await app.vault.createFolder(folder);
        } catch (e) {
          // tolerate races where another process created the folder concurrently
          const nowExists = app.vault.getAbstractFileByPath(folder);
          if (nowExists) {
            logger.flow("CreateMeetingNote", "folder:create-raced", { ...logContext, folder });
          } else {
            logger.flowWarn("CreateMeetingNote", "folder:create-failed", { ...logContext, folder, error: logger.errorSummary(e) });
          }
        }
      }
    }

    const rawBasename = sanitizeFileName(event.title) || "Untitled Event";
    const safeBasename = sanitizePathSegment(app, rawBasename);
    const deterministicPath = normalizePath(folder ? `${folder}/${safeBasename}.md` : `${safeBasename}.md`);

    const existingAtPath = app.vault.getAbstractFileByPath(deterministicPath) || findFileByPathInsensitive(app, deterministicPath);
    if (existingAtPath instanceof TFile) {
      const existingExternalId = getExternalId(app, app.metadataCache.getFileCache(existingAtPath)?.frontmatter);
      if (!existingExternalId || existingExternalId === externalId) {
        file = existingAtPath;
        const existingContent = await app.vault.read(file);
        logger.flow("CreateMeetingNote", "reuse:path", {
          ...logContext,
          path: file.path,
          existingExternalId: existingExternalId || "",
          empty: !existingContent.trim(),
        });
        if (!existingContent.trim()) {
          const written = await writeBodyIfEmptyAutomatically(app, file, bodyContent, "reuse-path");
          if (!written) return null;
          logger.flow("CreateMeetingNote", "reuse:path-body-written", { ...logContext, path: file.path });
        }
      } else {
        const availablePath = await nextAvailableMarkdownPath(app, folder, safeBasename);
        logger.flow("CreateMeetingNote", "create:path-conflict", {
          ...logContext,
          deterministicPath,
          existingPath: existingAtPath.path,
          availablePath,
        });
        file = await app.vault.create(availablePath, bodyContent);
        createdByThisCall = true;
        logger.flow("CreateMeetingNote", "create:done", { ...logContext, path: file.path, route: "path-conflict-available" });
      }
    } else {
      const maxRetries = 3;
      const retryDelayMs = 100;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          logger.flow("CreateMeetingNote", "create:attempt", { ...logContext, attempt: attempt + 1, maxRetries, deterministicPath });
          file = await app.vault.create(deterministicPath, bodyContent);
          createdByThisCall = true;

          await new Promise(resolve => setTimeout(resolve, 250));

          try {
            await app.vault.cachedRead(file);
            logger.flow("CreateMeetingNote", "create:verified", { ...logContext, path: file.path, attempt: attempt + 1 });
          } catch (readError) {
            logger.flowWarn("CreateMeetingNote", "create:read-wait", { ...logContext, path: file.path, error: logger.errorSummary(readError) });
            await new Promise(resolve => setTimeout(resolve, 250));
            try {
              await app.vault.cachedRead(file);
            } catch (finalError) {
              logger.flowWarn("CreateMeetingNote", "create:read-still-pending", { ...logContext, deterministicPath, error: logger.errorSummary(finalError) });
            }
          }

          lastError = null;
          logger.flow("CreateMeetingNote", "create:done", { ...logContext, path: file.path, route: "created", attempt: attempt + 1 });
          break;
        } catch (error: any) {
          lastError = error;
          const errorMessage = error?.message || String(error);

          if (errorMessage.includes("already exists") || errorMessage.includes("file already exists")) {
            const racedFile = app.vault.getAbstractFileByPath(deterministicPath) || findFileByPathInsensitive(app, deterministicPath);
            if (racedFile instanceof TFile) {
              file = racedFile;
              lastError = null;
              logger.flow("CreateMeetingNote", "create:recovered-race-path", { ...logContext, path: file.path, attempt: attempt + 1 });
              break;
            }

            const byBasename = findFileByBasenameInFolder(app, folder, safeBasename);
            if (byBasename) {
              file = byBasename;
              lastError = null;
              logger.flow("CreateMeetingNote", "create:recovered-basename", { ...logContext, path: file.path, attempt: attempt + 1 });
              break;
            }

            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue;
          }

          logger.flowWarn("CreateMeetingNote", "create:attempt-failed", { ...logContext, attempt: attempt + 1, error: errorMessage });
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }

      if (!file) {
        // final re-check: maybe another process created the file after our last attempt
        const racedFileFinal = app.vault.getAbstractFileByPath(deterministicPath) || findFileByPathInsensitive(app, deterministicPath);
        if (racedFileFinal instanceof TFile) {
          file = racedFileFinal;
          logger.flow("CreateMeetingNote", "create:recovered-final-path", { ...logContext, path: file.path });
        } else {
          const byBasename = findFileByBasenameInFolder(app, folder, safeBasename);
          if (byBasename) {
            file = byBasename;
            logger.flow("CreateMeetingNote", "create:recovered-final-basename", { ...logContext, path: file.path });
          }
        }

        if (!file) {
          const errorMsg = lastError?.message || "Unknown error";
          logger.flowError("CreateMeetingNote", "create:failed", lastError || new Error(errorMsg), { ...logContext, maxRetries, deterministicPath });
          throw new Error(`Failed to create meeting note after ${maxRetries} attempts: ${errorMsg}`);
        }
      }
    }
  }

  if (createdByThisCall) {
    if (!(await canAutomaticallyMutateViaGcm(app, file))) {
      logger.flowWarn("CreateMeetingNote", "mutation:skip-template-protected", {
        file: file.path,
        reason: "external-calendar-note-templater",
        stage: "preflight",
      });
      return null;
    }
    await runTemplaterOnFile(app, file);
    await sanitizeInstanceSourceAfterTemplater(app, file, "external-calendar-note");
  }

  // Apply identity/event frontmatter in one place so templates with existing
  // frontmatter are merged safely without duplicate YAML blocks.
  const frontmatterApplied = await processFrontmatterSafely(app, file, "external-event-create", (fm) => {
    const normalizedCalendarTag = normalizeTagValue(calendarTag);
    if (normalizedCalendarTag) {
      fm.tags = mergeTagInputs(fm.tags, normalizedCalendarTag);
    }

    deleteFrontmatterValueCaseInsensitive(fm, titleKey);
    deleteFrontmatterValueCaseInsensitive(fm, frontmatterKeys?.eventIdKey || "externalEventId");
    deleteFrontmatterValueCaseInsensitive(fm, frontmatterKeys?.uidKey || "tpsCalendarUid");
    deleteFrontmatterValueCaseInsensitive(fm, "tpsCalendarUid");
    deleteFrontmatterValueCaseInsensitive(fm, frontmatterKeys?.sourceUrlKey || "tpsCalendarSourceUrl");
    deleteFrontmatterValueCaseInsensitive(fm, "tpsCalendarSourceUrl");
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === undefined) continue;
      setFrontmatterValueCaseInsensitive(fm, key, value);
    }
  });
  if (!frontmatterApplied) return null;
  logger.flow("CreateMeetingNote", "frontmatter:applied", {
    ...logContext,
    path: file.path,
    keys: Object.keys(frontmatter).sort(),
  });


  // Create bidirectional link if parent file is provided
  if (parentFile && parentLinkKey && childLinkKey) {
    try {
      await createBidirectionalLink(app, file, parentFile, parentLinkKey, childLinkKey);
      logger.flow("CreateMeetingNote", "parent-link:done", {
        ...logContext,
        path: file.path,
        parentPath: parentFile.path,
        parentLinkKey,
        childLinkKey,
      });
    } catch (error) {
      logger.flowError("CreateMeetingNote", "parent-link:failed", error, {
        ...logContext,
        path: file.path,
        parentPath: parentFile.path,
      });
      // Don't fail the entire operation if linking fails
    }
  }

  const subtypeId: string | null = null;

  app.workspace.trigger('tps-file-created', file, { subtypeId });
  app.workspace.trigger('tps-calendar:file-created', file, { subtypeId });
  logger.flow("CreateMeetingNote", "done", { ...logContext, path: file.path });

  return file;
}

/**
 * Explicitly invoke Templater's "Replace templates in file" on a newly-created
 * file so <% tp.* %> expressions are evaluated in-place.
 * Safe no-op when Templater is not installed.
 *
 * Uses overwrite_file_commands(file, false) — same code path as "Replace templates
 * in the active file" but works on any file object without an active editor view.
 */
async function runTemplaterOnFile(app: App, file: TFile): Promise<void> {
  const templater = getPluginById(app, 'templater-obsidian') as any;
  if (!templater?.templater) {
    logger.flow("CreateMeetingNote", "templater:unavailable", { path: file.path });
    return;
  }
  try {
    await templater.templater.overwrite_file_commands(file, false);
    logger.flow("CreateMeetingNote", "templater:done", { path: file.path });
  } catch (e) {
    logger.flowWarn("CreateMeetingNote", "templater:failed", { path: file.path, error: logger.errorSummary(e) });
  }
}

async function resolveTemplateFromPath(app: App, path: string | null): Promise<TFile | null> {
  return resolveTemplateFilePath(app, path, {
    allowBasenameMatchInTemplaterRoot: true,
    warnOnAmbiguousBasename: true,
  });
}

async function processTemplate(app: App, templateFile: TFile, vars: TemplateVars = {}): Promise<string | null> {
  let raw: string;
  try {
    raw = await app.vault.read(templateFile);
  } catch (e) {
    logger.flowError("CreateMeetingNote", "template:process-failed", e, { templatePath: templateFile.path });
    new Notice(`⚠️ Calendar Base: Error processing template "${templateFile.basename}".\n${getErrorMessage(e)}`);
    return null;
  }
  // GCM preparation is a protection boundary, not a best-effort template
  // transform. Its rejection/error must escape instead of being retried by
  // the legacy raw-template fallback below.
  const prepared = prepareInstanceSourceOrThrow(app, raw, templateFile.path);
  try {
    return applyTemplateVars(prepared, vars);
  } catch (e) {
    logger.flowError("CreateMeetingNote", "template:process-failed", e, { templatePath: templateFile.path });
    new Notice(`⚠️ Calendar Base: Error processing template "${templateFile.basename}".\n${getErrorMessage(e)}`);
    return null;
  }
}

function normalizeKey(key: string): string {
  return String(key || "").trim().toLowerCase();
}

async function getDailyNoteDateFormat(app: App): Promise<string> {
  // Try the core daily-notes internal plugin settings first
  const dailyNotes = (app as any).internalPlugins?.getPluginById?.('daily-notes');
  const format = dailyNotes?.instance?.options?.format;
  if (format && typeof format === 'string' && format.trim()) {
    return format.trim();
  }

  // Fallback to persisted daily-notes core plugin config.
  try {
    const configDir = (app.vault as any)?.configDir || ".obsidian";
    const configPath = normalizePath(`${configDir}/daily-notes.json`);
    const raw = await app.vault.adapter.read(configPath);
    const parsed = JSON.parse(raw);
    const configFormat = parsed?.format;
    if (typeof configFormat === "string" && configFormat.trim()) {
      return configFormat.trim();
    }
  } catch {
    // Ignore config read/parse errors and fall through to default.
  }

  // Fallback to Obsidian's standard default daily note format.
  return 'YYYY-MM-DD';
}

function sanitizeFileName(value: string): string {
  return String(value || "")
    .replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleContainsDateToken(title: string, date: Date, preferredFormat: string): boolean {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) return false;

  const ymd = moment(date).format("YYYY-MM-DD");
  const preferred = moment(date).format(preferredFormat);
  const titleLower = normalizedTitle.toLowerCase();
  if (titleLower.includes(ymd.toLowerCase()) || titleLower.includes(preferred.toLowerCase())) {
    return true;
  }

  const parsed = moment(
    normalizedTitle,
    [preferredFormat, "YYYY-MM-DD", "dddd, MMMM Do YYYY", "MMMM D, YYYY", "MMM D, YYYY"],
    true,
  );
  if (!parsed.isValid()) return false;
  return parsed.format("YYYY-MM-DD") === ymd;
}

function findExistingNoteByExternalId(app: App, externalId: string): TFile | null {
  const targetId = String(externalId || "").trim();
  if (!targetId) return null;
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    if (getExternalId(app, fm) === targetId) return file;
  }
  return null;
}

function findExistingNoteByLegacyCalendarIdentity(
  app: App,
  eventId: string,
  sourceUrl: string | null | undefined,
  eventIdKey: string,
  sourceUrlKey: string,
): TFile | null {
  if (!eventId) return null;
  const targetId = String(eventId).trim();
  const keyLower = eventIdKey.toLowerCase();
  const sourceKeyLower = sourceUrlKey.toLowerCase();
  const targetSourceUrl = normalizeCalendarSourceUrl(sourceUrl);
  const unscopedCandidates: TFile[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const storedId = findFrontmatterValueCaseInsensitive(fm, keyLower);
    if (storedId == null) continue;
    if (String(storedId).trim() !== targetId) continue;
    const storedSourceUrl = normalizeCalendarSourceUrl(findFrontmatterValueCaseInsensitive(fm, sourceKeyLower));
    if (targetSourceUrl && storedSourceUrl === targetSourceUrl) return file;
    if (!storedSourceUrl) unscopedCandidates.push(file);
  }
  return unscopedCandidates.length === 1 ? unscopedCandidates[0] : null;
}

function normalizeCalendarSourceUrl(value: unknown): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

async function findExistingNoteByUidAndDate(
  app: App,
  uid: string,
  startDate: Date,
  uidKey: string,
  startKey: string,
  folderPath: string | null,
): Promise<TFile | null> {
  const uidTarget = String(uid || "").trim();
  if (!uidTarget) return null;

  const dayTarget = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
  const uidKeyLower = String(uidKey || "").trim().toLowerCase();
  const startKeyLower = String(startKey || "").trim().toLowerCase();
  const folderNorm = normalizePath(String(folderPath || "").trim()).toLowerCase();

  for (const file of app.vault.getMarkdownFiles()) {
    if (folderNorm) {
      const fileFolder = normalizePath(file.parent?.path || "").toLowerCase();
      if (fileFolder !== folderNorm) continue;
    }

    const cacheFm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (cacheFm) {
      const storedUid = findFrontmatterValueCaseInsensitive(cacheFm, uidKeyLower);
      const storedStart = findFrontmatterValueCaseInsensitive(cacheFm, startKeyLower)
        || findFrontmatterValueCaseInsensitive(cacheFm, "scheduled");
      if (String(storedUid || "").trim() === uidTarget && doesFrontmatterDateMatchDay(storedStart, dayTarget)) {
        return file;
      }
      continue;
    }

    try {
      const content = await app.vault.cachedRead(file);
      const fm = extractRawFrontmatter(content);
      if (!fm) continue;

      const rawUid = findRawFrontmatterValue(fm, uidKeyLower);
      const rawStart = findRawFrontmatterValue(fm, startKeyLower) || findRawFrontmatterValue(fm, "scheduled");
      if (String(rawUid || "").trim() === uidTarget && doesFrontmatterDateMatchDay(rawStart, dayTarget)) {
        return file;
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  return null;
}

function findFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, keyLower: string): any {
  for (const [key, value] of Object.entries(frontmatter || {})) {
    if (String(key || "").trim().toLowerCase() === keyLower) {
      return value;
    }
  }
  return undefined;
}

function extractRawFrontmatter(content: string): string | null {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

function findRawFrontmatterValue(frontmatterBody: string, keyLower: string): string | null {
  const lines = String(frontmatterBody || "").replace(/\r\n/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;

    const key = line.slice(0, sep).trim().replace(/^['"]|['"]$/g, "").toLowerCase();
    if (key !== keyLower) continue;

    return line.slice(sep + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function doesFrontmatterDateMatchDay(value: unknown, dayTarget: string): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10) === dayTarget;
  }
  if (/^\d{8}$/.test(raw)) {
    const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return normalized === dayTarget;
  }
  return false;
}

/**
 * Search the target folder for an existing note whose basename starts with the
 * sanitized event title and whose frontmatter date (startKey / "scheduled") falls
 * on the same calendar day as startDate.
 *
 * This catches old notes that were created with a YYYY-MM-DD filename suffix before
 * the daily-note date format was adopted, or files that lack identity frontmatter.
 */
function findExistingNoteByTitleAndDay(
  app: App,
  sanitizedTitle: string,
  folderPath: string | null,
  startDate: Date,
  startKey: string,
): TFile | null {
  if (!sanitizedTitle || !startDate) return null;
  const titlePrefix = sanitizedTitle.toLowerCase() + " ";
  const folderNorm = normalizePath(folderPath || "").toLowerCase();
  const yr = startDate.getFullYear();
  const mo = String(startDate.getMonth() + 1).padStart(2, "0");
  const dy = String(startDate.getDate()).padStart(2, "0");
  const dayTarget = `${yr}-${mo}-${dy}`;
  const startKeyLower = String(startKey || "scheduled").toLowerCase();

  for (const file of app.vault.getMarkdownFiles()) {
    const parentPath = normalizePath(file.parent?.path || "").toLowerCase();
    if (folderNorm ? parentPath !== folderNorm : parentPath !== "") continue;
    if (!file.basename.toLowerCase().startsWith(titlePrefix)) continue;

    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const storedStart =
      findFrontmatterValueCaseInsensitive(fm, startKeyLower) ??
      findFrontmatterValueCaseInsensitive(fm, "scheduled");
    if (storedStart && doesFrontmatterDateMatchDay(String(storedStart), dayTarget)) {
      return file;
    }
  }
  return null;
}

function findFileByPathInsensitive(app: App, path: string): TFile | null {
  const target = normalizePath(path).toLowerCase();
  for (const markdownFile of app.vault.getMarkdownFiles()) {
    if (normalizePath(markdownFile.path).toLowerCase() === target) {
      return markdownFile;
    }
  }
  return null;
}

function sanitizePathSegment(app: App, segment: string): string {
  const raw = String(segment || "").trim();
  if (!raw) return "Untitled";
  // @ts-ignore Internal adapter API used by Obsidian itself
  const fsSanitize = (app.vault.adapter as any)?.fs?.sanitize;
  if (typeof fsSanitize === "function") {
    const sanitized = String(fsSanitize(raw) || "").trim();
    if (sanitized) return sanitized;
  }
  return raw.replace(/[\\/:*?"<>|]/g, "").trim() || "Untitled";
}

function findFileByBasenameInFolder(app: App, folderPath: string, basename: string): TFile | null {
  const folderNorm = normalizePath(folderPath || "").toLowerCase();
  const nameNorm = `${String(basename || "").trim().toLowerCase()}.md`;
  if (!nameNorm) return null;

  for (const markdownFile of app.vault.getMarkdownFiles()) {
    const parentPath = normalizePath(markdownFile.parent?.path || "").toLowerCase();
    if (folderNorm ? parentPath !== folderNorm : parentPath !== "") continue;
    if (markdownFile.name.toLowerCase() === nameNorm) {
      return markdownFile;
    }
  }

  return null;
}

function setFrontmatterValueCaseInsensitive(
  target: Record<string, any>,
  key: string,
  value: any,
): void {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  for (const candidate of Object.keys(target || {})) {
    if (normalizeKey(candidate) === normalized) {
      delete target[candidate];
    }
  }
  target[key] = value;
}

function deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): void {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  Object.keys(target || {})
    .filter((candidate) => normalizeKey(candidate) === normalized)
    .forEach((candidate) => delete target[candidate]);
}

async function processFrontmatterSafely(
  app: App,
  file: TFile,
  reason: string,
  mutate: (fm: Record<string, any>) => void,
): Promise<boolean> {
  if (!(await canAutomaticallyMutateViaGcm(app, file))) {
    logger.flowWarn("CreateMeetingNote", "mutation:skip-template-protected", { file: file.path, reason, stage: "preflight" });
    return false;
  }
  const safety = await canMutateFrontmatterSafely(app, file);
  if (!safety.safe) {
    if (!malformedFrontmatterWarnedPaths.has(file.path)) {
      malformedFrontmatterWarnedPaths.add(file.path);
      new Notice(`Skipped frontmatter update for "${file.basename}" (${safety.reason}).`);
    }
    logger.warn(`[ExternalEvent] Skipping frontmatter mutation (${reason})`, {
      file: file.path,
      reason: safety.reason,
    });
    return false;
  }

  try {
    if (!(await canAutomaticallyMutateViaGcm(app, file))) {
      logger.flowWarn("CreateMeetingNote", "mutation:skip-template-protected", { file: file.path, reason, stage: "mutation-boundary" });
      return false;
    }
    const current = await app.vault.read(file);
    if (!canAutomaticallyMutateSourceViaGcm(app, current)) {
      logger.flowWarn("CreateMeetingNote", "mutation:skip-template-protected", { file: file.path, reason, stage: "mutation-boundary" });
      return false;
    }
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      mutate((frontmatter ?? {}) as Record<string, any>);
    });
    return true;
  } catch (error) {
    logger.warn(`[ExternalEvent] Frontmatter mutation failed (${reason})`, {
      file: file.path,
      error,
    });
    return false;
  }
}

function prepareInstanceSourceOrThrow(app: App, source: string, templatePath: string): string {
  const prepared = prepareInstanceSourceViaGcm(app, source);
  if (prepared !== null) return prepared;
  logger.flowWarn("CreateMeetingNote", "template:instance-source-rejected", { templatePath });
  throw new Error(`TPS GCM rejected template-derived content from ${templatePath}.`);
}

async function sanitizeInstanceSourceAfterTemplater(app: App, file: TFile, reason: string): Promise<void> {
  let rejected = false;
  let changed = false;
  await app.vault.process(file, (current) => {
    const prepared = prepareInstanceSourceViaGcm(app, current);
    if (prepared === null) {
      rejected = true;
      return current;
    }
    changed = prepared !== current;
    return prepared;
  });
  if (rejected) {
    logger.flowWarn("CreateMeetingNote", "instance:post-templater-rejected", { path: file.path, reason });
    throw new Error(`TPS GCM rejected the generated content for ${file.path}.`);
  }
  if (changed) logger.flow("CreateMeetingNote", "instance:post-templater-sanitized", { path: file.path, reason });
}

async function writeBodyIfEmptyAutomatically(
  app: App,
  file: TFile,
  bodyContent: string,
  reason: string,
): Promise<boolean> {
  if (!(await canAutomaticallyMutateViaGcm(app, file))) {
    logger.flowWarn("CreateMeetingNote", "mutation:skip-template-protected", { file: file.path, reason, stage: "preflight" });
    return false;
  }
  let allowed = true;
  await app.vault.process(file, (current) => {
    if (!canAutomaticallyMutateSourceViaGcm(app, current)) {
      allowed = false;
      return current;
    }
    return current.trim() ? current : bodyContent;
  });
  if (!allowed) {
    logger.flowWarn("CreateMeetingNote", "mutation:skip-template-protected", { file: file.path, reason, stage: "mutation-boundary" });
  }
  return allowed;
}

async function canMutateFrontmatterSafely(
  app: App,
  file: TFile,
): Promise<{ safe: boolean; reason?: string }> {
  let content = "";
  try {
    content = await app.vault.cachedRead(file);
  } catch (error) {
    logger.warn("[ExternalEvent] Failed reading file for frontmatter safety check", {
      file: file.path,
      error,
    });
    return { safe: false, reason: "file read failed" };
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const bomOffset = normalized.startsWith("\uFEFF") ? 1 : 0;
  if (!normalized.startsWith("---\n", bomOffset)) {
    return { safe: true };
  }

  const firstClose = normalized.indexOf("\n---\n", bomOffset + 4);
  if (firstClose === -1) {
    return { safe: false, reason: "missing frontmatter closing delimiter" };
  }

  const afterFirst = normalized.slice(firstClose + "\n---\n".length);
  const trimmedAfterFirst = afterFirst.replace(/^\s*/, "");
  if (!trimmedAfterFirst.startsWith("---\n")) {
    return { safe: true };
  }

  const secondClose = trimmedAfterFirst.indexOf("\n---\n", 4);
  if (secondClose === -1) {
    return { safe: true };
  }

  const secondBody = trimmedAfterFirst.slice(4, secondClose);
  const hasYamlLikeEntry = secondBody
    .split("\n")
    .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line.trim()));

  if (!hasYamlLikeEntry) {
    return { safe: true };
  }

  return { safe: false, reason: "duplicate leading frontmatter blocks detected" };
}

async function nextAvailableMarkdownPath(app: App, folder: string, basename: string): Promise<string> {
  const cleanBase = sanitizePathSegment(app, basename || "Untitled Event");
  for (let index = 2; index < 1000; index++) {
    const candidate = normalizePath(folder ? `${folder}/${cleanBase} ${index}.md` : `${cleanBase} ${index}.md`);
    const existing = app.vault.getAbstractFileByPath(candidate) || findFileByPathInsensitive(app, candidate);
    if (!(existing instanceof TFile)) return candidate;
  }
  const fallback = `${cleanBase} ${Date.now()}.md`;
  return normalizePath(folder ? `${folder}/${fallback}` : fallback);
}
