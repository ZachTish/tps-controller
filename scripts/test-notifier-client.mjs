import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let clientModule;

async function loadClientModule() {
  if (clientModule) return clientModule;
  const outdir = await mkdtemp(join(tmpdir(), "tps-controller-notifier-client-"));
  const outfile = join(outdir, "notifier-client.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/tps-notifier-client.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  clientModule = await import(pathToFileURL(outfile).href);
  test.after(async () => rm(outdir, { recursive: true, force: true }));
  return clientModule;
}

class FakeWorkspace {
  listeners = new Map();

  on(name, callback) {
    const ref = { name, callback };
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(ref);
    this.listeners.set(name, listeners);
    return ref;
  }

  trigger(name, ...args) {
    for (const ref of Array.from(this.listeners.get(name) || [])) ref.callback(...args);
  }
}

function createV2Api(send) {
  return Object.freeze({
    apiVersion: 2,
    capabilities: Object.freeze({
      structuredReceipts: true,
      redactedDiagnostics: true,
      stableSequenceIds: false,
    }),
    send,
    validate: () => ({ valid: true }),
  });
}

function createDescriptor(api) {
  return Object.freeze({
    protocolVersion: 1,
    providerPluginId: "tps-messager",
    api,
  });
}

async function createClient({ legacyPlugin, plugins, options } = {}) {
  const { TPSNotifierClient } = await loadClientModule();
  const workspace = new FakeWorkspace();
  const refs = [];
  const app = {
    workspace,
    plugins: plugins || {
      getPlugin: (id) => id === "tps-messager" ? legacyPlugin : undefined,
    },
  };
  const client = new TPSNotifierClient(app, "tps-controller-test", options);
  client.start((ref) => refs.push(ref));
  return { client, workspace, refs };
}

test("request handshake resolves a provider that loaded before Controller", async () => {
  const { TPSNotifierClient } = await loadClientModule();
  const workspace = new FakeWorkspace();
  const descriptor = createDescriptor(createV2Api(async ({ body }) => ({
    outcome: "accepted",
    httpStatus: 202,
    providerMessageId: `receipt:${body}`,
  })));
  workspace.on("tps:notifier-api-request", (request) => request.accept(descriptor));
  const client = new TPSNotifierClient({ workspace }, "tps-controller");
  client.start(() => undefined);

  assert.deepEqual(await client.send({ body: "handshake" }), {
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 202,
    providerMessageId: "receipt:handshake",
  });
});

test("available and unavailable events require exact descriptor or API identity", async () => {
  const { client, workspace } = await createClient();
  const descriptorA = createDescriptor(createV2Api(async () => ({
    outcome: "accepted", httpStatus: 200, providerMessageId: "A",
  })));
  const descriptorB = createDescriptor(createV2Api(async () => ({
    outcome: "accepted", httpStatus: 200, providerMessageId: "B",
  })));
  workspace.trigger("tps:notifier-api-available", descriptorA);
  workspace.trigger("tps:notifier-api-available", descriptorB);
  workspace.trigger("tps:notifier-api-unavailable", descriptorA);
  assert.equal((await client.send({ body: "current" })).providerMessageId, "B");
  workspace.trigger("tps:notifier-api-unavailable", descriptorB);
  assert.equal((await client.send({ body: "none" })).state, "not-attempted");
});

test("v2 maps all failure classes without exposing arbitrary provider failures", async () => {
  const cases = [
    [{
      code: "delivery-disabled", attempted: false, deliveryState: "not-attempted", duplicateSafeToRetry: true,
    }, ["not-attempted", "structured-not-attempted", false]],
    [{
      code: "delivery-rejected", attempted: true, deliveryState: "rejected", duplicateSafeToRetry: true, httpStatus: 401,
    }, ["rejected", "structured-rejection", true]],
    [{
      code: "delivery-unconfirmed", attempted: true, deliveryState: "unconfirmed", duplicateSafeToRetry: false,
    }, ["unknown", "unconfirmed", true]],
    [new Error("private provider detail"), ["unknown", "unclassified-v2-failure", "unknown"]],
  ];

  for (const [error, expected] of cases) {
    const { client, workspace } = await createClient();
    workspace.trigger("tps:notifier-api-available", createDescriptor(createV2Api(async () => { throw error; })));
    const result = await client.send({ body: "classified" });
    assert.deepEqual([result.state, result.evidence, result.attempted], expected);
    assert.equal(JSON.stringify(result).includes("private provider detail"), false);
  }
});

test("a malformed v2 success becomes unknown and never falls through to v1", async () => {
  let v1Calls = 0;
  const { client, workspace } = await createClient({
    legacyPlugin: { api: { sendNotification: async () => { v1Calls += 1; } } },
  });
  workspace.trigger("tps:notifier-api-available", createDescriptor(createV2Api(async () => ({
    outcome: "accepted", httpStatus: 200, providerMessageId: "",
  }))));

  const result = await client.send({ body: "one route" });
  assert.equal(result.state, "unknown");
  assert.equal(result.evidence, "malformed-v2-result");
  assert.equal(result.attempted, "unknown");
  assert.equal(v1Calls, 0);
});

test("not-ready clears stale v2 only for later occurrences", async () => {
  let v2Calls = 0;
  let v1Calls = 0;
  const { client, workspace } = await createClient({
    legacyPlugin: { api: { sendNotification: async () => { v1Calls += 1; } } },
  });
  workspace.trigger("tps:notifier-api-available", createDescriptor(createV2Api(async () => {
    v2Calls += 1;
    throw {
      code: "not-ready",
      attempted: false,
      deliveryState: "not-attempted",
      duplicateSafeToRetry: true,
    };
  })));

  assert.equal((await client.send({ body: "current" })).state, "not-attempted");
  assert.deepEqual([v2Calls, v1Calls], [1, 0]);
  assert.equal((await client.send({ body: "later" })).state, "legacy-accepted");
  assert.deepEqual([v2Calls, v1Calls], [1, 1]);
});

test("legacy bridge uses only plugin.api and invokes only one method", async () => {
  let notificationCalls = 0;
  let messageCalls = 0;
  const { client } = await createClient({
    legacyPlugin: {
      api: {
        sendNotification: async () => {
          notificationCalls += 1;
          if (notificationCalls === 2) throw new Error("ambiguous legacy failure");
        },
        sendMessage: async () => { messageCalls += 1; },
      },
      sendNotification: async () => { throw new Error("plugin instance must not be used"); },
    },
  });

  assert.equal((await client.send({ body: "first" })).state, "legacy-accepted");
  const legacyFailure = await client.send({ body: "second" });
  assert.equal(legacyFailure.state, "unknown");
  assert.equal(legacyFailure.attempted, "unknown");
  assert.deepEqual([notificationCalls, messageCalls], [2, 0]);

  let rootCalls = 0;
  const rootOnly = await createClient({
    legacyPlugin: { sendNotification: async () => { rootCalls += 1; } },
  });
  assert.equal((await rootOnly.client.send({ body: "unsupported" })).state, "not-attempted");
  assert.equal(rootCalls, 0);
});

test("throwing descriptors, APIs, and plugin registries fail closed", async () => {
  const throwing = new Proxy({}, { get() { throw new Error("hostile getter"); } });
  const { client, workspace } = await createClient({ plugins: throwing });
  assert.doesNotThrow(() => workspace.trigger("tps:notifier-api-available", throwing));
  assert.deepEqual(await client.send({ body: "fail closed" }), {
    state: "not-attempted",
    transport: "unavailable",
    evidence: "service-unavailable",
    attempted: false,
  });

  const apiProxy = new Proxy({}, { get() { throw new Error("api getter"); } });
  assert.doesNotThrow(() => workspace.trigger("tps:notifier-api-available", {
    protocolVersion: 1,
    providerPluginId: "tps-messager",
    api: apiProxy,
  }));
});

test("disposed clients fail closed without discovery or delivery", async () => {
  let calls = 0;
  const { client, workspace } = await createClient();
  workspace.on("tps:notifier-api-request", (request) => request.accept(createDescriptor(createV2Api(async () => {
    calls += 1;
    return { outcome: "accepted", httpStatus: 200, providerMessageId: "late" };
  }))));
  client.dispose();

  const result = await client.send({ body: "disposed" });
  assert.equal(result.state, "not-attempted");
  assert.equal(result.evidence, "interrupted");
  assert.equal(calls, 0);
});

test("a never-settling provider releases at the consumer deadline without fallback", async () => {
  let legacyCalls = 0;
  const { client, workspace } = await createClient({
    options: { providerDeadlineMs: 5 },
    legacyPlugin: { api: { sendNotification: async () => { legacyCalls += 1; } } },
  });
  workspace.trigger("tps:notifier-api-available", createDescriptor(createV2Api(() => new Promise(() => undefined))));
  assert.deepEqual(await client.send({ body: "bounded" }), {
    state: "unknown",
    transport: "notifier-v2",
    evidence: "consumer-timeout",
    attempted: "unknown",
  });
  assert.equal(legacyCalls, 0);
});
