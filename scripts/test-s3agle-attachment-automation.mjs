// The offloader was intentionally retired. Its behavior tests were replaced by
// attachment-sync engine/crypto/GCS/local/legacy suites; these guard the handoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const main=readFileSync(new URL('src/main.ts',root),'utf8');
test('legacy command remains an alias to attachment synchronization',()=>{
  assert.match(main,/id: "run-s3agle-attachment-automation-now"[\s\S]*?name: "Sync Attachments Now \(legacy shortcut\)"/);
  assert.match(main,/async runS3agleAttachmentAutomationNow\(\): Promise<void> \{\s*await this\.attachmentSyncService\.runNow\(\)/);
});
test('obsolete archive command cannot run a bucket mutation',()=>{
  const method=main.slice(main.indexOf('    async runS3BucketArchiveNow()'),main.indexOf('    restartTwoStageArchiveLoop():'));
  assert.match(method,/retired/);assert.doesNotMatch(method,/remote\.|archiveRequests|runBucketArchiveNow\(/);
  assert.equal(/\bstartS3BucketArchiveLoop|s3agleAttachmentAutomationService|DisabledS3AttachmentAutomationService/.test(main),false);
});
test('old archive requests are acknowledged without touching their source files',()=>{
  const start=main.indexOf('if (request.scope.includes("s3agle-archive"))');
  const block=main.slice(start,main.indexOf('}, () => this.syncRequestService.acknowledgeRequest',start));
  assert.match(block,/legacy-source-archive:retired/);
  assert.doesNotMatch(block,/fulfillArchiveRequests|\.rename\(|\.delete\(|\.trash/);
});
test('the retired public uploader is absent and legacy mutation switches normalize off',()=>{
  assert.equal(existsSync(new URL('src/services/s3agle-attachment-automation-service.ts',root)),false);
  const normalize=main.slice(main.indexOf('private sanitizeS3agleAttachmentAutomationSettings'),main.indexOf('private async migrateS3agleSettingsIfNeeded'));
  assert.match(normalize,/enabled: false/);assert.match(normalize,/archiveUploadedSources: false/);
  assert.match(normalize,/archiveUnreferencedBucketObjects: false/);assert.match(normalize,/makeUploadedObjectsPublic: false/);
});
