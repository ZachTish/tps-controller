import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const main=readFileSync('src/main.ts','utf8'),settings=readFileSync('src/settings-tab.ts','utf8');
test('attachment execution, cloud transport and diagnostics have no runtime owners',()=>{
 for(const name of ['service','engine','crypto','device-state','gcs-remote','local-files','legacy-migration','mobile-diagnostic','settings-ui','model'])assert.equal(existsSync('src/services/attachment-sync/'+name+'.ts'),false,name);
 assert.equal(existsSync('src/services/s3-credential-service.ts'),false);
 assert.doesNotMatch(main,/AttachmentSyncService|attachmentSyncService|S3agleAttachmentAutomation|migrateLegacyS3Credentials|RetainedLegacyS3|sync-attachments-now|run-s3-bucket-archive-now|test-attachment-sync-mobile/);
 assert.doesNotMatch(settings,/renderAttachmentSyncSettings|attachmentSync|Attachment sync|Sync attachments|activeAutomation/);
});
test('legacy attachment schema is storage-only, without normalization or credential migration',()=>{
 const schema=readFileSync('src/services/attachment-sync/settings.ts','utf8');
 assert.doesNotMatch(schema,/function|SecretStorage|setSecret|normalizeAttachmentSync/);
 assert.doesNotMatch(main,/delete .*attachmentSync|delete .*s3agleAttachmentAutomation|\.secretStorage|deleteDatabase/);
 assert.match(main,/\.\.\.JSON\.parse\(JSON\.stringify\(this\.settings\)\)/);
});
