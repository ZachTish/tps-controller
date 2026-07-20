import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readTypeScriptTree(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? readTypeScriptTree(path)
      : path.endsWith(".ts")
        ? [readFileSync(path, "utf8")]
        : [];
  }).join("\n");
}

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
const settingsTabSource = readFileSync(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/services/s3agle-attachment-automation-service.ts", import.meta.url), "utf8");
const syncRequestSource = readFileSync(new URL("../src/services/sync-request-service.ts", import.meta.url), "utf8");
const sourceTree = readTypeScriptTree(join(dirname(fileURLToPath(import.meta.url)), "../src"));
const obsoleteRewriteUtility = join(dirname(fileURLToPath(import.meta.url)), "../src/rewrite_auto_create.js");

test("S3 attachment upload automation exposes configurable triggers, settings, and manual command", () => {
  assert.match(typesSource, /interface S3agleAttachmentAutomationSettings/);
  assert.match(typesSource, /runOnActiveNoteOpen: true/);
  assert.match(typesSource, /runOnActiveNoteModify: true/);
  assert.match(typesSource, /runOnPaste: true/);
  assert.doesNotMatch(typesSource, /runAfterCommandIds/);
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
  assert.match(mainSource, /this\.addSettingTab\(new TPSControllerSettingTab\(this\.app, this\)\);\s+this\.startS3agleAttachmentAutomation\(\);/);
  assert.match(settingsTabSource, /S3 Attachment Upload Automation/);
  assert.match(settingsTabSource, /Run on Note Open/);
  assert.match(settingsTabSource, /Run on Active Note Changes/);
  assert.match(settingsTabSource, /Run on Paste/);
  assert.doesNotMatch(settingsTabSource, /Run After Commands|runAfterCommandIds/);
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

test("S3 automation never intercepts Obsidian's command executor", () => {
  assert.doesNotMatch(sourceTree, /runAfterCommandIds|installCommandTriggerPatch|patchedExecuteCommandById|originalExecuteCommandById/);
  assert.doesNotMatch(sourceTree, /commands\s*\.\s*executeCommandById\s*=/);
  assert.doesNotMatch(sourceTree, /Object\.defineProperty\s*\(\s*[^,\n]*commands[^,\n]*,\s*["']executeCommandById["']/);
  assert.doesNotMatch(sourceTree, /Reflect\.set\s*\(\s*[^,\n]*commands[^,\n]*,\s*["']executeCommandById["']/);
  assert.match(sourceTree, /commands\?\.executeCommandById\?\.\(commandId\)/);
  assert.equal(existsSync(obsoleteRewriteUtility), false, "obsolete absolute-path rewrite utility must stay retired");
});

test("S3 attachment upload automation can run from raw paste events", () => {
  assert.match(serviceSource, /document\.addEventListener\("paste", onPaste, true\)/);
  assert.match(serviceSource, /handlePasteEvent/);
  assert.match(serviceSource, /clipboardData\?\.files/);
  assert.match(serviceSource, /clipboardData\?\.items/);
  assert.match(serviceSource, /this\.scheduleForFile\(current, "paste"\)/);
});

test("S3 credentials are resolved only for an execution and missing values fail visibly", () => {
  const startBlock = serviceSource.slice(serviceSource.indexOf("start(): void"), serviceSource.indexOf("stop(): void"));
  assert.doesNotMatch(startBlock, /resolveS3Credentials|readSecret/);
  assert.match(serviceSource, /const credentials = this\.resolveExecutionCredentials\("upload"/);
  assert.match(serviceSource, /const credentials = this\.resolveExecutionCredentials\("bucket-archive"/);
  assert.match(serviceSource, /new Notice\(message, 12000\)/);
  assert.match(serviceSource, /credentials:unavailable/);
});
