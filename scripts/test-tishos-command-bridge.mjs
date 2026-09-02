import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const contractBuild = await build({
  entryPoints: [fileURLToPath(new URL("src/services/tishos-command-bridge-contract.ts", root))],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
});
const contract = await import(`data:text/javascript;base64,${Buffer.from(contractBuild.outputFiles[0].text).toString("base64")}`);

const notificationContractBuild = await build({
  entryPoints: [fileURLToPath(new URL("src/services/tishos-native-notification-contract.ts", root))],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
});
const notificationContract = await import(`data:text/javascript;base64,${Buffer.from(notificationContractBuild.outputFiles[0].text).toString("base64")}`);

const serviceBuild = await build({
  entryPoints: [fileURLToPath(new URL("src/services/tishos-command-bridge-service.ts", root))],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
  plugins: [{
    name: "obsidian-test-stub",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({
        loader: "js",
        contents: `
          export class Modal {
            constructor(app) { this.app = app; this.modalEl = { addClass() {} }; this.titleEl = { setText() {} }; this.contentEl = { createEl() { return { setAttr() {}, addEventListener() {} }; }, createDiv() { return { createEl() { return { setAttr() {}, addEventListener() {} }; } }; }, empty() {} }; }
            open() { globalThis.__tishosBridgeModals?.push(this); this.onOpen?.(); }
            close() { this.onClose?.(); }
          }
          export class Notice { constructor(message) { globalThis.__tishosBridgeNotices?.push(String(message)); } }
        `,
      }));
    },
  }],
});
const serviceModule = await import(`data:text/javascript;base64,${Buffer.from(serviceBuild.outputFiles[0].text).toString("base64")}`);

const VAULT = "QA Vault + 100%";
const CLIENT = "11111111-2222-4333-8444-555555555555";
const SECOND_CLIENT = "22222222-3333-4444-8555-666666666666";
const THIRD_CLIENT = "33333333-4444-4555-8666-777777777777";
const REQUEST = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const GENERATED = "2026-08-14T18:30:45.123Z";
const NOW = 1_786_722_645_123;
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = contract.encodeBase64URL(SECRET_BYTES);
const PAIRING_STORAGE_KEY = "tps-controller:command-bridge:pairings:v1";
const REPLAY_STORAGE_KEY = "tps-controller:command-bridge:replay:v1";
const REVOCATION_STORAGE_KEY = "tps-controller:command-bridge:revocations:v1";
const COMMANDS = [
  { id: "editor:toggle-bold", name: "Toggle bold" },
  { id: "tps-global-context-menu:create-task", name: "Create task 🧪" },
];

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
  key(index) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

function createHarness({
  commands = COMMANDS,
  executeResult = true,
  failSecretWrites = false,
  confirmPairing = async () => true,
  confirmLocalRevoke = async () => true,
  sharedSecretValues = null,
  sharedStorage = null,
  vaultName = VAULT,
  notificationScheduleReadiness,
  notificationScheduleProvider,
  completeNotification = async () => true,
  snoozeNotification = async () => true,
} = {}) {
  const files = new Map();
  const directories = new Set();
  const secretValues = sharedSecretValues || new Map();
  const storage = sharedStorage || new MemoryStorage();
  const writes = [];
  const removals = [];
  const executions = [];
  const completions = [];
  const snoozes = [];
  const openedURLs = [];
  const notices = [];
  const statOverrides = new Map();
  let adapterReadCount = 0;
  let unsafeReadAttempts = 0;
  let nextExistsBlock = null;
  const writeBlocks = [];
  let layoutCallback = null;
  let currentCommands = commands;
  let currentExecuteResult = executeResult;
  let throwOnExecute = false;
  let registryAvailable = true;
  let failNextRename = false;
  let failNextSecretClear = false;
  let failNextReturnNavigation = false;
  const storageSaveFailureCountdowns = new Map();
  const swallowedStorageSaveKeys = new Set();
  const removalFailures = new Map();
  const writeFailures = new Map();

  globalThis.__tishosBridgeNotices = notices;
  globalThis.window = {
    localStorage: {
      getItem() { throw new Error("Bridge must use vault-local app storage"); },
      setItem() { throw new Error("Bridge must use vault-local app storage"); },
      removeItem() { throw new Error("Bridge must use vault-local app storage"); },
    },
    setInterval,
    clearInterval,
    open(url) { openedURLs.push(String(url)); },
    location: {
      assign(url) {
        if (failNextReturnNavigation) {
          failNextReturnNavigation = false;
          throw new Error("Injected return navigation failure");
        }
        openedURLs.push(String(url));
      },
    },
  };
  const adapter = {
    async exists(path) {
      if (nextExistsBlock) {
        const block = nextExistsBlock;
        nextExistsBlock = null;
        block.entered();
        await block.promise;
      }
      return files.has(path) || directories.has(path);
    },
    async mkdir(path) { directories.add(path); },
    async write(path, content) {
      const remainingFailures = writeFailures.get(path) || 0;
      if (remainingFailures > 0) {
        if (remainingFailures === 1) writeFailures.delete(path);
        else writeFailures.set(path, remainingFailures - 1);
        throw new Error(`Injected write failure: ${path}`);
      }
      const block = writeBlocks.shift();
      if (block) {
        block.entered();
        await block.promise;
      }
      writes.push({ path, content: String(content) });
      files.set(path, String(content));
    },
    async read(path) {
      adapterReadCount += 1;
      const override = statOverrides.get(path);
      if (override && (override.type !== "file" || override.size > contract.TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES)) {
        unsafeReadAttempts += 1;
        throw new Error(`Unsafe read attempted: ${path}`);
      }
      if (!files.has(path)) throw new Error(`Missing file: ${path}`);
      return files.get(path);
    },
    async stat(path) {
      if (statOverrides.has(path)) return statOverrides.get(path);
      if (files.has(path)) return { type: "file", size: Buffer.byteLength(files.get(path), "utf8"), mtime: 0, ctime: 0 };
      if (directories.has(path)) return { type: "folder", size: 0, mtime: 0, ctime: 0 };
      return null;
    },
    async rename(from, to) {
      if (failNextRename) {
        failNextRename = false;
        throw new Error("Injected rename failure");
      }
      if (!files.has(from)) throw new Error(`Missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`Rename destination already exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
      statOverrides.delete(to);
    },
    async copy(from, to) {
      if (!files.has(from)) throw new Error(`Missing copy source: ${from}`);
      if (files.has(to)) throw new Error(`Copy destination already exists: ${to}`);
      files.set(to, files.get(from));
    },
    async remove(path) {
      const remainingFailures = removalFailures.get(path) || 0;
      if (remainingFailures > 0) {
        if (remainingFailures === 1) removalFailures.delete(path);
        else removalFailures.set(path, remainingFailures - 1);
        throw new Error(`Injected remove failure: ${path}`);
      }
      removals.push(path);
      files.delete(path);
    },
  };
  const app = {
    loadLocalStorage(key) {
      const raw = storage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    },
    saveLocalStorage(key, value) {
      if (swallowedStorageSaveKeys.delete(key)) return;
      const failureCountdown = storageSaveFailureCountdowns.get(key);
      if (failureCountdown === 0) {
        storageSaveFailureCountdowns.delete(key);
        throw new Error(`Injected vault-local storage failure: ${key}`);
      }
      if (failureCountdown !== undefined) storageSaveFailureCountdowns.set(key, failureCountdown - 1);
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    },
    vault: { getName: () => vaultName, adapter },
    workspace: { onLayoutReady(callback) { layoutCallback = callback; } },
    secretStorage: {
      getSecret(id) { return secretValues.get(id) ?? null; },
      setSecret(id, value) {
        if (failSecretWrites) throw new Error("SecretStorage write failed");
        if (failNextSecretClear && value === "") {
          failNextSecretClear = false;
          throw new Error("Injected SecretStorage clear failure");
        }
        secretValues.set(id, String(value));
      },
    },
    commands: {
      listCommands() { return registryAvailable ? currentCommands : null; },
      executeCommandById(id) {
        executions.push(id);
        if (throwOnExecute) throw new Error("command threw");
        return currentExecuteResult;
      },
      findCommand(id) { return currentCommands.find((command) => command.id === id) || null; },
    },
  };
  const service = new serviceModule.TishOSCommandBridgeService(
    app,
    { id: "tps-controller", version: "0.5.0" },
    {
      now: () => NOW,
      confirmPairing,
      confirmLocalRevoke,
      notificationScheduleReadiness,
      notificationScheduleProvider,
      completeNotification: async (value) => {
        completions.push(value);
        return completeNotification(value);
      },
      snoozeNotification: async (value) => {
        snoozes.push(value);
        return snoozeNotification(value);
      },
    },
  );
  return {
    app,
    service,
    files,
    directories,
    secretValues,
    storage,
    writes,
    removals,
    executions,
    completions,
    snoozes,
    openedURLs,
    notices,
    fireLayout() { assert.ok(layoutCallback); layoutCallback(); },
    setCommands(value) { currentCommands = value; },
    setRegistryAvailable(value) { registryAvailable = value; },
    setExecuteResult(value) { currentExecuteResult = value; },
    setThrowOnExecute(value) { throwOnExecute = value; },
    failRenameOnce() { failNextRename = true; },
    failSecretClearOnce() { failNextSecretClear = true; },
    failReturnNavigationOnce() { failNextReturnNavigation = true; },
    failStorageSaveOnce(key) { storageSaveFailureCountdowns.set(key, 0); },
    swallowStorageSaveOnce(key) { swallowedStorageSaveKeys.add(key); },
    failStorageSaveAfter(key, successfulSaves) { storageSaveFailureCountdowns.set(key, successfulSaves); },
    failRemoveOnce(path) { removalFailures.set(path, (removalFailures.get(path) || 0) + 1); },
    failWriteOnce(path) { writeFailures.set(path, (writeFailures.get(path) || 0) + 1); },
    setStat(path, value) { statOverrides.set(path, value); },
    clearStat(path) { statOverrides.delete(path); },
    get adapterReadCount() { return adapterReadCount; },
    get unsafeReadAttempts() { return unsafeReadAttempts; },
    blockNextExists() {
      let release;
      let markEntered;
      const entered = new Promise((resolve) => { markEntered = resolve; });
      const promise = new Promise((resolve) => { release = resolve; });
      nextExistsBlock = { promise, entered: markEntered };
      return { entered, release };
    },
    blockNextWrite() {
      let release;
      let markEntered;
      const entered = new Promise((resolve) => { markEntered = resolve; });
      const promise = new Promise((resolve) => { release = resolve; });
      writeBlocks.push({ promise, entered: markEntered });
      return { entered, release };
    },
  };
}

function pairParams(client = CLIENT, secret = SECRET, overrides = {}) {
  return {
    action: serviceModule.TISHOS_COMMAND_BRIDGE_PAIR_ROUTE,
    vault: VAULT,
    v: "1",
    "expected-vault": VAULT,
    client,
    secret,
    platform: "ios",
    device: "QA iPhone",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within(operation, label, timeoutMS = 500) {
  let timeoutID;
  const timeout = new Promise((_, reject) => {
    timeoutID = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMS} ms`)), timeoutMS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutID);
  }
}

async function signedRunParams(command, client = CLIENT, requestID = REQUEST, issuedAt = String(NOW), secret = SECRET_BYTES) {
  const entry = await contract.commandEntryDigest(command);
  const unsigned = {
    vaultName: VAULT,
    clientID: client,
    commandID: command.id,
    entryDigest: entry,
    requestID,
    issuedAt,
  };
  return {
    action: serviceModule.TISHOS_COMMAND_BRIDGE_RUN_ROUTE,
    vault: VAULT,
    v: "1",
    "expected-vault": VAULT,
    client,
    command: command.id,
    entry,
    request: requestID,
    issuedAt,
    mac: await contract.hmacSHA256Base64URL(secret, contract.canonicalCommandRunRequest(unsigned)),
  };
}

async function signedRevokeParams(client = CLIENT, requestID = REQUEST, issuedAt = String(NOW), secret = SECRET_BYTES) {
  const unsigned = { vaultName: VAULT, clientID: client, requestID, issuedAt };
  return {
    action: serviceModule.TISHOS_COMMAND_BRIDGE_REVOKE_ROUTE,
    vault: VAULT,
    v: "1",
    "expected-vault": VAULT,
    client,
    request: requestID,
    issuedAt,
    mac: await contract.hmacSHA256Base64URL(secret, contract.canonicalCommandRevokeRequest(unsigned)),
  };
}

async function signedNotificationActionParams(
  itemID,
  client = CLIENT,
  requestID = REQUEST,
  issuedAt = String(NOW),
  secret = SECRET_BYTES,
  action = "complete",
  seriesID,
) {
  const unsigned = {
    vaultName: VAULT,
    clientID: client,
    itemID,
    ...(seriesID ? { seriesID } : {}),
    action,
    requestID,
    issuedAt,
  };
  return {
    action: serviceModule.TISHOS_NOTIFICATION_ACTION_ROUTE,
    operation: action,
    vault: VAULT,
    v: seriesID ? "2" : "1",
    "expected-vault": VAULT,
    client,
    item: itemID,
    ...(seriesID ? { series: seriesID } : {}),
    request: requestID,
    issuedAt,
    mac: await contract.hmacSHA256Base64URL(
      secret,
      contract.canonicalNotificationActionRequest(unsigned),
    ),
  };
}

async function pairAndPublish(harness, client = CLIENT, secret = SECRET) {
  const result = await harness.service.handlePairRoute(pairParams(client, secret));
  assert.equal(result.accepted, true);
  harness.service.start();
  harness.fireLayout();
  const refresh = await harness.service.refreshCatalogs("test");
  assert.equal(refresh.failedClients, 0, JSON.stringify(refresh));
  return `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${client}.json`;
}

test("cross-language canonical fixture matches every published digest and MAC", async () => {
  const entries = [];
  for (const command of COMMANDS) entries.push({ ...command, digest: await contract.commandEntryDigest(command) });
  assert.equal(entries[0].digest, "F2Ab3i61lg8BXJsZdKiUUMRcAaIROVSWeMxhnT8W7vY");
  assert.equal(entries[1].digest, "l2s7534xBdgpVu-UxmLtlxZp3F9z1KwwjvDIkCKEOnA");
  const catalog = {
    schemaVersion: 1,
    clientID: CLIENT,
    vaultName: VAULT,
    generatedAt: GENERATED,
    publisher: { id: "tps-controller", version: "0.5.0" },
    commands: entries,
  };
  assert.equal(
    await contract.hmacSHA256Base64URL(SECRET_BYTES, contract.canonicalCommandCatalog(catalog)),
    "4jn2g8q_aK-rK67Abwc14Mb_lE-0IBaUyG8mGJqSHTU",
  );
  const run = {
    vaultName: VAULT,
    clientID: CLIENT,
    commandID: COMMANDS[1].id,
    entryDigest: entries[1].digest,
    requestID: REQUEST,
    issuedAt: String(NOW),
  };
  assert.equal(
    await contract.hmacSHA256Base64URL(SECRET_BYTES, contract.canonicalCommandRunRequest(run)),
    "UJiM6gGSGiiFwDfVDOoMI1G0Px48YxUKnnJYAX3Lfek",
  );
  assert.equal(
    await contract.hmacSHA256Base64URL(SECRET_BYTES, contract.canonicalCommandRevokeRequest({
      vaultName: VAULT,
      clientID: CLIENT,
      requestID: REQUEST,
      issuedAt: String(NOW),
    })),
    "jTgzywTPnOToIbxUlSNcjRb7Z7v5pZfNZHwVFN9ryK8",
  );
  assert.equal(
    await contract.hmacSHA256Base64URL(
      SECRET_BYTES,
      contract.canonicalNotificationActionRequest({
        vaultName: VAULT,
        clientID: CLIENT,
        itemID: "A".repeat(43),
        action: "complete",
        requestID: REQUEST,
        issuedAt: String(NOW),
      }),
    ),
    "KWqZQZS3M6b4xhjXmbVImadmnMLUHOJ1DqfKOGhdgQs",
  );
});

test("command normalization is bounded, byte-sorted, exact-trim, and deterministic for duplicates", async () => {
  const normalized = contract.normalizeCommandRegistry([
    { id: "z:last", name: "Last" },
    { id: "a:first", name: "First" },
    { id: "a:first", name: "First" },
    { id: "same:id", name: "One" },
    { id: "same:id", name: "Two" },
    { id: " bad-id", name: "Invalid ID" },
    { id: "trimmed:name", name: " padded " },
    { id: "control:name", name: "bad\nname" },
  ]);
  assert.deepEqual(normalized.commands, [
    { id: "a:first", name: "First" },
    { id: "z:last", name: "Last" },
  ]);
  assert.equal(normalized.duplicateCount, 2);
  assert.equal(normalized.ambiguousDuplicateCount, 1);
  assert.equal(normalized.invalidCount, 3);
  assert.equal(contract.normalizeUUID(CLIENT), CLIENT);
  assert.equal(contract.normalizeUUID("00000000-0000-0000-0000-000000000000"), "00000000-0000-0000-0000-000000000000");
  assert.equal(contract.normalizeUUID("ffffffff-ffff-ffff-ffff-ffffffffffff"), "ffffffff-ffff-ffff-ffff-ffffffffffff");
  assert.equal(contract.normalizeUUID(REQUEST.toUpperCase()), null);
  assert.equal(contract.isCanonicalIssuedAt("9007199254740991"), true);
  assert.equal(contract.isCanonicalIssuedAt("9007199254740992"), false);
  assert.equal(contract.isValidVaultName("v".repeat(256)), true);
  assert.equal(contract.isValidVaultName("v".repeat(257)), false);
  assert.equal(contract.isValidCommandID("plugin:résumé + 100% & go"), true);
  assert.equal(contract.isValidCommandName("\ud800"), false);
  assert.equal(contract.isValidCommandName("\udc00"), false);
  assert.equal(contract.isValidCommandName("\u200bHidden edge"), false);
  assert.equal(contract.isValidCommandName("Hidden edge\ufeff"), false);
  const javascriptTrimScalars = [
    "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u0020", "\u00a0", "\u1680",
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007",
    "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
  ];
  for (const boundary of [...javascriptTrimScalars, "\u200b"]) {
    assert.equal(contract.isValidCommandID(`${boundary}plugin:command`), false);
    assert.equal(contract.isValidCommandID(`plugin:command${boundary}`), false);
    assert.equal(contract.isValidCommandName(`${boundary}Command`), false);
    assert.equal(contract.isValidCommandName(`Command${boundary}`), false);
  }
  for (const forbidden of ["\u0000", "\u001f", "\u007f", "\u0080", "\u009f", "\u2028", "\u2029"]) {
    assert.equal(contract.isValidCommandID(`plugin${forbidden}command`), false);
    assert.equal(contract.isValidCommandName(`Command${forbidden}name`), false);
  }
  assert.equal(contract.isValidCommandID("plugin\u200bcommand"), true, "ZWSP remains byte-exact when it is internal");
  const invalidUnicode = contract.normalizeCommandRegistry([
    ...COMMANDS,
    { id: "plugin:lone-high", name: "Bad \ud800" },
    { id: "plugin:lone-low", name: "Bad \udc00" },
  ]);
  assert.deepEqual(invalidUnicode.commands, COMMANDS);
  assert.equal(invalidUnicode.invalidCount, 2, "invalid UTF-16 must be excluded instead of poisoning JSON publication");
  assert.notEqual(
    await contract.commandEntryDigest({ id: "unicode:test", name: "Caf\u00e9" }),
    await contract.commandEntryDigest({ id: "unicode:test", name: "Cafe\u0301" }),
    "version 1 authenticates exact UTF-8 and does not normalize Unicode",
  );
});

test("pairing is exact-vault, explicit, SecretStorage-only, and returns after first publication", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const rejected = await harness.service.handlePairRoute(pairParams(CLIENT, SECRET, { surprise: "no" }));
  assert.equal(rejected.reason, "unknown-or-malformed-parameter");
  assert.equal(harness.secretValues.size, 0);
  const result = await harness.service.handlePairRoute(pairParams());
  assert.equal(result.accepted, true);
  assert.equal(harness.secretValues.size, 1);
  assert.equal([...harness.storage.values.values()].some((value) => value.includes(SECRET)), false);
  assert.equal(harness.openedURLs.length, 0);
  harness.service.start();
  harness.fireLayout();
  await harness.service.refreshCatalogs("test");
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
  const path = `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`;
  const catalog = JSON.parse(harness.files.get(path));
  assert.deepEqual(Object.keys(catalog), ["schemaVersion", "clientID", "vaultName", "generatedAt", "publisher", "commands", "mac"]);
  assert.equal(catalog.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(catalog.commands.map(({ id, name }) => ({ id, name })), COMMANDS);
  assert.equal(harness.files.get(path).includes(SECRET), false);
  assert.equal([...harness.files.keys()].some((value) => value.endsWith(".pending")), false);
  const { mac, ...unsigned } = catalog;
  assert.equal(await contract.verifyHmacSHA256Base64URL(SECRET_BYTES, contract.canonicalCommandCatalog(unsigned), mac), true);
  assert.equal([...harness.storage.values.values()].some((value) => value.includes("returnPending")), false);
});

test("iPhone pair return uses direct navigation and remains pending after a failed dispatch", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const result = await harness.service.handlePairRoute(pairParams());
  assert.equal(result.accepted, true);

  harness.failReturnNavigationOnce();
  harness.service.start();
  harness.fireLayout();
  await harness.service.refreshCatalogs("mobile-return-failure");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.openedURLs.length, 0);
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY).includes("returnPending"), true);

  const retried = await harness.service.refreshCatalogs("mobile-return-retry");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.openedURLs.at(-1),
    "tishos://settings?section=command-bridge",
    JSON.stringify({ readyPairings: retried.readyPairings, stored: harness.storage.getItem(PAIRING_STORAGE_KEY) }),
  );
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY).includes("returnPending"), false);
});

test("paired clients receive a signed Controller-rule notification schedule that refreshes semantically", async (t) => {
  let schedule = [{
    title: "Write proposal",
    body: "Starts in 15 minutes",
    fireAt: NOW + 60 * 60 * 1000,
    sourcePath: "Projects/Alpha + 100%.md",
    sourceKey: "Projects/Alpha + 100%.md::task:7",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({
    notificationScheduleProvider: async () => schedule,
  });
  t.after(() => harness.service.stop());
  await pairAndPublish(harness);

  const path = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;
  const published = JSON.parse(harness.files.get(path));
  assert.deepEqual(Object.keys(published), [
    "schemaVersion", "clientID", "vaultName", "generatedAt", "publisher", "items", "mac",
  ]);
  assert.equal(published.clientID, CLIENT);
  assert.equal(published.items.length, 1);
  assert.equal(published.items[0].sourcePath, "Projects/Alpha + 100%.md");
  assert.equal(published.schemaVersion, 2);
  assert.match(published.items[0].seriesID, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    published.items[0].id,
    await contract.sha256Base64URL(notificationContract.canonicalNotificationItem(published.items[0])),
  );
  const { mac, ...unsigned } = published;
  assert.equal(
    await contract.verifyHmacSHA256Base64URL(
      SECRET_BYTES,
      notificationContract.canonicalNotificationSchedule(unsigned),
      mac,
    ),
    true,
  );

  const writesBefore = harness.writes.length;
  await harness.service.refreshCatalogs("unchanged-native-schedule");
  assert.equal(harness.writes.length, writesBefore, "unchanged schedules must not churn synced files");

  schedule = [{ ...schedule[0], fireAt: NOW + 2 * 60 * 60 * 1000 }];
  await harness.service.refreshCatalogs("changed-native-schedule");
  const changed = JSON.parse(harness.files.get(path));
  assert.equal(changed.items[0].fireAt, new Date(NOW + 2 * 60 * 60 * 1000).toISOString());
  assert.notEqual(changed.items[0].id, published.items[0].id);

  schedule = [{
    ...schedule[0],
    fireAt: NOW - 4 * 60 * 1000,
  }, {
    ...schedule[0],
    title: 'Too old',
    fireAt: NOW - 5 * 60 * 1000 - 1,
  }];
  await harness.service.refreshCatalogs("modal-visible-native-schedule");
  const modalVisible = JSON.parse(harness.files.get(path));
  assert.equal(modalVisible.items.length, 1, 'only the bounded late-delivery window is published');
  assert.equal(modalVisible.items[0].fireAt, new Date(NOW - 4 * 60 * 1000).toISOString());
});

test("removing a pending reminder series publishes silently for TishOS's next refresh", async (t) => {
  let schedule = [{
    title: "Repeating task",
    body: "First series",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Queue.md",
    sourceKey: "Daily/Queue.md::task:1",
    reminderId: "scheduled-task",
  }, {
    title: "Keep this task",
    body: "Second series",
    fireAt: NOW + 120_000,
    sourcePath: "Daily/Queue.md",
    sourceKey: "Daily/Queue.md::task:2",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await pairAndPublish(harness);
  harness.openedURLs.splice(0);

  schedule = [schedule[1]];
  const result = await harness.service.refreshCatalogs("task-deleted");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result.nativeNotificationRemovedSeriesPlatforms, ["ios"]);
  assert.deepEqual(
    harness.openedURLs,
    [],
    "passive schedule publication must never foreground the receiving app",
  );

  await harness.service.refreshCatalogs("unchanged-after-invalidation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    harness.openedURLs,
    [],
    "an unchanged follow-up publication must remain passive too",
  );

  schedule = [];
  const emptied = await harness.service.refreshCatalogs("last-task-completed-or-deleted");
  const authoritativeEmpty = JSON.parse(harness.files.get(
    `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`,
  ));
  const { mac, ...unsigned } = authoritativeEmpty;
  assert.deepEqual(authoritativeEmpty.items, []);
  assert.equal(
    await contract.verifyHmacSHA256Base64URL(
      SECRET_BYTES,
      notificationContract.canonicalNotificationSchedule(unsigned),
      mac,
    ),
    true,
    "removing the final series must publish a signed empty replacement, not delete the schedule",
  );
  assert.deepEqual(emptied.nativeNotificationRemovedSeriesPlatforms, ["ios"]);
});

test("advancing one series or aging out a delivered item does not foreground TishOS", async (t) => {
  let schedule = [{
    title: "Repeating task",
    body: "Current occurrence",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Queue.md",
    sourceKey: "Daily/Queue.md::task:1",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await pairAndPublish(harness);
  harness.openedURLs.splice(0);

  schedule = [{ ...schedule[0], fireAt: NOW + 10 * 60_000 }];
  const advanced = await harness.service.refreshCatalogs("repeat-advanced");
  assert.deepEqual(advanced.nativeNotificationRemovedSeriesPlatforms, []);
  assert.deepEqual(harness.openedURLs, []);

  schedule = [{ ...schedule[0], fireAt: NOW - 4 * 60_000 }];
  await harness.service.refreshCatalogs("became-late");
  schedule = [];
  const agedOut = await harness.service.refreshCatalogs("aged-out");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(agedOut.nativeNotificationRemovedSeriesPlatforms, []);
  assert.deepEqual(harness.openedURLs, []);
});

test("equal-time base64url punctuation uses the same raw UTF-8 order for publication and validation", async (t) => {
  const fireAt = NOW + 60 * 60 * 1000;
  const schedule = [{
    title: "Equal 100",
    body: "same time",
    fireAt,
    sourcePath: "Daily/Equal.md",
    sourceKey: "Daily/Equal.md::task:100",
    reminderId: "scheduled-task",
  }, {
    title: "Equal 14",
    body: "same time",
    fireAt,
    sourcePath: "Daily/Equal.md",
    sourceKey: "Daily/Equal.md::task:14",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());

  await pairAndPublish(harness);

  const path = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;
  const published = JSON.parse(harness.files.get(path));
  assert.deepEqual(
    published.items.map((item) => item.id),
    [
      "-4H5SOKKvYAGUYUHNsqFrj_gIMnqmeiUK8SrxLaAIDU",
      "_svxd0S04S3-HWP6Tqnccyb_xbMC2dwQt2jd7WW1c9Y",
    ],
  );
  assert.equal(notificationContract.validateNotificationItems(published.items) !== null, true);
  assert.equal(contract.compareUTF8(published.items[0].id, published.items[1].id) < 0, true);
});

test("schedule projection failure remains pending and reports unavailable until a verified schedule exists", async (t) => {
  let projectionFails = true;
  const schedule = [{
    title: "Projection recovery",
    body: "Controller-owned reminder",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Projection.md",
    sourceKey: "Daily/Projection.md::task:1",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({
    notificationScheduleProvider: async () => {
      if (projectionFails) throw new Error("Injected projection failure");
      return schedule;
    },
  });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  harness.service.start();
  harness.fireLayout();

  const failed = await harness.service.refreshCatalogs("projection-failure");
  assert.equal(failed.unavailableReason, "native-notification-schedule-unavailable");
  assert.equal(failed.failedClients, 1);
  assert.deepEqual(failed.readyPairings, []);
  assert.equal(harness.openedURLs.length, 0);
  assert.equal(
    harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`),
    true,
    "command publication alone must not mark the paired client ready",
  );
  assert.equal(
    harness.files.has(`${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`),
    false,
  );
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY).includes("returnPending"), true);

  projectionFails = false;
  const recovered = await harness.service.refreshCatalogs("projection-recovery");
  assert.equal(recovered.unavailableReason, undefined);
  assert.equal(recovered.failedClients, 0);
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY).includes("returnPending"), false);
});

test("pre-index pairing cannot publish an empty schedule or return until metadata resolves", async (t) => {
  let metadataReady = false;
  let providerCalls = 0;
  const schedule = [{
    title: "Indexed reminder",
    body: "Available after metadata resolution",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Indexed.md",
    sourceKey: "Daily/Indexed.md::task:1",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({
    notificationScheduleReadiness: () => metadataReady
      ? { ready: true }
      : { ready: false, reason: "metadata-index-not-ready" },
    notificationScheduleProvider: async () => {
      providerCalls += 1;
      return schedule;
    },
  });
  t.after(() => harness.service.stop());

  await harness.service.handlePairRoute(pairParams());
  harness.service.start();
  harness.fireLayout();
  const blocked = await harness.service.refreshCatalogs("pre-index");
  const schedulePath = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;

  assert.equal(blocked.unavailableReason, "native-notification-schedule-unavailable");
  assert.deepEqual(blocked.readyPairings, []);
  assert.equal(providerCalls, 0, "projection must not run against an unresolved metadata snapshot");
  assert.equal(harness.files.has(schedulePath), false);
  assert.equal(harness.openedURLs.length, 0, "pairing callback must remain pending");
  assert.deepEqual(
    harness.service.getStatus().clients.map((client) => ({
      state: client.nativeNotificationState,
      count: client.nativeNotificationItemCount,
      reason: client.nativeNotificationReason,
    })),
    [{ state: "pending", count: null, reason: "metadata-index-not-ready" }],
  );

  metadataReady = true;
  const recovered = await harness.service.refreshCatalogs("metadata-resolved");
  assert.equal(recovered.unavailableReason, undefined);
  assert.deepEqual(recovered.readyPairings.map(({ clientID }) => clientID), [CLIENT]);
  assert.equal(providerCalls, 1);
  assert.equal(JSON.parse(harness.files.get(schedulePath)).items.length, 1);
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
  assert.deepEqual(
    harness.service.getStatus().clients.map((client) => ({
      state: client.nativeNotificationState,
      count: client.nativeNotificationItemCount,
      publishedAt: client.nativeNotificationPublishedAt,
      reason: client.nativeNotificationReason,
    })),
    [{
      state: "ready",
      count: 1,
      publishedAt: new Date(NOW).toISOString(),
      reason: null,
    }],
  );

  await harness.service.stop();
  assert.deepEqual(
    harness.service.getStatus().clients.map((client) => ({
      state: client.nativeNotificationState,
      count: client.nativeNotificationItemCount,
      publishedAt: client.nativeNotificationPublishedAt,
      reason: client.nativeNotificationReason,
    })),
    [{ state: "pending", count: null, publishedAt: null, reason: "layout-not-ready" }],
    "stopping must clear the process-local verified schedule status",
  );
});

test("stop clears verified schedule status even when an active publication settles afterward", async () => {
  const providerEntered = deferred();
  const providerRelease = deferred();
  const harness = createHarness({
    notificationScheduleProvider: async () => {
      providerEntered.resolve();
      return providerRelease.promise;
    },
  });

  await harness.service.handlePairRoute(pairParams());
  harness.service.start();
  harness.fireLayout();
  await providerEntered.promise;
  const stopped = harness.service.stop();
  providerRelease.resolve([{
    title: "Settles after stop",
    body: "Must not repopulate audit status",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Stopped.md",
    sourceKey: "Daily/Stopped.md::task:1",
    reminderId: "scheduled-task",
  }]);
  await stopped;

  assert.deepEqual(
    harness.service.getStatus().clients.map((client) => ({
      state: client.nativeNotificationState,
      count: client.nativeNotificationItemCount,
      publishedAt: client.nativeNotificationPublishedAt,
      reason: client.nativeNotificationReason,
    })),
    [{ state: "pending", count: null, publishedAt: null, reason: "layout-not-ready" }],
  );
});

test("per-device schedule write failure cannot report pairing ready and retries independently", async (t) => {
  const schedule = [{
    title: "Write recovery",
    body: "Controller-owned reminder",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Write.md",
    sourceKey: "Daily/Write.md::task:1",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  harness.failWriteOnce(`${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/.${CLIENT}.pending`);
  harness.service.start();
  harness.fireLayout();

  const failed = await harness.service.refreshCatalogs("schedule-write-failure");
  assert.equal(failed.unavailableReason, "native-notification-schedule-unavailable");
  assert.equal(failed.failedClients, 1);
  assert.deepEqual(failed.readyPairings, []);
  assert.equal(harness.openedURLs.length, 0);
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY).includes("returnPending"), true);

  const recovered = await harness.service.refreshCatalogs("schedule-write-recovery");
  assert.equal(recovered.unavailableReason, undefined);
  assert.equal(recovered.failedClients, 0);
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
  assert.equal(
    harness.files.has(`${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`),
    true,
  );
});

test("one failed schedule does not block a different client's verified pairing readiness", async (t) => {
  const secondSecretBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const secondSecret = contract.encodeBase64URL(secondSecretBytes);
  const schedule = [{
    title: "Per-client readiness",
    body: "Controller-owned reminder",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Clients.md",
    sourceKey: "Daily/Clients.md::task:1",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  const first = await harness.service.handlePairRoute(pairParams());
  const second = await harness.service.handlePairRoute(pairParams(
    SECOND_CLIENT,
    secondSecret,
    { platform: "macos", device: "QA Mac" },
  ));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  harness.failWriteOnce(`${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/.${CLIENT}.pending`);
  harness.service.start();
  harness.fireLayout();

  const partial = await harness.service.refreshCatalogs("partial-schedule-write-failure");
  assert.equal(partial.unavailableReason, "native-notification-schedule-unavailable");
  assert.equal(partial.failedClients, 1);
  assert.deepEqual(partial.readyPairings.map(({ clientID }) => clientID), [SECOND_CLIENT]);
  assert.equal(
    harness.files.has(`${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`),
    false,
  );
  assert.equal(
    harness.files.has(`${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${SECOND_CLIENT}.json`),
    true,
  );
});

test("large reminder projections bound cryptographic work before publishing the earliest queue", async (t) => {
  const schedule = Array.from({ length: 7_000 }, (_, index) => ({
    title: `Reminder ${index}`,
    body: "Controller-owned reminder",
    fireAt: NOW + (7_000 - index) * 60_000,
    sourcePath: `Daily/${index}.md`,
    sourceKey: `Daily/${index}.md::task:1`,
    reminderId: "scheduled-task",
  }));
  schedule.push({ ...schedule.at(-1) }, { ...schedule.at(-1) });
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());

  await pairAndPublish(harness);

  const path = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;
  const published = JSON.parse(harness.files.get(path));
  assert.equal(published.items.length, notificationContract.TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS);
  assert.equal(published.items[0].fireAt, new Date(NOW + 60_000).toISOString());
  assert.equal(
    published.items.at(-1).fireAt,
    new Date(NOW + notificationContract.TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS * 60_000).toISOString(),
  );
  assert.equal(new Set(published.items.map((item) => item.id)).size, published.items.length);
});

test("repeat occurrences share one stable series identity while distinct reminders do not", async (t) => {
  const schedule = [{
    title: "Standup",
    body: "First occurrence",
    fireAt: NOW + 60_000,
    sourcePath: "Daily/Standup.md",
    sourceKey: "Daily/Standup.md::task:4",
    reminderId: "scheduled-task",
  }, {
    title: "Standup",
    body: "Second occurrence",
    fireAt: NOW + 6 * 60_000,
    sourcePath: "Daily/Standup.md",
    sourceKey: "Daily/Standup.md::task:4",
    reminderId: "scheduled-task",
  }, {
    title: "Review",
    body: "Different reminder",
    fireAt: NOW + 11 * 60_000,
    sourcePath: "Daily/Standup.md",
    sourceKey: "Daily/Standup.md::task:5",
    reminderId: "scheduled-task",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await pairAndPublish(harness);

  const path = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;
  const published = JSON.parse(harness.files.get(path));
  const audit = JSON.parse(harness.files.get(
    `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.audit.json`,
  ));
  assert.equal(published.items.length, 3);
  assert.equal(published.items[0].seriesID, published.items[1].seriesID);
  assert.notEqual(published.items[0].id, published.items[1].id);
  assert.notEqual(published.items[1].seriesID, published.items[2].seriesID);
  assert.equal(audit.series.length, 2, "the audit keeps exactly one record per series");
  assert.deepEqual(
    audit.series.map((item) => item.seriesID),
    [published.items[0].seriesID, published.items[2].seriesID],
  );
});

test("signed series audit carries original due time and cadence without changing schedule v2", async (t) => {
  const dueAt = NOW - 60 * 60 * 1000;
  const schedule = [{
    title: "Overdue standup",
    body: "Repeat until complete",
    fireAt: NOW + 2 * 60_000,
    dueAt,
    repeatEverySeconds: 120,
    sourcePath: "Calendar/Standup.md",
    sourceKey: "Calendar/Standup.md::event",
    reminderId: "calendar-reminder",
  }];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await pairAndPublish(harness);

  const schedulePath = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;
  const auditPath = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.audit.json`;
  const published = JSON.parse(harness.files.get(schedulePath));
  const audit = JSON.parse(harness.files.get(auditPath));
  assert.equal(published.schemaVersion, 2);
  assert.deepEqual(Object.keys(published.items[0]).sort(), [
    "body", "fireAt", "id", "seriesID", "sourcePath", "title",
  ]);
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.scheduleMAC, published.mac);
  assert.equal(audit.generatedAt, published.generatedAt);
  assert.deepEqual(audit.series, [{
    seriesID: published.items[0].seriesID,
    dueAt: new Date(dueAt).toISOString(),
    repeatEverySeconds: 120,
  }]);
  const { mac, ...unsigned } = audit;
  assert.equal(
    await contract.verifyHmacSHA256Base64URL(
      SECRET_BYTES,
      notificationContract.canonicalNotificationSeriesAudit(unsigned),
      mac,
    ),
    true,
  );
});

test("bounded schedules cover every live reminder series before repeat extras", async (t) => {
  const seriesCount = 70;
  const schedule = Array.from({ length: seriesCount }, (_, seriesIndex) =>
    [60_000, 180_000, 300_000].map((offset, occurrenceIndex) => ({
      title: `Overdue event ${seriesIndex}`,
      body: `Occurrence ${occurrenceIndex}`,
      fireAt: NOW + offset,
      dueAt: NOW - 60 * 60 * 1000,
      repeatEverySeconds: 120,
      sourcePath: `Calendar/Event ${seriesIndex}.md`,
      sourceKey: `Calendar/Event ${seriesIndex}.md::event`,
      reminderId: "calendar-reminder",
    })),
  ).flat();
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());

  await pairAndPublish(harness);

  const path = `${notificationContract.TISHOS_NATIVE_NOTIFICATION_ROOT}/${CLIENT}.json`;
  const published = JSON.parse(harness.files.get(path));
  const countsBySeries = new Map();
  for (const item of published.items) {
    countsBySeries.set(item.seriesID, (countsBySeries.get(item.seriesID) || 0) + 1);
  }
  assert.equal(published.items.length, notificationContract.TISHOS_NATIVE_NOTIFICATION_MAX_ITEMS);
  assert.equal(countsBySeries.size, seriesCount);
  assert.equal([...countsBySeries.values()].filter((count) => count === 2).length, 58);
  assert.equal([...countsBySeries.values()].filter((count) => count === 1).length, 12);
  for (let index = 1; index < published.items.length; index += 1) {
    const previous = published.items[index - 1];
    const current = published.items[index];
    assert.ok(
      previous.fireAt < current.fireAt
        || (previous.fireAt === current.fireAt
          && Buffer.from(previous.id, "utf8").compare(Buffer.from(current.id, "utf8")) <= 0),
      "the fair bounded selection remains in canonical time/UTF-8 ID order",
    );
  }
});

test("signed notification completion re-resolves one current Controller item and consumes replay", async (t) => {
  const completionTarget = { targetKind: "task", taskLine: 7 };
  const schedule = [{
    title: "Write proposal",
    body: "Starts in 15 minutes",
    fireAt: NOW + 60 * 60 * 1000,
    sourcePath: "Projects/Alpha.md",
    sourceKey: "Projects/Alpha.md::task:7",
    reminderId: "scheduled-task",
    completionTarget,
  }];
  const harness = createHarness({
    notificationScheduleProvider: async () => schedule,
  });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const item = (await harness.service.buildNativeNotificationItemsForTesting?.(schedule))?.[0]
    ?? {
      id: await contract.sha256Base64URL(notificationContract.canonicalNotificationItem({
        id: "",
        seriesID: await contract.sha256Base64URL(notificationContract.canonicalNotificationSeries(
          schedule[0].sourceKey,
          schedule[0].reminderId,
        )),
        title: schedule[0].title,
        body: schedule[0].body,
        fireAt: new Date(schedule[0].fireAt).toISOString(),
        sourcePath: schedule[0].sourcePath,
      })),
    };
  const params = await signedNotificationActionParams(item.id);
  const result = await harness.service.handleNotificationActionRoute(params);
  assert.equal(result.accepted, true);
  assert.equal(result.executed, true);
  assert.equal(harness.completions.length, 1);
  assert.equal(harness.completions[0].completionTarget, completionTarget);
  assert.equal((await harness.service.handleNotificationActionRoute(params)).reason, "replay");
  assert.equal(harness.completions.length, 1);
});

test("signed notification snooze re-resolves one current Controller item and consumes replay", async (t) => {
  const completionTarget = { targetKind: "task", taskLine: 9 };
  const scheduled = {
    title: "Review proposal",
    body: "Starts in 20 minutes",
    fireAt: NOW + 75 * 60 * 1000,
    sourcePath: "Projects/Alpha.md",
    sourceKey: "Projects/Alpha.md::task:9",
    reminderId: "scheduled-task",
    completionTarget,
  };
  const schedule = [scheduled];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const seriesID = await contract.sha256Base64URL(
    notificationContract.canonicalNotificationSeries(scheduled.sourceKey, scheduled.reminderId),
  );
  const itemID = await contract.sha256Base64URL(
    notificationContract.canonicalNotificationItem({
      id: "",
      seriesID,
      title: scheduled.title,
      body: scheduled.body,
      fireAt: new Date(scheduled.fireAt).toISOString(),
      sourcePath: scheduled.sourcePath,
    }),
  );
  const params = await signedNotificationActionParams(
    itemID,
    CLIENT,
    "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb",
    String(NOW),
    SECRET_BYTES,
    "snooze",
  );
  const result = await harness.service.handleNotificationActionRoute(params);
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "snoozed");
  assert.equal(result.executed, true);
  assert.equal(harness.snoozes.length, 1);
  assert.equal(harness.snoozes[0].completionTarget, completionTarget);
  assert.equal((await harness.service.handleNotificationActionRoute(params)).reason, "replay");
  assert.equal(harness.snoozes.length, 1);

  const unsupported = { ...params, operation: "dismiss" };
  assert.equal(
    (await harness.service.handleNotificationActionRoute(unsupported)).reason,
    "route-or-version",
  );
});

test("signed series action survives a fired repeat occurrence moving forward", async (t) => {
  const completionTarget = { targetKind: "task", taskLine: 9 };
  const fired = {
    title: "Review proposal",
    body: "Repeat until complete",
    fireAt: NOW + 60_000,
    sourcePath: "Projects/Alpha.md",
    sourceKey: "Projects/Alpha.md::task:9",
    reminderId: "scheduled-task",
    completionTarget,
  };
  let schedule = [fired];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const seriesID = await contract.sha256Base64URL(
    notificationContract.canonicalNotificationSeries(fired.sourceKey, fired.reminderId),
  );
  const firedItemID = await contract.sha256Base64URL(
    notificationContract.canonicalNotificationItem({
      id: "",
      seriesID,
      title: fired.title,
      body: fired.body,
      fireAt: new Date(fired.fireAt).toISOString(),
      sourcePath: fired.sourcePath,
    }),
  );
  const nextFireAt = fired.fireAt + 5 * 60_000;
  schedule = [
    { ...fired, fireAt: nextFireAt + 5 * 60_000 },
    { ...fired, fireAt: nextFireAt },
  ];

  const exactOnly = await signedNotificationActionParams(
    firedItemID,
    CLIENT,
    "11111111-eeee-4fff-8aaa-bbbbbbbbbbbb",
    String(NOW),
    SECRET_BYTES,
    "snooze",
  );
  assert.equal(
    (await harness.service.handleNotificationActionRoute(exactOnly)).reason,
    "item-unavailable",
  );

  const durable = await signedNotificationActionParams(
    firedItemID,
    CLIENT,
    "22222222-eeee-4fff-8aaa-bbbbbbbbbbbb",
    String(NOW),
    SECRET_BYTES,
    "snooze",
    seriesID,
  );
  const result = await harness.service.handleNotificationActionRoute(durable);
  assert.equal(result.reason, "snoozed");
  assert.equal(result.executed, true);
  assert.equal(harness.snoozes.length, 1);
  assert.equal(harness.snoozes[0].completionTarget, completionTarget);
  assert.equal(harness.snoozes[0].fireAt, nextFireAt);
});

test("notification completion fails closed for stale, ambiguous, unsigned, or external items", async (t) => {
  const current = {
    title: "Duplicate",
    body: "Same occurrence",
    fireAt: NOW + 60_000,
    sourcePath: "Projects/Duplicate.md",
    sourceKey: "Projects/Duplicate.md::task:1",
    reminderId: "scheduled-task",
    completionTarget: { targetKind: "task", taskLine: 1 },
  };
  let schedule = [current];
  const harness = createHarness({ notificationScheduleProvider: async () => schedule });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const unsignedItem = {
    id: "",
    seriesID: await contract.sha256Base64URL(notificationContract.canonicalNotificationSeries(
      current.sourceKey,
      current.reminderId,
    )),
    title: current.title,
    body: current.body,
    fireAt: new Date(current.fireAt).toISOString(),
    sourcePath: current.sourcePath,
  };
  const itemID = await contract.sha256Base64URL(
    notificationContract.canonicalNotificationItem(unsignedItem),
  );
  const badMac = await signedNotificationActionParams(itemID);
  badMac.mac = `${badMac.mac.slice(0, -1)}${badMac.mac.endsWith("A") ? "B" : "A"}`;
  assert.equal((await harness.service.handleNotificationActionRoute(badMac)).reason, "bad-mac");

  schedule = [];
  assert.equal((await harness.service.handleNotificationActionRoute(
    await signedNotificationActionParams(itemID, CLIENT, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
  )).reason, "item-unavailable");

  schedule = [current, { ...current, completionTarget: { targetKind: "task", taskLine: 2 } }];
  assert.equal((await harness.service.handleNotificationActionRoute(
    await signedNotificationActionParams(itemID, CLIENT, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
  )).reason, "item-ambiguous");

  schedule = [{ ...current, completionTarget: undefined }];
  assert.equal((await harness.service.handleNotificationActionRoute(
    await signedNotificationActionParams(itemID, CLIENT, "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"),
  )).reason, "item-unavailable");
  assert.equal(harness.completions.length, 0);
});

test("pair route rejects cancel, wrong stripped-native vault, uppercase UUID, and malformed secret without storage", async () => {
  const cancelled = createHarness({ confirmPairing: async () => false });
  assert.equal((await cancelled.service.handlePairRoute(pairParams())).reason, "user-cancelled");
  assert.equal(cancelled.secretValues.size, 0);
  assert.equal(cancelled.storage.length, 0);

  const harness = createHarness();
  const wrongVault = pairParams();
  delete wrongVault.vault;
  wrongVault["expected-vault"] = "Another Vault";
  assert.equal((await harness.service.handlePairRoute(wrongVault)).reason, "wrong-vault");
  assert.equal((await harness.service.handlePairRoute(pairParams(REQUEST.toUpperCase()))).reason, "invalid-client");
  assert.equal((await harness.service.handlePairRoute(pairParams(CLIENT, "not-a-256-bit-secret"))).reason, "invalid-secret");
  assert.equal((await harness.service.handlePairRoute(pairParams(CLIENT, SECRET, { unknown: "value" }))).reason, "unknown-or-malformed-parameter");
  assert.equal(harness.secretValues.size, 0);
  assert.equal(harness.storage.length, 0);

  const throwingConfirmation = createHarness({ confirmPairing: async () => { throw new Error("confirmation failed"); } });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await throwingConfirmation.service.handlePairRoute(pairParams())).reason, "confirmation-failure");
  } finally {
    console.error = originalError;
  }
  assert.equal(throwingConfirmation.secretValues.size, 0);
  assert.equal(throwingConfirmation.storage.length, 0);
});

test("capitalization-only local vault identity pairs, publishes, runs, acts, and revokes", async (t) => {
  const controllerVaultName = "QA VAULT + 100%";
  const harness = createHarness({ vaultName: controllerVaultName });
  t.after(() => harness.service.stop());

  assert.equal(contract.portableVaultNamesMatch(VAULT, controllerVaultName), true);
  assert.equal(
    contract.portableVaultNamesMatch("Cafe\u0301 Vault", "Caf\u00e9 Vault"),
    true,
  );
  assert.equal(contract.portableVaultNamesMatch(VAULT, "Another Vault"), false);

  assert.equal((await harness.service.handlePairRoute(pairParams())).reason, "paired");
  harness.service.start();
  harness.fireLayout();
  await harness.service.refreshCatalogs("portable-vault-name");

  const catalog = JSON.parse(harness.files.get(
    `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`,
  ));
  assert.equal(catalog.vaultName, controllerVaultName);

  const run = await harness.service.handleRunRoute(await signedRunParams(COMMANDS[0]));
  assert.equal(run.reason, "executed");

  const action = await harness.service.handleNotificationActionRoute(
    await signedNotificationActionParams(
      "A".repeat(43),
      CLIENT,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ),
  );
  assert.equal(action.reason, "provider-unavailable");

  const revoke = await harness.service.handleRevokeRoute(
    await signedRevokeParams(
      CLIENT,
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    ),
  );
  assert.equal(revoke.reason, "revoked");
});

test("default pairing confirmation waits for Obsidian's modal handoff and settles on close", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  globalThis.__tishosBridgeModals = [];
  const service = new serviceModule.TishOSCommandBridgeService(
    harness.app,
    { id: "tps-controller", version: "0.5.0" },
    { now: () => NOW, confirmLocalRevoke: async () => true },
  );
  t.after(() => service.stop());

  const pending = service.handlePairRoute(pairParams());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(globalThis.__tishosBridgeModals.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(globalThis.__tishosBridgeModals.length, 1);
  globalThis.__tishosBridgeModals[0].close();

  assert.equal((await pending).reason, "user-cancelled");
  assert.equal(harness.secretValues.size, 0);
  assert.equal(harness.storage.length, 0);
  delete globalThis.__tishosBridgeModals;
});

test("pair return waits for its own post-snapshot catalog refresh", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  harness.service.start();
  const block = harness.blockNextExists();
  harness.fireLayout();
  await block.entered;

  const secondSecretBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const secondSecret = contract.encodeBase64URL(secondSecretBytes);
  let secondPairSettled = false;
  const secondPair = harness.service
    .handlePairRoute(pairParams(SECOND_CLIENT, secondSecret, { platform: "macos", device: "QA Mac" }))
    .finally(() => { secondPairSettled = true; });
  await Promise.resolve();
  assert.equal(secondPairSettled, false);
  assert.equal(harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${SECOND_CLIENT}.json`), false);

  block.release();
  assert.equal((await secondPair).accepted, true);
  assert.equal(
    harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${SECOND_CLIENT}.json`),
    true,
    JSON.stringify({ writes: harness.writes.map(({ path }) => path), status: harness.service.getStatus() }),
  );
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
});

test("same-client secret rotation cannot reuse stale catalog readiness", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const previousSecretID = JSON.parse(harness.storage.getItem(PAIRING_STORAGE_KEY)).clients[0].secretID;
  const callbackCount = harness.openedURLs.length;
  const rotatedSecretBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const rotatedSecret = contract.encodeBase64URL(rotatedSecretBytes);
  harness.setCommands([...COMMANDS, { id: "plugin:rotated", name: "Rotated registry" }]);

  const staleWrite = harness.blockNextWrite();
  const freshWrite = harness.blockNextWrite();
  const oldRefresh = harness.service.refreshCatalogs("pre-rotation-snapshot");
  await staleWrite.entered;
  let pairSettled = false;
  const rotatedPair = harness.service.handlePairRoute(pairParams(CLIENT, rotatedSecret, {
    platform: "ipados",
    device: "Rotated iPad",
  })).finally(() => { pairSettled = true; });
  await Promise.resolve();
  assert.equal(pairSettled, false);

  staleWrite.release();
  await freshWrite.entered;
  assert.equal(pairSettled, false);
  assert.equal(harness.openedURLs.length, callbackCount, "the old pairing generation must not trigger the callback");
  const staleCatalog = JSON.parse(harness.files.get(path));
  const { mac: staleMac, ...staleUnsigned } = staleCatalog;
  assert.equal(await contract.verifyHmacSHA256Base64URL(SECRET_BYTES, contract.canonicalCommandCatalog(staleUnsigned), staleMac), true);
  assert.equal(await contract.verifyHmacSHA256Base64URL(rotatedSecretBytes, contract.canonicalCommandCatalog(staleUnsigned), staleMac), false);

  freshWrite.release();
  await oldRefresh;
  assert.equal((await rotatedPair).accepted, true);
  assert.equal(harness.openedURLs.length, callbackCount + 1);
  const rotatedPairing = JSON.parse(harness.storage.getItem(PAIRING_STORAGE_KEY)).clients[0];
  assert.notEqual(rotatedPairing.secretID, previousSecretID);
  assert.equal(harness.secretValues.get(previousSecretID), "");
  const freshCatalog = JSON.parse(harness.files.get(path));
  const { mac: freshMac, ...freshUnsigned } = freshCatalog;
  assert.equal(await contract.verifyHmacSHA256Base64URL(rotatedSecretBytes, contract.canonicalCommandCatalog(freshUnsigned), freshMac), true);
});

test("pair return waits through an unavailable registry until its exact catalog verifies", async (t) => {
  const harness = createHarness();
  let recreated = null;
  t.after(() => {
    harness.service.stop();
    recreated?.stop();
  });
  harness.setRegistryAvailable(false);
  await harness.service.handlePairRoute(pairParams());
  assert.equal(harness.openedURLs.length, 0);
  harness.service.start();
  harness.fireLayout();
  await harness.service.refreshCatalogs("unavailable-pair-attempt");
  assert.equal(harness.openedURLs.length, 0);
  assert.equal(harness.files.size, 0);
  assert.equal([...harness.storage.values.values()].some((value) => value.includes("returnPending")), true);
  harness.service.stop();
  harness.setRegistryAvailable(true);
  recreated = new serviceModule.TishOSCommandBridgeService(harness.app, { id: "tps-controller", version: "0.5.0" }, {
    now: () => NOW,
    confirmPairing: async () => true,
    confirmLocalRevoke: async () => true,
  });
  recreated.start();
  harness.fireLayout();
  const recovered = await recreated.refreshCatalogs("available-pair-retry-after-reload");
  assert.equal(recovered.publishedClients, 1);
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
  assert.equal([...harness.storage.values.values()].some((value) => value.includes("returnPending")), false);
});

test("unexpected registry failures settle safely and defer the pairing callback", async (t) => {
  const throwingCommand = new Proxy({}, {
    get() { throw new Error("unexpected registry getter failure"); },
  });
  const harness = createHarness({ commands: [throwingCommand] });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const originalError = console.error;
  console.error = () => {};
  try {
    harness.service.start();
    harness.fireLayout();
    const result = await harness.service.refreshCatalogs("unexpected-registry-failure");
    assert.equal(result.unavailableReason, "refresh-failure");
  } finally {
    console.error = originalError;
  }
  assert.equal(harness.openedURLs.length, 0);
  assert.equal(harness.files.size, 0);
  harness.setCommands(COMMANDS);
  await harness.service.refreshCatalogs("unexpected-registry-recovery");
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
});

test("pair callback waits through a failed staged replacement until the exact target verifies", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  harness.failRenameOnce();
  harness.service.start();
  harness.fireLayout();
  const failed = await harness.service.refreshCatalogs("injected-first-publish-failure");
  const path = `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`;
  assert.equal(failed.failedClients, 1);
  assert.equal(harness.files.has(path), false);
  assert.equal([...harness.files.keys()].some((value) => value.endsWith(".pending")), false);
  assert.equal(harness.openedURLs.length, 0);

  const recovered = await harness.service.refreshCatalogs("injected-first-publish-retry");
  assert.equal(recovered.publishedClients, 1);
  assert.equal(harness.files.has(path), true);
  assert.equal(harness.openedURLs.at(-1), "tishos://settings?section=command-bridge");
});

test("refresh avoids stable writes but repairs missing, malformed, and bad-MAC catalogs", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const firstWrites = harness.writes.length;
  const unchanged = await harness.service.refreshCatalogs("stable");
  assert.equal(unchanged.unchangedClients, 1);
  assert.equal(harness.writes.length, firstWrites);

  harness.files.set(path, "{\"schemaVersion\":1}\n");
  const malformed = await harness.service.refreshCatalogs("repair-malformed");
  assert.equal(malformed.publishedClients, 1);
  assert.equal(harness.writes.length, firstWrites + 1);

  const tampered = JSON.parse(harness.files.get(path));
  tampered.commands[0].name = "Harmless-looking replacement";
  harness.files.set(path, `${JSON.stringify(tampered)}\n`);
  const repaired = await harness.service.refreshCatalogs("repair-mac");
  assert.equal(repaired.publishedClients, 1);
  assert.equal(JSON.parse(harness.files.get(path)).commands[0].name, COMMANDS[0].name);

  harness.files.delete(path);
  const missing = await harness.service.refreshCatalogs("repair-missing");
  assert.equal(missing.publishedClients, 1);
  assert.equal(harness.files.has(path), true);

  harness.setStat(path, { type: "file", size: contract.TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES + 1, mtime: 0, ctime: 0 });
  const oversizedStat = await harness.service.refreshCatalogs("repair-oversized-stat");
  assert.equal(oversizedStat.publishedClients, 1);
  assert.equal(harness.unsafeReadAttempts, 0);
  harness.clearStat(path);

  harness.setStat(path, { type: "folder", size: 0, mtime: 0, ctime: 0 });
  const folderStat = await harness.service.refreshCatalogs("repair-non-file-stat");
  assert.equal(folderStat.publishedClients, 1);
  assert.equal(harness.unsafeReadAttempts, 0);
  harness.clearStat(path);
});

test("registry absence and hard bounds preserve the last valid catalog", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const original = harness.files.get(path);
  const writeCount = harness.writes.length;

  harness.setRegistryAvailable(false);
  assert.equal((await harness.service.refreshCatalogs("missing-seam")).unavailableReason, "command-registry-unavailable");
  assert.equal(harness.files.get(path), original);
  assert.equal(harness.writes.length, writeCount);

  harness.setRegistryAvailable(true);
  harness.setCommands(Array.from({ length: 4097 }, (_, index) => ({ id: `plugin:command-${index}`, name: `Command ${index}` })));
  assert.equal((await harness.service.refreshCatalogs("too-many")).unavailableReason, "command-limit");
  assert.equal(harness.files.get(path), original);
  assert.equal(harness.writes.length, writeCount);

  const longName = "N".repeat(256);
  harness.setCommands(Array.from({ length: 4096 }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    return { id: `x${"a".repeat(250)}${suffix}`, name: longName };
  }));
  const oversized = await harness.service.refreshCatalogs("oversized-file");
  assert.equal(oversized.failedClients, 1);
  assert.equal(harness.files.get(path), original);
});

test("a staged replacement failure preserves the previous verified catalog", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const original = harness.files.get(path);
  harness.setCommands([...COMMANDS, { id: "plugin:new-command", name: "New command" }]);
  harness.failRenameOnce();
  const failed = await harness.service.refreshCatalogs("injected-replacement-failure");
  assert.equal(failed.failedClients, 1);
  assert.equal(harness.files.get(path), original);
  assert.equal([...harness.files.keys()].some((value) => value.endsWith(".pending")), false);

  const recovered = await harness.service.refreshCatalogs("injected-replacement-retry");
  assert.equal(recovered.publishedClients, 1);
  assert.notEqual(harness.files.get(path), original);
});

test("stale catalog staging and backup crash points recover without overwrite-rename assumptions", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const original = harness.files.get(path);
  const pending = `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/.${CLIENT}.pending`;
  const backup = `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/.${CLIENT}.backup`;

  harness.files.set(pending, "partial stage");
  harness.files.set(backup, original);
  assert.equal((await harness.service.refreshCatalogs("recover-valid-target")).unchangedClients, 1);
  assert.equal(harness.files.get(path), original);
  assert.equal(harness.files.has(pending), false);
  assert.equal(harness.files.has(backup), false);

  harness.files.delete(path);
  harness.files.set(backup, original);
  assert.equal((await harness.service.refreshCatalogs("recover-missing-target")).unchangedClients, 1);
  assert.equal(harness.files.get(path), original);
  assert.equal(harness.files.has(backup), false);

  harness.files.set(path, "{}\n");
  harness.files.set(backup, original);
  assert.equal((await harness.service.refreshCatalogs("recover-invalid-target")).unchangedClients, 1);
  assert.equal(harness.files.get(path), original);
  assert.equal(harness.files.has(backup), false);
});

test("run route verifies MAC, freshness, replay, and current name digest before one execution", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const params = await signedRunParams(COMMANDS[1]);
  const first = await harness.service.handleRunRoute(params);
  assert.equal(first.accepted, true);
  assert.equal(first.executed, true);
  assert.deepEqual(harness.executions, [COMMANDS[1].id]);
  assert.equal((await harness.service.handleRunRoute(params)).reason, "replay");
  assert.deepEqual(harness.executions, [COMMANDS[1].id]);

  const recreated = new serviceModule.TishOSCommandBridgeService(harness.app, { id: "tps-controller", version: "0.5.0" }, {
    now: () => NOW,
    confirmPairing: async () => true,
    confirmLocalRevoke: async () => true,
  });
  assert.equal((await recreated.handleRunRoute(params)).reason, "replay");

  const staleRequest = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const stale = await signedRunParams(COMMANDS[0], CLIENT, staleRequest, String(NOW - contract.TISHOS_COMMAND_BRIDGE_MAX_REQUEST_AGE_MS - 1));
  assert.equal((await harness.service.handleRunRoute(stale)).reason, "stale-issued-at");
  const future = await signedRunParams(COMMANDS[0], CLIENT, staleRequest, String(NOW + contract.TISHOS_COMMAND_BRIDGE_MAX_FUTURE_SKEW_MS + 1));
  assert.equal((await harness.service.handleRunRoute(future)).reason, "stale-issued-at");

  const badMac = await signedRunParams(COMMANDS[0], CLIENT, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
  badMac.mac = `${badMac.mac.slice(0, -1)}${badMac.mac.endsWith("A") ? "B" : "A"}`;
  assert.equal((await harness.service.handleRunRoute(badMac)).reason, "bad-mac");
  const malformedMac = await signedRunParams(COMMANDS[0], CLIENT, "abababab-cdcd-4efe-8aaa-bcbcbcbcbcbc");
  malformedMac.mac = "bad";
  assert.equal((await harness.service.handleRunRoute(malformedMac)).reason, "invalid-mac");
  const wrongVault = await signedRunParams(COMMANDS[0], CLIENT, "acacacac-dede-4faf-8bbb-cdcdcdcdcdcd");
  delete wrongVault.vault;
  wrongVault["expected-vault"] = "Another Vault";
  assert.equal((await harness.service.handleRunRoute(wrongVault)).reason, "wrong-vault");

  harness.setCommands([{ ...COMMANDS[0], name: "Renamed command" }, COMMANDS[1]]);
  const staleEntry = await signedRunParams(COMMANDS[0], CLIENT, "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa");
  assert.equal((await harness.service.handleRunRoute(staleEntry)).reason, "stale-entry");
  assert.equal(harness.executions.length, 1);
});

test("unusual command IDs survive catalog JSON, URL decoding, HMAC verification, and exact execution", async (t) => {
  const unusual = { id: "plugin command+%/&🧪", name: "Run unusual command 🧪" };
  const harness = createHarness({
    commands: [
      { id: "plugin:invalid-unicode", name: "Invalid \ud800 command" },
      unusual,
    ],
  });
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const catalog = JSON.parse(harness.files.get(path));
  assert.deepEqual(catalog.commands.map(({ id, name }) => ({ id, name })), [unusual]);

  const signed = await signedRunParams(unusual);
  const encodedQuery = new URLSearchParams(signed).toString();
  const decoded = Object.fromEntries(new URLSearchParams(encodedQuery));
  assert.equal(decoded.command, unusual.id);
  const result = await harness.service.handleRunRoute(decoded);
  assert.equal(result.accepted, true);
  assert.equal(result.executed, true);
  assert.deepEqual(harness.executions, [unusual.id]);
});

test("false and throwing command executions are consumed without retry", async (t) => {
  const harness = createHarness({ executeResult: false });
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const falseParams = await signedRunParams(COMMANDS[0], CLIENT, "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb");
  const falseResult = await harness.service.handleRunRoute(falseParams);
  assert.equal(falseResult.accepted, true);
  assert.equal(falseResult.executed, false);
  assert.equal((await harness.service.handleRunRoute(falseParams)).reason, "replay");
  assert.equal(harness.executions.length, 1);

  harness.setExecuteResult(true);
  harness.setThrowOnExecute(true);
  const throwParams = await signedRunParams(COMMANDS[1], CLIENT, "eeeeeeee-ffff-4aaa-8bbb-cccccccccccc");
  const throwResult = await harness.service.handleRunRoute(throwParams);
  assert.equal(throwResult.accepted, true);
  assert.equal(throwResult.executed, false);
  assert.equal((await harness.service.handleRunRoute(throwParams)).reason, "replay");
  assert.equal(harness.executions.length, 2);
});

test("bounded replay storage fails closed instead of evicting a still-fresh request", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const entries = Array.from({ length: 2048 }, (_, index) => ({
    clientID: CLIENT,
    requestID: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    seenAt: NOW,
  }));
  harness.storage.setItem(
    "tps-controller:command-bridge:replay:v1",
    JSON.stringify({ schemaVersion: 1, vaultName: VAULT, entries }),
  );
  const result = await harness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "12121212-3434-4567-8abc-defdefdefdef"),
  );
  assert.equal(result.reason, "replay-capacity");
  assert.equal(harness.executions.length, 0);
  assert.equal(JSON.parse(harness.storage.getItem("tps-controller:command-bridge:replay:v1")).entries.length, 2048);
});

test("clients remain independent and signed revoke clears only its authority, replay state, and catalog", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const secondSecretBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const secondSecret = contract.encodeBase64URL(secondSecretBytes);
  await harness.service.handlePairRoute(pairParams());
  await harness.service.handlePairRoute(pairParams(SECOND_CLIENT, secondSecret, { platform: "macos", device: "QA Mac" }));
  harness.service.start();
  harness.fireLayout();
  await harness.service.refreshCatalogs("two-clients");
  assert.equal(harness.service.getStatus().clients.length, 2);
  assert.equal(harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`), true);
  assert.equal(harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${SECOND_CLIENT}.json`), true);

  const malformed = await signedRevokeParams();
  malformed.mac = "bad";
  assert.equal((await harness.service.handleRevokeRoute(malformed)).reason, "invalid-mac");
  const stale = await signedRevokeParams(CLIENT, "fafafafa-bbbb-4ccc-8ddd-eeeeeeeeeeee", String(NOW - contract.TISHOS_COMMAND_BRIDGE_MAX_REQUEST_AGE_MS - 1));
  assert.equal((await harness.service.handleRevokeRoute(stale)).reason, "stale-issued-at");
  const future = await signedRevokeParams(CLIENT, "fbfbfbfb-cccc-4ddd-8eee-ffffffffffff", String(NOW + contract.TISHOS_COMMAND_BRIDGE_MAX_FUTURE_SKEW_MS + 1));
  assert.equal((await harness.service.handleRevokeRoute(future)).reason, "stale-issued-at");

  const revoke = await harness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(revoke.accepted, true);
  assert.equal(harness.service.getStatus().clients.length, 1);
  assert.equal(harness.service.getStatus().clients[0].clientID, SECOND_CLIENT);
  assert.equal(harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`), false);
  assert.equal(harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${SECOND_CLIENT}.json`), true);
  assert.equal([...harness.secretValues.values()].includes(SECRET), false);
  assert.equal((await harness.service.handleRunRoute(await signedRunParams(COMMANDS[0]))).reason, "unknown-client");
});

test("same-named vaults use independent App-local authority even with shared global SecretStorage", async (t) => {
  const sharedSecretValues = new Map();
  const first = createHarness({ sharedSecretValues });
  const firstPath = await pairAndPublish(first);
  const second = createHarness({ sharedSecretValues });
  const secondPath = await pairAndPublish(second);
  t.after(() => {
    first.service.stop();
    second.service.stop();
  });

  assert.equal(first.service.getStatus().clients.length, 1);
  assert.equal(second.service.getStatus().clients.length, 1);
  const firstPairing = JSON.parse(first.storage.getItem("tps-controller:command-bridge:pairings:v1")).clients[0];
  const secondPairing = JSON.parse(second.storage.getItem("tps-controller:command-bridge:pairings:v1")).clients[0];
  assert.notEqual(firstPairing.secretID, secondPairing.secretID, "global SecretStorage identifiers must not collide");

  assert.equal((await first.service.handleRevokeRoute(await signedRevokeParams())).accepted, true);
  assert.equal(first.service.getStatus().clients.length, 0);
  assert.equal(first.files.has(firstPath), false);
  assert.equal(second.service.getStatus().clients.length, 1);
  assert.equal(second.files.has(secondPath), true);
  assert.equal((await second.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "34343434-5656-4789-8abc-defdefdefdef"),
  )).accepted, true);
});

test("failed tombstone persistence leaves revoke authority fully retryable", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const pairingBefore = harness.storage.getItem(PAIRING_STORAGE_KEY);
  const replayBefore = harness.storage.getItem(REPLAY_STORAGE_KEY);
  const catalogBefore = harness.files.get(path);
  const pairing = JSON.parse(pairingBefore).clients[0];
  const revokeParams = await signedRevokeParams();
  harness.failStorageSaveOnce(REVOCATION_STORAGE_KEY);
  const originalError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await harness.service.handleRevokeRoute(revokeParams);
  } finally {
    console.error = originalError;
  }
  assert.equal(failed.accepted, false);
  assert.equal(failed.reason, "runtime-failure");
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY), pairingBefore);
  assert.equal(harness.storage.getItem(REPLAY_STORAGE_KEY), replayBefore);
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY), null);
  assert.equal(harness.secretValues.get(pairing.secretID), SECRET);
  assert.equal(harness.files.get(path), catalogBefore);

  const retried = await harness.service.handleRevokeRoute(revokeParams);
  assert.equal(retried.accepted, true);
  assert.equal(harness.service.getStatus().clients.length, 0);
  assert.equal(harness.files.has(path), false);
});

test("durable tombstone fails closed when pairing-state cleanup fails, then refresh completes it", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  harness.failStorageSaveOnce(PAIRING_STORAGE_KEY);
  const result = await harness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "revocation-cleanup-pending");
  assert.equal(JSON.parse(harness.storage.getItem(PAIRING_STORAGE_KEY)).clients.length, 1);
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY) !== null, true);
  assert.equal(harness.service.getStatus().clients.length, 0);
  assert.equal((await harness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "45454545-6767-489a-8bcd-efefefefefef"),
  )).reason, "revocation-pending");
  assert.equal(harness.files.has(path), false);
  const writeCount = harness.writes.length;

  const recovered = await harness.service.refreshCatalogs("retry-pairing-state-cleanup");
  assert.equal(recovered.unavailableReason, "not-paired");
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY), null);
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY), null);
  assert.equal(harness.writes.length, writeCount, "a tombstoned physical pairing must never be republished");
});

test("replay cleanup failure is retried after reload before registry access", async (t) => {
  const harness = createHarness();
  let recreated = null;
  t.after(() => {
    harness.service.stop();
    recreated?.stop();
  });
  const path = await pairAndPublish(harness);
  assert.equal((await harness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "56565656-7878-49ab-8cde-fafafafafafa"),
  )).accepted, true);
  harness.failStorageSaveOnce(REPLAY_STORAGE_KEY);
  const result = await harness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(result.reason, "revocation-cleanup-pending");
  assert.equal(harness.service.getStatus().clients.length, 0);
  assert.equal(harness.files.has(path), false);
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY) !== null, true);
  assert.equal(JSON.parse(harness.storage.getItem(REPLAY_STORAGE_KEY)).entries.length, 1);

  harness.service.stop();
  harness.setRegistryAvailable(false);
  recreated = new serviceModule.TishOSCommandBridgeService(harness.app, { id: "tps-controller", version: "0.5.0" }, {
    now: () => NOW,
    confirmPairing: async () => true,
    confirmLocalRevoke: async () => true,
  });
  recreated.start();
  harness.fireLayout();
  const recovered = await recreated.refreshCatalogs("revoke-retry-without-registry");
  assert.equal(recovered.unavailableReason, "not-paired");
  assert.equal(harness.storage.getItem(REPLAY_STORAGE_KEY), null);
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY), null);
});

test("secret and catalog cleanup failures retain a fail-closed tombstone until retry", async (t) => {
  const secretHarness = createHarness();
  const secretPath = await pairAndPublish(secretHarness);
  const secretPairing = JSON.parse(secretHarness.storage.getItem(PAIRING_STORAGE_KEY)).clients[0];
  secretHarness.failSecretClearOnce();
  const secretResult = await secretHarness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(secretResult.reason, "revocation-cleanup-pending");
  assert.equal(secretHarness.secretValues.get(secretPairing.secretID), SECRET);
  assert.equal(secretHarness.files.has(secretPath), false);
  assert.equal((await secretHarness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "67676767-8989-4abc-8def-abababababab"),
  )).reason, "revocation-pending");
  await secretHarness.service.refreshCatalogs("retry-secret-cleanup");
  assert.equal(secretHarness.secretValues.get(secretPairing.secretID), "");
  assert.equal(secretHarness.storage.getItem(REVOCATION_STORAGE_KEY), null);
  secretHarness.service.stop();

  const fileHarness = createHarness();
  const filePath = await pairAndPublish(fileHarness);
  const original = fileHarness.files.get(filePath);
  fileHarness.failRemoveOnce(filePath);
  fileHarness.failWriteOnce(filePath);
  const fileResult = await fileHarness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(fileResult.reason, "revocation-cleanup-pending");
  assert.equal(fileHarness.files.get(filePath), original, "failed invalidation may leave bytes, but not execution authority");
  assert.equal((await fileHarness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "78787878-9a9a-4bcd-8efa-bcbcbcbcbcbc"),
  )).reason, "revocation-pending");
  await fileHarness.service.refreshCatalogs("retry-catalog-cleanup");
  assert.equal(fileHarness.files.has(filePath), false);
  assert.equal(fileHarness.storage.getItem(REVOCATION_STORAGE_KEY), null);
  fileHarness.service.stop();
  t.after(() => {
    secretHarness.service.stop();
    fileHarness.service.stop();
  });
});

test("artifact cleanup attempts are independent and final tombstone removal is retryable", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const pending = `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/.${CLIENT}.pending`;
  const backup = `${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/.${CLIENT}.backup`;
  harness.files.set(pending, "pending");
  harness.files.set(backup, harness.files.get(path));
  harness.failRemoveOnce(pending);
  harness.failRemoveOnce(backup);
  const result = await harness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(result.reason, "revocation-cleanup-pending");
  assert.equal(harness.files.has(path), false);
  assert.equal(harness.files.has(pending), true);
  assert.equal(harness.files.has(backup), true);
  await harness.service.refreshCatalogs("retry-artifact-cleanup");
  assert.equal(harness.files.has(pending), false);
  assert.equal(harness.files.has(backup), false);
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY), null);

  const finalSaveHarness = createHarness();
  const finalPath = await pairAndPublish(finalSaveHarness);
  finalSaveHarness.failStorageSaveAfter(REVOCATION_STORAGE_KEY, 1);
  const finalResult = await finalSaveHarness.service.handleRevokeRoute(await signedRevokeParams());
  assert.equal(finalResult.reason, "revocation-cleanup-pending");
  assert.equal(finalSaveHarness.files.has(finalPath), false);
  assert.equal(finalSaveHarness.storage.getItem(REVOCATION_STORAGE_KEY) !== null, true);
  await finalSaveHarness.service.refreshCatalogs("retry-tombstone-removal");
  assert.equal(finalSaveHarness.storage.getItem(REVOCATION_STORAGE_KEY), null);
  finalSaveHarness.service.stop();
});

test("same-client pairing is blocked by incomplete revocation, then uses a new SecretStorage slot", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const oldSecretID = JSON.parse(harness.storage.getItem(PAIRING_STORAGE_KEY)).clients[0].secretID;
  harness.failRemoveOnce(path);
  assert.equal((await harness.service.handleRevokeRoute(await signedRevokeParams())).reason, "revocation-cleanup-pending");
  harness.failRemoveOnce(path);
  assert.equal((await harness.service.handlePairRoute(pairParams())).reason, "revocation-cleanup-pending");
  assert.equal(harness.service.getStatus().clients.length, 0);

  const paired = await harness.service.handlePairRoute(pairParams());
  assert.equal(paired.accepted, true);
  const newSecretID = JSON.parse(harness.storage.getItem(PAIRING_STORAGE_KEY)).clients[0].secretID;
  assert.notEqual(newSecretID, oldSecretID);
});

test("malformed vault-local revocation state fails closed", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  harness.storage.setItem(REVOCATION_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, vaultName: VAULT, entries: "bad" }));
  assert.equal(harness.service.getStatus().available, false);
  assert.equal((await harness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "89898989-abab-4cde-8fab-cdcdcdcdcdcd"),
  )).reason, "runtime-failure");
  assert.equal((await harness.service.handlePairRoute(pairParams(SECOND_CLIENT))).reason, "storage-failure");
  harness.service.start();
  harness.fireLayout();
  assert.equal((await harness.service.refreshCatalogs("malformed-revocation-state")).unavailableReason, "refresh-failure");
});

test("revoke waits out an active publisher so no stale catalog can reappear", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  harness.setCommands([...COMMANDS, { id: "tps-controller:refresh", name: "Refresh" }]);
  const block = harness.blockNextExists();
  const refresh = harness.service.refreshCatalogs("blocked-before-revoke");
  await block.entered;
  let revokeSettled = false;
  const revoke = harness.service
    .handleRevokeRoute(await signedRevokeParams(CLIENT, "fdfdfdfd-aaaa-4bbb-8ccc-dddddddddddd"))
    .finally(() => { revokeSettled = true; });
  await Promise.resolve();
  assert.equal(revokeSettled, false);
  block.release();
  await refresh;
  assert.equal((await revoke).accepted, true);
  assert.equal(harness.files.has(path), false);
  assert.equal(harness.service.getStatus().clients.length, 0);
});

test("durable revoke suppresses a pending pairing callback while its publisher settles", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  harness.service.start();
  const blockedWrite = harness.blockNextWrite();
  harness.fireLayout();
  await blockedWrite.entered;
  const revokePromise = harness.service.handleRevokeRoute(
    await signedRevokeParams(CLIENT, "90909090-bcbc-4def-8abc-dededededede"),
  );
  for (let index = 0; index < 20 && harness.storage.getItem(REVOCATION_STORAGE_KEY) === null; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(harness.storage.getItem(REVOCATION_STORAGE_KEY) !== null, true, "revoke must be durable before waiting on publish");
  assert.equal(harness.openedURLs.length, 0);
  blockedWrite.release();
  assert.equal((await revokePromise).accepted, true);
  assert.equal(harness.openedURLs.length, 0, "revocation must suppress the stale pair callback");
  assert.equal(harness.files.has(`${contract.TISHOS_COMMAND_BRIDGE_CATALOG_ROOT}/${CLIENT}.json`), false);
});

test("SecretStorage failure rolls back pairing metadata and publishes nothing", async () => {
  const harness = createHarness({ failSecretWrites: true });
  const originalError = console.error;
  console.error = () => {};
  const result = await harness.service.handlePairRoute(pairParams()).finally(() => { console.error = originalError; });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "storage-failure");
  assert.equal(harness.service.getStatus().clients.length, 0);
  assert.equal(harness.files.size, 0);
  assert.equal([...harness.storage.values.values()].some((value) => value.includes(CLIENT)), false);
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY), null);
  assert.equal(harness.storage.getItem(REPLAY_STORAGE_KEY), null);
});

test("re-pair storage failure preserves the prior generation and secret authority", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  const path = await pairAndPublish(harness);
  const pairingBefore = harness.storage.getItem(PAIRING_STORAGE_KEY);
  const catalogBefore = harness.files.get(path);
  const oldPairing = JSON.parse(pairingBefore).clients[0];
  const rotatedBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  harness.failStorageSaveOnce(REPLAY_STORAGE_KEY);
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await harness.service.handlePairRoute(pairParams(CLIENT, contract.encodeBase64URL(rotatedBytes)));
  } finally {
    console.error = originalError;
  }
  assert.equal(result.reason, "storage-failure");
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY), pairingBefore);
  assert.equal(harness.storage.getItem(REPLAY_STORAGE_KEY), null);
  assert.equal(harness.secretValues.get(oldPairing.secretID), SECRET);
  assert.equal(harness.files.get(path), catalogBefore);
});

test("replay execution fails closed when vault-local persistence is silently dropped", async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.stop());
  await harness.service.handlePairRoute(pairParams());
  const params = await signedRunParams(COMMANDS[0], CLIENT, "12121212-abab-4cde-8fab-343434343434");
  harness.swallowStorageSaveOnce(REPLAY_STORAGE_KEY);
  const first = await harness.service.handleRunRoute(params);
  assert.equal(first.reason, "runtime-failure");
  assert.deepEqual(harness.executions, []);
  assert.equal(harness.storage.getItem(REPLAY_STORAGE_KEY), null);

  const retry = await harness.service.handleRunRoute(params);
  assert.equal(retry.reason, "executed");
  assert.deepEqual(harness.executions, [COMMANDS[0].id]);
});

test("plugin stop settles without an open pair modal and blocks approval from creating authority", async () => {
  const approval = deferred();
  const entered = deferred();
  const harness = createHarness({
    confirmPairing: async () => {
      entered.resolve();
      return approval.promise;
    },
  });
  const pairing = harness.service.handlePairRoute(pairParams());
  await entered.promise;
  await within(harness.service.stop(), "bridge stop while pairing modal is open");
  approval.resolve(true);

  assert.equal((await pairing).reason, "service-stopped");
  assert.equal(harness.storage.length, 0);
  assert.equal(harness.secretValues.size, 0);
  assert.equal(harness.files.size, 0);
  assert.equal(harness.openedURLs.length, 0);
});

test("one coalesced pair prompt cannot starve authenticated run or local revoke", async (t) => {
  const approval = deferred();
  const entered = deferred();
  const harness = createHarness({
    confirmPairing: async (request) => {
      if (request.clientID === CLIENT) return true;
      entered.resolve();
      return approval.promise;
    },
  });
  t.after(() => harness.service.stop());
  assert.equal((await harness.service.handlePairRoute(pairParams())).accepted, true);

  const pending = harness.service.handlePairRoute(pairParams(SECOND_CLIENT));
  await entered.promise;
  const duplicate = harness.service.handlePairRoute(pairParams(SECOND_CLIENT));
  assert.strictEqual(duplicate, pending, "an exact duplicate must share the one active confirmation");
  assert.equal(
    (await harness.service.handlePairRoute(pairParams(THIRD_CLIENT))).reason,
    "pairing-busy",
    "a different unauthenticated prompt must be rejected instead of queued",
  );

  const run = await within(
    harness.service.handleRunRoute(
      await signedRunParams(COMMANDS[0], CLIENT, "56565656-cdcd-4abc-8def-787878787878"),
    ),
    "authenticated run behind pairing prompt",
  );
  assert.equal(run.reason, "executed");
  assert.equal(await within(harness.service.requestLocalRevoke(CLIENT), "local revoke behind pairing prompt"), true);
  assert.equal(harness.service.getStatus().clients.length, 0);

  approval.resolve(false);
  assert.equal((await pending).reason, "user-cancelled");
  assert.equal((await duplicate).reason, "user-cancelled");
});

test("stop invalidates a run queued behind finite authenticated cleanup and drains it", async () => {
  const harness = createHarness();
  await pairAndPublish(harness);
  const block = harness.blockNextExists();
  const refresh = harness.service.refreshCatalogs("blocked-before-stop");
  await block.entered;
  const revoke = harness.service.handleRevokeRoute(
    await signedRevokeParams(CLIENT, "67676767-dede-4bcd-8efa-898989898989"),
  );
  for (let index = 0; index < 20 && harness.storage.getItem(REVOCATION_STORAGE_KEY) === null; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.notEqual(harness.storage.getItem(REVOCATION_STORAGE_KEY), null);
  const queuedRun = harness.service.handleRunRoute(
    await signedRunParams(COMMANDS[0], CLIENT, "78787878-efef-4cde-8fab-909090909090"),
  );
  const stopped = harness.service.stop();
  block.release();
  await refresh;
  assert.equal((await revoke).accepted, true);
  assert.equal((await queuedRun).reason, "service-stopped");
  await within(stopped, "authenticated route drain");
  assert.deepEqual(harness.executions, []);
});

test("local revoke approval cannot mutate authority after stop", async () => {
  const approval = deferred();
  const entered = deferred();
  const harness = createHarness({
    confirmLocalRevoke: async () => {
      entered.resolve();
      return approval.promise;
    },
  });
  await harness.service.handlePairRoute(pairParams());
  const pairingBefore = harness.storage.getItem(PAIRING_STORAGE_KEY);
  const revoke = harness.service.requestLocalRevoke(CLIENT);
  await entered.promise;
  await within(harness.service.stop(), "bridge stop while local revoke confirmation is open");
  approval.resolve(true);

  assert.equal(await revoke, false);
  assert.equal(harness.storage.getItem(PAIRING_STORAGE_KEY), pairingBefore);
  assert.equal(harness.service.getStatus().clients.length, 1);
});

test("source wiring keeps discovery, execution, and mobile-safe confirmation behind shared seams", async () => {
  const [main, guards, bridgeService, packageJson] = await Promise.all([
    readFile(fileURLToPath(new URL("src/main.ts", root)), "utf8"),
    readFile(fileURLToPath(new URL("src/core/type-guards.ts", root)), "utf8"),
    readFile(fileURLToPath(new URL("src/services/tishos-command-bridge-service.ts", root)), "utf8"),
    readFile(fileURLToPath(new URL("package.json", root)), "utf8"),
  ]);
  assert.match(guards, /listCommands\?: \(\) => unknown/);
  assert.match(guards, /executeCommandById\?: \(id: string\) => boolean/);
  assert.match(main, /registerObsidianProtocolHandler\(TISHOS_COMMAND_BRIDGE_PAIR_ROUTE/);
  assert.match(main, /registerObsidianProtocolHandler\(TISHOS_COMMAND_BRIDGE_RUN_ROUTE/);
  assert.match(main, /registerObsidianProtocolHandler\(TISHOS_COMMAND_BRIDGE_REVOKE_ROUTE/);
  assert.match(main, /id: "refresh-tishos-command-bridge"/);
  assert.match(main, /const commandBridgeStop = this\.tishOSCommandBridgeService\?\.stop\(\)/);
  assert.match(main, /await commandBridgeStop/);
  assert.match(bridgeService, /this\.modalEl\.addClass\("tps-keyboard-aware-modal"\)/);
  assert.match(packageJson, /test-tishos-command-bridge\.mjs/);
});
