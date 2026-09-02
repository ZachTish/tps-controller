import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
const settingsTabSource = readFileSync(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const comparisonServicePath = process.env.TPS_CONTROLLER_S3_SERVICE_SOURCE;
const serviceSource = readFileSync(
  comparisonServicePath
    || new URL("../src/services/s3agle-attachment-automation-service.ts", import.meta.url),
  "utf8",
);
if (comparisonServicePath) {
  assert.equal(
    createHash("sha256").update(serviceSource).digest("hex"),
    process.env.TPS_CONTROLLER_S3_SERVICE_SHA256,
    "external S3 service comparison source must match its pinned SHA-256",
  );
}
const syncRequestSource = readFileSync(new URL("../src/services/sync-request-service.ts", import.meta.url), "utf8");

class FakeS3File {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop();
    this.basename = this.name.replace(/\.[^.]+$/u, "");
    this.extension = this.name.includes(".") ? this.name.slice(this.name.lastIndexOf(".") + 1) : "";
  }
}

test("S3 attachment upload automation exposes configurable triggers, settings, and manual command", () => {
  assert.match(typesSource, /interface S3agleAttachmentAutomationSettings/);
  assert.match(typesSource, /runOnActiveNoteOpen: true/);
  assert.match(typesSource, /runOnActiveNoteModify: true/);
  assert.match(typesSource, /runOnPaste: true/);
  assert.match(typesSource, /runAfterCommandIds: \[\]/);
  assert.match(typesSource, /allowedAttachmentExtensions: \[\]/);
  assert.match(typesSource, /ignoredAttachmentExtensions: \[\]/);
  assert.match(typesSource, /makeUploadedObjectsPublic: true/);
  assert.match(typesSource, /accessKeySecretName: "tps-controller-s3-access-key"/);
  assert.match(typesSource, /secretKeySecretName: "tps-controller-s3-secret-key"/);
  assert.match(typesSource, /bucket: ""/);
  assert.match(typesSource, /endpoint: ""/);
  assert.match(typesSource, /archiveUnreferencedBucketObjects: false/);
  assert.match(typesSource, /bucketArchivePrefix: "_archive\/s3\/\{YYYY\}\/\{MM\}\/\{DD\}"/);
  assert.match(mainSource, /id: "run-s3agle-attachment-automation-now"/);
  assert.match(mainSource, /name: "Run S3 Attachment Upload Now"/);
  assert.match(mainSource, /id: "run-s3-bucket-archive-now"/);
  assert.match(mainSource, /name: "Run S3 Bucket Archive Now"/);
  assert.match(mainSource, /migrateS3agleSettingsIfNeeded/);
  assert.match(mainSource, /migrateS3CredentialsFromSettings/);
  assert.match(mainSource, /migrateLegacyS3Credentials/);
  assert.match(mainSource, /retainedLegacyS3Credentials/);
  assert.match(mainSource, /withRetainedLegacyS3Credentials/);
  assert.match(mainSource, /adapter\.read\("\.obsidian\/plugins\/s3agle\/data\.json"\)/);
  assert.match(mainSource, /restartS3agleAttachmentAutomation/);
  assert.match(mainSource, /restartS3BucketArchiveLoop/);
  assert.doesNotMatch(mainSource, /import \{ S3agleAttachmentAutomationService \}/);
  assert.match(mainSource, /DisabledS3AttachmentAutomationService/);
  assert.match(mainSource, /Platform\.isMobile/);
  assert.match(mainSource, /await import\("\.\/services\/s3agle-attachment-automation-service"\)/);
  assert.match(mainSource, /this\.settingsTab = new TPSControllerSettingTab\(this\.app, this\);/);
  assert.match(mainSource, /this\.addSettingTab\(this\.settingsTab\);[\s\S]*this\.startS3agleAttachmentAutomation\(\);/);
  assert.match(settingsTabSource, /S3 Attachment Upload Automation/);
  assert.match(settingsTabSource, /Run on Note Open/);
  assert.match(settingsTabSource, /Run on Active Note Changes/);
  assert.match(settingsTabSource, /Run on Paste/);
  assert.match(settingsTabSource, /Run After Commands/);
  assert.match(settingsTabSource, /Allowed Attachment Extensions/);
  assert.match(settingsTabSource, /Ignored Attachment Extensions/);
  assert.match(settingsTabSource, /Make Uploaded Objects Public/);
  assert.match(settingsTabSource, /S3 Endpoint/);
  assert.match(settingsTabSource, /S3 Bucket/);
  assert.match(settingsTabSource, /Access Key/);
  assert.match(settingsTabSource, /Secret Key/);
  assert.match(settingsTabSource, /SecretComponent/);
  assert.match(settingsTabSource, /accessKeySecretName/);
  assert.match(settingsTabSource, /secretKeySecretName/);
  assert.match(settingsTabSource, /Archive Unreferenced Bucket Objects/);
  assert.match(settingsTabSource, /Bucket Archive Prefix/);
  assert.match(settingsTabSource, /Run S3 Bucket Archive Now/);
  assert.match(settingsTabSource, /Run S3 Upload Now/);
});

test("S3 attachment upload automation uploads, rewrites, and archives only confirmed local sources", () => {
  assert.match(serviceSource, /new S3Client/);
  assert.match(serviceSource, /resolveS3Credentials/);
  assert.match(serviceSource, /readSecret/);
  assert.match(serviceSource, /createS3Client\(credentials\)/);
  assert.doesNotMatch(serviceSource, /rule\.accessKey\b/);
  assert.doesNotMatch(serviceSource, /rule\.secretKey\b/);
  assert.match(serviceSource, /new PutObjectCommand/);
  assert.match(serviceSource, /new PutObjectAclCommand/);
  assert.match(serviceSource, /Bucket: rule\.bucket/);
  assert.match(serviceSource, /Key: key/);
  assert.match(serviceSource, /ContentType: this\.getMimeType/);
  assert.match(serviceSource, /ensurePublicObjectAccess/);
  assert.match(serviceSource, /requestUrl/);
  assert.match(serviceSource, /deleteFailedUpload/);
  assert.match(serviceSource, /shouldUploadAttachment/);
  assert.match(serviceSource, /allowedAttachmentExtensions/);
  assert.match(serviceSource, /ignoredAttachmentExtensions/);
  assert.match(serviceSource, /this\.app\.vault\.modify\(noteFile, updatedContent\)/);
  assert.match(serviceSource, /canAutomaticallyMutateNote\(noteFile, reason, "mutation-boundary"\)[\s\S]*this\.app\.vault\.process\(noteFile/);
  assert.match(serviceSource, /recordUploadedObject/);
  assert.match(serviceSource, /\.tps\/s3-upload-manifest\.json/);
  assert.match(serviceSource, /buildPublicUrl/);
  assert.match(serviceSource, /createHash\("sha256"\)/);
  assert.match(serviceSource, /archiveUploadedSources/);
  assert.match(serviceSource, /requestControllerArchive/);
  assert.match(serviceSource, /fulfillArchiveRequests/);
  assert.match(serviceSource, /archiveControllerRequestedSources/);
  assert.match(serviceSource, /!remainingPaths\.has\(path\)/);
  assert.match(serviceSource, /this\.app\.vault\.rename\(source, targetPath\)/);
  assert.match(mainSource, /request\.scope\.includes\("s3agle-archive"\)/);
  assert.match(mainSource, /fulfillArchiveRequests\(request\.s3agleArchiveRequests\)/);
  assert.match(syncRequestSource, /writeS3agleArchiveRequest/);
  assert.match(syncRequestSource, /s3agleArchiveRequests/);
  assert.match(syncRequestSource, /"s3agle-archive"/);
});

test("S3 bucket archive moves unreferenced uploaded objects instead of deleting directly", () => {
  assert.match(serviceSource, /runBucketArchiveIfDue/);
  assert.match(serviceSource, /runBucketArchiveNow/);
  assert.match(serviceSource, /collectReferencedS3Urls/);
  assert.match(serviceSource, /content\.includes\(url\)/);
  assert.match(serviceSource, /isUrlReferencedInVault/);
  assert.match(serviceSource, /Math\.max\(5, bucketArchiveOrphanDelayMinutes\)/);
  assert.match(serviceSource, /new CopyObjectCommand/);
  assert.match(serviceSource, /new DeleteObjectCommand/);
  assert.match(serviceSource, /buildBucketArchiveKey/);
  assert.match(serviceSource, /entry\.archivedAt = nowMs/);
  assert.match(serviceSource, /entry\.archivedKey = archivedKey/);
  assert.match(mainSource, /startS3BucketArchiveLoop/);
  assert.match(mainSource, /runBucketArchiveIfDue/);
  assert.match(mainSource, /loop:skip-mobile/);
});

test("successful S3 bucket archive runs persist cadence and suppress duplicate interval work", async () => {
  const harness = createBucketArchiveHarness();
  const firstRunAt = 2_000_000;

  await harness.service.runBucketArchiveNow(firstRunAt);

  assert.equal(
    harness.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    firstRunAt,
  );
  assert.deepEqual(harness.savedLastRunAt, [firstRunAt]);
  assert.deepEqual(harness.workCounts(), {
    manifestReads: 1,
    manifestWrites: 1,
    vaultEnumerations: 1,
    noteReads: 1,
    settingsSaves: 1,
  });

  const insideInterval = await harness.service.runBucketArchiveIfDue(
    firstRunAt + 60_000,
  );
  assert.equal(insideInterval, null);
  assert.deepEqual(harness.workCounts(), {
    manifestReads: 1,
    manifestWrites: 1,
    vaultEnumerations: 1,
    noteReads: 1,
    settingsSaves: 1,
  });

  await harness.service.runBucketArchiveIfDue(firstRunAt + 3_600_000);
  assert.equal(
    harness.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    firstRunAt + 3_600_000,
  );
  assert.deepEqual(harness.savedLastRunAt, [
    firstRunAt,
    firstRunAt + 3_600_000,
  ]);
  assert.deepEqual(harness.workCounts(), {
    manifestReads: 2,
    manifestWrites: 2,
    vaultEnumerations: 2,
    noteReads: 2,
    settingsSaves: 2,
  });
});

test("S3 bucket archive cadence remains retryable across guards and save failures", async () => {
  const disabled = createBucketArchiveHarness({
    archiveUnreferencedBucketObjects: false,
  });
  assert.equal(await disabled.service.runBucketArchiveIfDue(2_000_000), null);
  assert.equal(disabled.settingsSaves, 0);
  assert.equal(disabled.manifestReads, 0);

  const replica = createBucketArchiveHarness({}, { isController: false });
  const replicaResult = await replica.service.runBucketArchiveNow(2_000_000);
  assert.equal(replicaResult.archivedCount, 0);
  assert.equal(replicaResult.skippedCount, 0);
  assert.equal(
    replica.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    0,
  );
  assert.equal(replica.settingsSaves, 0);
  assert.equal(replica.manifestReads, 0);

  const unconfigured = createBucketArchiveHarness({ bucket: "" });
  const unconfiguredResult =
    await unconfigured.service.runBucketArchiveNow(2_000_000);
  assert.match(unconfiguredResult.lastError, /settings are incomplete/i);
  assert.equal(
    unconfigured.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    0,
  );
  assert.equal(unconfigured.settingsSaves, 0);
  assert.equal(unconfigured.manifestReads, 0);

  const failedSave = createBucketArchiveHarness(
    { bucketArchiveLastRunAt: 1_000_000 },
    { saveError: new Error("synthetic settings write failure") },
  );
  await assert.rejects(
    failedSave.service.runBucketArchiveNow(2_000_000),
    /synthetic settings write failure/,
  );
  assert.equal(
    failedSave.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    1_000_000,
  );
  assert.equal(failedSave.settingsSaves, 1);
});

test("overlapping S3 bucket archive callers join one retryable run", async () => {
  let releaseSave;
  let reportSaveStarted;
  const saveStarted = new Promise((resolve) => {
    reportSaveStarted = resolve;
  });
  const saveBarrier = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const saveOptions = {
    saveError: new Error("synthetic overlapping settings write failure"),
    beforeSave: async () => {
      reportSaveStarted();
      await saveBarrier;
    },
  };
  const harness = createBucketArchiveHarness(
    { bucketArchiveLastRunAt: 1_000_000 },
    saveOptions,
  );

  const scheduledRun = harness.service.runBucketArchiveNow(2_000_000);
  await saveStarted;
  const manualRun = harness.service.runBucketArchiveNow(3_000_000);
  await new Promise((resolve) => setImmediate(resolve));
  const blockedCounts = harness.workCounts();
  releaseSave();
  const [scheduledResult, manualResult] = await Promise.allSettled([
    scheduledRun,
    manualRun,
  ]);

  assert.deepEqual(blockedCounts, {
    manifestReads: 1,
    manifestWrites: 1,
    vaultEnumerations: 1,
    noteReads: 1,
    settingsSaves: 1,
  });
  assert.equal(scheduledResult.status, "rejected");
  assert.match(scheduledResult.reason.message, /overlapping settings write failure/);
  assert.equal(manualResult.status, "rejected");
  assert.match(manualResult.reason.message, /overlapping settings write failure/);
  assert.equal(
    harness.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    1_000_000,
  );

  saveOptions.saveError = null;
  saveOptions.beforeSave = null;
  const retryResult = await harness.service.runBucketArchiveNow(4_000_000);
  assert.equal(retryResult.archivedCount, 0);
  assert.equal(retryResult.skippedCount, 0);
  assert.equal(
    harness.settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
    4_000_000,
  );
  assert.deepEqual(harness.savedLastRunAt, [4_000_000]);
  assert.deepEqual(harness.workCounts(), {
    manifestReads: 2,
    manifestWrites: 2,
    vaultEnumerations: 2,
    noteReads: 2,
    settingsSaves: 2,
  });
});

test("S3 attachment upload automation can run after user-defined workflow commands", () => {
  assert.match(serviceSource, /installCommandTriggerPatch/);
  assert.match(serviceSource, /scheduleAfterCommandIfConfigured/);
  assert.match(serviceSource, /runAfterCommandIds\.includes\(commandId\)/);
  assert.match(serviceSource, /commandId === "tps-controller:run-s3agle-attachment-automation-now"/);
});

test("S3 attachment upload automation can run from raw paste events", () => {
  assert.match(serviceSource, /document\.addEventListener\("paste", onPaste, true\)/);
  assert.match(serviceSource, /handlePasteEvent/);
  assert.match(serviceSource, /clipboardData\?\.files/);
  assert.match(serviceSource, /clipboardData\?\.items/);
  assert.match(serviceSource, /this\.scheduleForFile\(current, "paste"\)/);
});

test("automatic S3 note work fails closed for template-protected notes while the manual command remains explicit", async () => {
  let fileChecks = 0;
  let noteReads = 0;
  let renames = 0;
  const note = new FakeS3File("Templates/Attachment workflow.md");
  const source = new FakeS3File("Attachments/image.png");
  const settings = {
    archiveFolder: "Archive",
    s3agleAttachmentAutomation: {
      enabled: true,
      runOnActiveNoteOpen: true,
      runOnActiveNoteModify: true,
      runOnPaste: true,
      runAfterCommandIds: [],
      debounceSeconds: 1,
      cooldownMinutes: 1,
      archiveUploadedSources: true,
      allowedAttachmentExtensions: [],
      ignoredAttachmentExtensions: [],
      makeUploadedObjectsPublic: false,
      accessKeySecretName: "access-key",
      secretKeySecretName: "secret-key",
      region: "us-east-1",
      bucket: "bucket",
      folder: "",
      endpoint: "https://s3.example.test",
      useBucketSubdomain: false,
      contentUrl: "",
      hashFileName: false,
      hashSeed: 0,
      archiveUnreferencedBucketObjects: false,
      bucketArchivePrefix: "_archive/s3/{YYYY}/{MM}/{DD}",
      bucketArchiveCheckIntervalMinutes: 60,
      bucketArchiveOrphanDelayMinutes: 60,
      bucketArchiveLastRunAt: 0,
    },
  };
  const app = {
    workspace: { getActiveFile: () => note },
    metadataCache: { getFirstLinkpathDest: () => source },
    vault: {
      getAbstractFileByPath: (path) => path === note.path ? note : path === source.path ? source : null,
      async cachedRead() {
        noteReads += 1;
        return "No local attachment refs";
      },
      async rename() {
        renames += 1;
      },
    },
  };
  const Service = loadS3AutomationService({
    canAutomaticallyMutate: async () => {
      fileChecks += 1;
      return false;
    },
  });
  const service = new Service(app, () => settings, () => true, async () => {}, async () => {}, () => "secret");

  assert.equal(await service.runForFileIfActive(note, "file-open"), null);
  assert.equal(fileChecks, 1);
  assert.equal(noteReads, 0);

  assert.equal(await service.runActiveNoteNow(), null);
  assert.equal(fileChecks, 1, "manual upload must not inherit the background template guard");
  assert.equal(noteReads, 1);

  const archiveResult = await service.fulfillArchiveRequests([{ notePath: note.path, sourcePaths: [source.path] }]);
  assert.equal(archiveResult.archivedCount, 0);
  assert.equal(archiveResult.skippedArchiveCount, 1);
  assert.equal(renames, 0);
});

test("S3 credentials are resolved only for an execution and missing values fail visibly", () => {
  const startBlock = serviceSource.slice(serviceSource.indexOf("start(): void"), serviceSource.indexOf("stop(): void"));
  assert.doesNotMatch(startBlock, /resolveS3Credentials|readSecret/);
  assert.match(serviceSource, /const credentials = this\.resolveExecutionCredentials\("upload"/);
  assert.match(serviceSource, /const credentials = this\.resolveExecutionCredentials\("bucket-archive"/);
  assert.match(serviceSource, /new Notice\(message, 12000\)/);
  assert.match(serviceSource, /credentials:unavailable/);
});

function createBucketArchiveHarness(
  ruleOverrides = {},
  options = {},
) {
  const settings = {
    archiveFolder: "Archive",
    s3agleAttachmentAutomation: {
      enabled: false,
      runOnActiveNoteOpen: true,
      runOnActiveNoteModify: true,
      runOnPaste: true,
      runAfterCommandIds: [],
      debounceSeconds: 10,
      cooldownMinutes: 10,
      archiveUploadedSources: true,
      allowedAttachmentExtensions: [],
      ignoredAttachmentExtensions: [],
      makeUploadedObjectsPublic: true,
      accessKeySecretName: "access-key",
      secretKeySecretName: "secret-key",
      region: "us-east-1",
      bucket: "test-bucket",
      folder: "",
      endpoint: "https://s3.example.test",
      useBucketSubdomain: false,
      contentUrl: "",
      hashFileName: false,
      hashSeed: 0,
      archiveUnreferencedBucketObjects: true,
      bucketArchivePrefix: "_archive/s3/{YYYY}/{MM}/{DD}",
      bucketArchiveCheckIntervalMinutes: 60,
      bucketArchiveOrphanDelayMinutes: 60,
      bucketArchiveLastRunAt: 0,
      ...ruleOverrides,
    },
  };
  const counts = {
    manifestReads: 0,
    manifestWrites: 0,
    vaultEnumerations: 0,
    noteReads: 0,
    settingsSaves: 0,
  };
  const referencedUrl = "https://s3.example.test/test-bucket/image.png";
  const manifest = [{
    key: "image.png",
    url: referencedUrl,
    notePath: "Notes/Active.md",
    sourcePath: "Attachments/image.png",
    uploadedAt: 500_000,
    lastSeenAt: 500_000,
  }];
  const app = {
    vault: {
      adapter: {
        async read() {
          counts.manifestReads += 1;
          return JSON.stringify(manifest);
        },
        async exists() {
          return true;
        },
        async write() {
          counts.manifestWrites += 1;
        },
      },
      getMarkdownFiles() {
        counts.vaultEnumerations += 1;
        return [{ path: "Notes/Active.md" }];
      },
      async cachedRead() {
        counts.noteReads += 1;
        return `Referenced: ${referencedUrl}`;
      },
    },
  };
  const savedLastRunAt = [];
  const Service = loadS3AutomationService();
  const service = new Service(
    app,
    () => settings,
    () => options.isController !== false,
    async () => {},
    async () => {
      counts.settingsSaves += 1;
      settings.s3agleAttachmentAutomation = {
        ...settings.s3agleAttachmentAutomation,
      };
      if (options.beforeSave) await options.beforeSave();
      if (options.saveError) throw options.saveError;
      savedLastRunAt.push(
        settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt,
      );
    },
    () => "synthetic-secret",
  );

  return {
    service,
    settings,
    savedLastRunAt,
    workCounts: () => ({ ...counts }),
    get manifestReads() {
      return counts.manifestReads;
    },
    get settingsSaves() {
      return counts.settingsSaves;
    },
  };
}

function loadS3AutomationService(options = {}) {
  const compiled = ts.transpileModule(serviceSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const nativeRequire = createRequire(import.meta.url);
  class DummyCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class SyntheticCredentialError extends Error {
    constructor(code = "missing-access-key-secret", message = "missing") {
      super(message);
      this.code = code;
    }
  }
  const logger = {
    flow() {},
    flowWarn() {},
    flowError() {},
  };
  const mockRequire = (id) => {
    if (id === "obsidian") {
      return {
        App: class {},
        Notice: class {},
        TFile: FakeS3File,
        normalizePath: (value) =>
          String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
        requestUrl: async () => ({ status: 200 }),
      };
    }
    if (id === "@aws-sdk/client-s3") {
      return {
        CopyObjectCommand: DummyCommand,
        DeleteObjectCommand: DummyCommand,
        GetObjectCommand: DummyCommand,
        PutObjectAclCommand: DummyCommand,
        PutObjectCommand: DummyCommand,
        S3Client: class {
          async send() {
            return {};
          }
        },
      };
    }
    if (id === "@smithy/node-http-handler") {
      return { NodeHttpHandler: class {} };
    }
    if (id === "crypto") return nativeRequire("node:crypto");
    if (id === "../logger") return logger;
    if (id === "../tps-gcm-api") {
      return {
        canAutomaticallyMutateViaGcm: options.canAutomaticallyMutate || (async () => true),
        canAutomaticallyMutateSourceViaGcm: options.canAutomaticallyMutateSource || (() => true),
      };
    }
    if (id === "./s3-credential-service") {
      return {
        resolveS3Credentials: () => ({
          accessKeyId: "synthetic-access-key",
          secretAccessKey: "synthetic-secret-key",
        }),
        S3CredentialConfigurationError: SyntheticCredentialError,
      };
    }
    throw new Error(`Unexpected module in S3 cadence harness: ${id}`);
  };
  const moduleRecord = { exports: {} };
  const context = vm.createContext({
    ArrayBuffer,
    Buffer,
    DataView,
    Date,
    TextEncoder,
    Uint8Array,
    URL,
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      removeEventListener() {},
    },
    setTimeout,
    window: {
      clearTimeout,
      setTimeout,
    },
  });
  const execute = vm.runInContext(
    `(function(require, module, exports) {${compiled}\n})`,
    context,
  );
  execute(mockRequire, moduleRecord, moduleRecord.exports);
  return moduleRecord.exports.S3agleAttachmentAutomationService;
}
