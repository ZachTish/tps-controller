import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const contractPath = fileURLToPath(new URL("../src/services/sync-request-contract.ts", import.meta.url));
const bundle = await build({
  entryPoints: [contractPath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
});
const contract = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const mainSource = await readFile(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const serviceSource = await readFile(fileURLToPath(new URL("../src/services/sync-request-service.ts", import.meta.url)), "utf8");

const normalizePath = (value) => String(value || "")
  .replace(/\\/g, "/")
  .replace(/\/{2,}/g, "/")
  .replace(/^\.\//, "")
  .replace(/\/$/, "");

function loadSyncRequestService() {
  const source = readFileSync(
    new URL("../src/services/sync-request-service.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled.outputText)(
    module,
    module.exports,
    (specifier) => {
      if (specifier === "obsidian") return { normalizePath };
      if (specifier === "../logger") {
        return {
          errorSummary: (error) => String(error?.message || error || ""),
          flow() {},
          flowError() {},
          flowWarn() {},
        };
      }
      if (specifier === "./sync-request-contract") return contract;
      throw new Error(`Unexpected SyncRequestService test import: ${specifier}`);
    },
  );
  return module.exports.SyncRequestService;
}

function createHiddenRequestHarness(initialContent = null) {
  const files = new Map();
  const requestPath = ".obsidian/plugins/tps-controller/.sync-request.json";
  if (initialContent !== null) files.set(requestPath, String(initialContent));
  const operations = {
    adapterProcesses: 0,
    adapterReads: 0,
    adapterWrites: 0,
    indexedCreates: 0,
    indexedLookups: 0,
  };
  const adapter = {
    async exists(path) {
      return files.has(normalizePath(path));
    },
    async read(path) {
      operations.adapterReads += 1;
      const normalized = normalizePath(path);
      if (!files.has(normalized)) throw new Error(`File not found: ${normalized}`);
      return files.get(normalized);
    },
    async write(path, content) {
      operations.adapterWrites += 1;
      files.set(normalizePath(path), String(content));
    },
    async process(path, transform) {
      operations.adapterProcesses += 1;
      const normalized = normalizePath(path);
      if (!files.has(normalized)) throw new Error(`File not found: ${normalized}`);
      const updated = transform(files.get(normalized));
      files.set(normalized, updated);
      return updated;
    },
  };
  const vault = {
    adapter,
    getName: () => "Obsidian Plugin Test Vault",
    getAbstractFileByPath() {
      operations.indexedLookups += 1;
      return null;
    },
    async create() {
      operations.indexedCreates += 1;
      throw new Error(`File already exists: ${requestPath}`);
    },
  };
  return { app: { vault }, files, operations, requestPath };
}

test("concurrent sync request writes merge scopes and archive payloads into the newest generation", () => {
  const existing = contract.normalizeSyncRequest({
    requestedAt: 100,
    requestedBy: "replica-a",
    scope: ["calendar", "s3agle-archive", "unsupported"],
    s3agleArchiveRequests: [{
      notePath: "Inbox/Upload.md",
      sourcePaths: ["_attachments/a.png"],
      requestedAt: 100,
    }],
  });
  const incoming = contract.normalizeSyncRequest({
    requestId: "sync-new",
    requestedAt: 200,
    requestedBy: "replica-b",
    scope: ["reminders", "s3agle-archive"],
    s3agleArchiveRequests: [{
      notePath: "Inbox/Upload.md",
      sourcePaths: ["_attachments/b.png", "../unsafe.png"],
      requestedAt: 200,
    }],
  });
  const merged = contract.mergeSyncRequests(existing, incoming);

  assert.equal(merged.requestId, "sync-new");
  assert.deepEqual(merged.scope, ["calendar", "s3agle-archive", "reminders"]);
  assert.deepEqual(merged.s3agleArchiveRequests, [{
    notePath: "Inbox/Upload.md",
    sourcePaths: ["_attachments/a.png", "_attachments/b.png"],
    requestedAt: 200,
  }]);
});

test("acknowledgement consumes only the generation that actually ran", () => {
  const executed = contract.normalizeSyncRequest({
    requestId: "sync-executed",
    requestedAt: 100,
    requestedBy: "replica-a",
    scope: ["calendar"],
  });
  const newer = contract.normalizeSyncRequest({
    requestId: "sync-newer",
    requestedAt: 200,
    requestedBy: "replica-b",
    scope: ["calendar", "reminders"],
  });

  const staleAck = contract.acknowledgeSyncRequest(newer, executed, 300, "controller");
  assert.equal(staleAck.acknowledged, false);
  assert.equal(staleAck.reason, "stale-generation");
  assert.deepEqual(staleAck.request, newer);

  const currentAck = contract.acknowledgeSyncRequest(executed, executed, 300, "controller");
  assert.equal(currentAck.acknowledged, true);
  assert.deepEqual(currentAck.request.scope, []);
  assert.match(currentAck.request.requestId, /^ack-sync-executed$/);
});

test("overlapping poll ticks join one fulfillment promise", async () => {
  let starts = 0;
  let release;
  const active = new Promise((resolve) => { release = resolve; });
  const joined = contract.joinSyncRequestFulfillment(active, async () => {
    starts += 1;
  });
  assert.equal(joined.joined, true);
  assert.equal(joined.promise, active);
  assert.equal(starts, 0);
  release();
  await joined.promise;

  const fresh = contract.joinSyncRequestFulfillment(null, async () => {
    starts += 1;
  });
  assert.equal(fresh.joined, false);
  await fresh.promise;
  assert.equal(starts, 1);
});

test("failed fulfillment never acknowledges and remains retryable", async () => {
  let acknowledgementCalls = 0;
  await assert.rejects(
    contract.executeSyncRequestGeneration(
      async () => { throw new Error("calendar provider failed"); },
      async () => {
        acknowledgementCalls += 1;
        return true;
      },
    ),
    /calendar provider failed/,
  );
  assert.equal(acknowledgementCalls, 0);

  const acknowledged = await contract.executeSyncRequestGeneration(
    async () => {},
    async () => {
      acknowledgementCalls += 1;
      return true;
    },
  );
  assert.equal(acknowledged, true);
  assert.equal(acknowledgementCalls, 1);
});

test("hidden sync-request files survive replica reload without indexed Vault collisions", async () => {
  const existing = contract.normalizeSyncRequest({
    requestId: "sync-existing",
    requestedAt: 100,
    requestedBy: "replica-a",
    scope: ["calendar"],
  });
  const harness = createHiddenRequestHarness(contract.serializeSyncRequest(existing));
  const SyncRequestService = loadSyncRequestService();

  const reloadedReplica = new SyncRequestService(harness.app, ".obsidian/plugins/tps-controller");
  await reloadedReplica.writeRequest(["reminders"]);

  const merged = contract.parseSyncRequestContent(harness.files.get(harness.requestPath));
  assert.deepEqual(merged.scope, ["calendar", "reminders"]);
  assert.equal(harness.operations.indexedLookups, 0);
  assert.equal(harness.operations.indexedCreates, 0);
  assert.equal(harness.operations.adapterWrites, 0);
  assert.equal(harness.operations.adapterProcesses, 1);

  const controllerAfterReload = new SyncRequestService(harness.app, ".obsidian/plugins/tps-controller");
  const pending = await controllerAfterReload.readRequest();
  assert.deepEqual(pending.scope, ["calendar", "reminders"]);
  assert.equal(await controllerAfterReload.acknowledgeRequest(pending), true);
  assert.equal(await controllerAfterReload.readRequest(), null);
  assert.equal(harness.operations.indexedLookups, 0);
  assert.equal(harness.operations.indexedCreates, 0);
});

test("first hidden sync request is created through the adapter", async () => {
  const harness = createHiddenRequestHarness();
  const SyncRequestService = loadSyncRequestService();
  const service = new SyncRequestService(harness.app, ".obsidian/plugins/tps-controller");

  await service.writeRequest(["calendar"]);

  assert.deepEqual(
    contract.parseSyncRequestContent(harness.files.get(harness.requestPath)).scope,
    ["calendar"],
  );
  assert.equal(harness.operations.adapterWrites, 1);
  assert.equal(harness.operations.indexedLookups, 0);
  assert.equal(harness.operations.indexedCreates, 0);
});

test("Controller retries failed fulfillment and atomically preserves newer requests", () => {
  assert.match(mainSource, /syncRequestFulfillmentPromise: Promise<void> \| null/);
  assert.match(mainSource, /joinSyncRequestFulfillment\(this\.syncRequestFulfillmentPromise/);
  assert.match(mainSource, /"fulfill:join-active"/);
  assert.match(mainSource, /this\.fulfillOneSyncRequest\(cause\)\.catch/);
  assert.match(mainSource, /"fulfill:failed"/);
  assert.match(mainSource, /executeSyncRequestGeneration\(async \(\) =>/);
  assert.match(mainSource, /\(\) => this\.syncRequestService\.acknowledgeRequest\(request\)/);
  assert.match(serviceSource, /this\.app\.vault\.adapter\.process\(this\.requestPath/);
  assert.match(serviceSource, /this\.app\.vault\.adapter\.exists\(this\.requestPath/);
  assert.match(serviceSource, /this\.app\.vault\.adapter\.read\(this\.requestPath/);
  assert.match(serviceSource, /this\.app\.vault\.adapter\.write\(this\.requestPath/);
  assert.doesNotMatch(serviceSource, /vault\.getAbstractFileByPath\(/);
  assert.doesNotMatch(serviceSource, /vault\.create\(/);
  assert.match(serviceSource, /mergeSyncRequests\(parseSyncRequestContent\(content\), incoming\)/);
  assert.match(serviceSource, /"ack:stale-generation"/);
  assert.doesNotMatch(serviceSource, /vault\.delete\(/);
  assert.doesNotMatch(serviceSource, /vault\.modify\(/);
  assert.match(mainSource, /this\.requestSync\(\["calendar"\]\)\.catch\(\(error\) =>/);
  assert.match(mainSource, /"startup-write:failed"/);

  const actions = mainSource.indexOf('if (request.scope.includes("calendar"))');
  const acknowledgement = mainSource.indexOf("() => this.syncRequestService.acknowledgeRequest(request)");
  assert.ok(actions >= 0 && acknowledgement > actions, "acknowledgement must happen only after requested actions finish");
});
