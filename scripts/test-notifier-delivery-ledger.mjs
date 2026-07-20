import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let deliveryModule;

async function loadDeliveryModule() {
  if (deliveryModule) return deliveryModule;
  const outdir = await mkdtemp(join(tmpdir(), "tps-controller-delivery-"));
  await build({
    entryPoints: {
      "notifier-delivery-coordinator": fileURLToPath(new URL("../src/services/notifier-delivery-coordinator.ts", import.meta.url)),
      "notifier-delivery-ledger": fileURLToPath(new URL("../src/services/notifier-delivery-ledger.ts", import.meta.url)),
      "operation-deadline": fileURLToPath(new URL("../src/services/operation-deadline.ts", import.meta.url)),
    },
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const coordinatorModule = await import(pathToFileURL(join(outdir, "notifier-delivery-coordinator.mjs")).href);
  const ledgerModule = await import(pathToFileURL(join(outdir, "notifier-delivery-ledger.mjs")).href);
  const deadlineModule = await import(pathToFileURL(join(outdir, "operation-deadline.mjs")).href);
  deliveryModule = { ...coordinatorModule, ...ledgerModule, ...deadlineModule };
  test.after(async () => rm(outdir, { recursive: true, force: true }));
  return deliveryModule;
}

class FakeStorage {
  constructor(initialValue = null) {
    this.value = initialValue;
  }

  writes = 0;
  failWrites = new Set();

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.writes += 1;
    if (this.failWrites.has(this.writes)) throw new Error("injected storage failure");
    this.value = value;
  }
}

async function createReadyLedger(storage = new FakeStorage(), now = () => 1_000) {
  const { NotifierDeliveryLedger } = await loadDeliveryModule();
  const ledger = new NotifierDeliveryLedger(storage, "delivery-state", now);
  assert.equal(ledger.load().ready, true);
  return { ledger, storage };
}

test("numeric legacy state migrates atomically to explicit legacy-accepted records", async () => {
  const storage = new FakeStorage(JSON.stringify({ "session:hour": 456 }));
  const { ledger } = await createReadyLedger(storage);
  const record = ledger.getRecord("session:hour");

  assert.equal(record.state, "legacy-accepted");
  assert.equal(record.transport, "unknown");
  assert.equal(record.evidence, "legacy-untracked");
  assert.equal(record.attempted, "unknown");
  assert.equal(record.updatedAt, 456);
  assert.equal(JSON.parse(storage.value).schemaVersion, 1);
});

test("legacy migration accepts prior numeric strings but empty present storage fails closed", async () => {
  const numericStorage = new FakeStorage(JSON.stringify({ "session:hour": "456" }));
  const { ledger } = await createReadyLedger(numericStorage);
  assert.equal(ledger.getRecord("session:hour").updatedAt, 456);
  assert.equal(ledger.getRecord("session:hour").state, "legacy-accepted");

  const { NotifierDeliveryLedger } = await loadDeliveryModule();
  for (const raw of ["", "   "]) {
    const storage = new FakeStorage(raw);
    const empty = new NotifierDeliveryLedger(storage, "delivery-state");
    const loaded = empty.load();
    assert.equal(loaded.ready, false);
    assert.equal(loaded.blockedReason, "invalid-json");
    assert.equal(storage.value, raw);
    assert.equal(storage.writes, 0);
  }
});

test("persisted attempting state becomes terminal unknown before the ledger is ready", async () => {
  const storage = new FakeStorage(JSON.stringify({
    schemaVersion: 1,
    nextAttemptSequence: 8,
    records: {
      "session:hour": { state: "attempting", updatedAt: 500, attemptId: "controller-7" },
    },
  }));
  const { NotifierDeliveryLedger } = await loadDeliveryModule();
  const ledger = new NotifierDeliveryLedger(storage, "delivery-state", () => 900);
  const loaded = ledger.load();

  assert.deepEqual(loaded, {
    ready: true,
    migratedLegacyRecords: 0,
    recoveredAttemptingRecords: 1,
  });
  assert.deepEqual(ledger.getRecord("session:hour"), {
    state: "unknown",
    updatedAt: 900,
    attemptId: "controller-7",
    transport: "unknown",
    evidence: "interrupted",
    attempted: "unknown",
  });
  assert.equal(JSON.parse(storage.value).records["session:hour"].state, "unknown");
});

test("malformed and future ledger documents fail closed without overwriting evidence", async () => {
  const { NotifierDeliveryLedger } = await loadDeliveryModule();
  for (const raw of [
    "{bad json",
    JSON.stringify({ schemaVersion: 99, nextAttemptSequence: 1, records: {} }),
    JSON.stringify({ schemaVersion: 1, nextAttemptSequence: 1, records: { bad: { state: "accepted" } } }),
    JSON.stringify({
      schemaVersion: 1,
      nextAttemptSequence: 1,
      records: {
        bad: {
          state: "accepted", updatedAt: 10, transport: "notifier-v2", evidence: "structured-receipt",
          attempted: false, httpStatus: 200, providerMessageId: "contradictory",
        },
      },
    }),
  ]) {
    const storage = new FakeStorage(raw);
    const ledger = new NotifierDeliveryLedger(storage, "delivery-state");
    assert.equal(ledger.load().ready, false);
    assert.equal(ledger.ready, false);
    assert.equal(storage.value, raw);
    assert.equal(storage.writes, 0);
  }
});

test("a failed attempting-state write prevents sender invocation", async () => {
  const { NotifierDeliveryCoordinator } = await loadDeliveryModule();
  const { ledger, storage } = await createReadyLedger();
  storage.failWrites.add(2);
  let sends = 0;
  const coordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      sends += 1;
      return {
        state: "accepted", transport: "notifier-v2", evidence: "structured-receipt", attempted: true,
        httpStatus: 200, providerMessageId: "never",
      };
    },
  }, ledger);

  const outcome = await coordinator.deliver("session:hour", { body: "private body" });
  assert.equal(sends, 0);
  assert.equal(outcome.sendInvoked, false);
  assert.equal(outcome.persisted, false);
  assert.equal(outcome.result.state, "not-attempted");
  assert.equal(ledger.getRecord("session:hour"), undefined);
});

test("every sender terminal state is persisted exactly and suppresses a second invocation", async () => {
  const { NotifierDeliveryCoordinator } = await loadDeliveryModule();
  const terminalResults = [
    {
      state: "accepted", transport: "notifier-v2", evidence: "structured-receipt", attempted: true,
      httpStatus: 202, providerMessageId: "receipt-1",
    },
    {
      state: "legacy-accepted", transport: "notifier-v1", evidence: "legacy-promise-resolved", attempted: true,
    },
    {
      state: "rejected", transport: "notifier-v2", evidence: "structured-rejection", attempted: true,
      code: "delivery-rejected", httpStatus: 401,
    },
    {
      state: "not-attempted", transport: "unavailable", evidence: "service-unavailable", attempted: false,
    },
    {
      state: "unknown", transport: "notifier-v2", evidence: "unconfirmed", attempted: true,
      code: "delivery-unconfirmed", httpStatus: 503,
    },
    {
      state: "unknown", transport: "notifier-v2", evidence: "malformed-v2-result", attempted: "unknown",
    },
    {
      state: "unknown", transport: "notifier-v1", evidence: "legacy-rejection", attempted: "unknown",
    },
    {
      state: "unknown", transport: "notifier-v2", evidence: "consumer-timeout", attempted: "unknown",
    },
  ];

  for (const [index, expected] of terminalResults.entries()) {
    const { ledger, storage } = await createReadyLedger();
    let sends = 0;
    const coordinator = new NotifierDeliveryCoordinator({
      send: async () => {
        sends += 1;
        return expected;
      },
    }, ledger);
    const key = `session:${index}`;

    const first = await coordinator.deliver(key, { title: "secret title", body: "secret body" });
    const second = await coordinator.deliver(key, { body: "different body" });
    const persisted = ledger.resultForRecord(ledger.getRecord(key));

    assert.deepEqual(first.result, expected);
    assert.deepEqual(persisted, expected);
    assert.deepEqual(second.result, expected);
    assert.equal(second.reusedExisting, true);
    assert.equal(second.sendInvoked, false);
    assert.equal(sends, 1);
    assert.equal(storage.value.includes("secret title"), false);
    assert.equal(storage.value.includes("secret body"), false);
  }
});

test("only a proven not-attempted result may be retried for the same occurrence", async () => {
  const { NotifierDeliveryCoordinator } = await loadDeliveryModule();
  const { ledger } = await createReadyLedger();
  let sends = 0;
  const coordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      sends += 1;
      if (sends === 1) {
        return {
          state: "not-attempted",
          transport: "unavailable",
          evidence: "service-unavailable",
          attempted: false,
        };
      }
      return {
        state: "accepted",
        transport: "notifier-v2",
        evidence: "structured-receipt",
        attempted: true,
        httpStatus: 200,
        providerMessageId: "recovered",
      };
    },
  }, ledger);

  const first = await coordinator.deliver(
    "session:retry",
    { body: "first" },
    { retryNotAttempted: true },
  );
  const second = await coordinator.deliver(
    "session:retry",
    { body: "second" },
    { retryNotAttempted: true },
  );

  assert.equal(first.result.state, "not-attempted");
  assert.equal(second.result.state, "accepted");
  assert.equal(sends, 2);
  assert.equal(ledger.getRecord("session:retry").providerMessageId, "recovered");

  const unknown = {
    state: "unknown",
    transport: "notifier-v2",
    evidence: "consumer-timeout",
    attempted: "unknown",
  };
  const other = await createReadyLedger();
  let unknownSends = 0;
  const unknownCoordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      unknownSends += 1;
      return unknown;
    },
  }, other.ledger);
  await unknownCoordinator.deliver("session:unknown", { body: "first" }, { retryNotAttempted: true });
  const repeated = await unknownCoordinator.deliver(
    "session:unknown",
    { body: "second" },
    { retryNotAttempted: true },
  );
  assert.equal(repeated.reusedExisting, true);
  assert.equal(repeated.result.state, "unknown");
  assert.equal(unknownSends, 1);
});

test("one occurrence claim persists one attempt and one terminal outcome", async () => {
  const { NotifierDeliveryCoordinator } = await loadDeliveryModule();
  const { ledger } = await createReadyLedger();
  let sends = 0;
  const expected = {
    state: "accepted", transport: "notifier-v2", evidence: "structured-receipt", attempted: true,
    httpStatus: 200, providerMessageId: "batch",
  };
  const coordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      sends += 1;
      return expected;
    },
  }, ledger);

  await coordinator.deliver("task:a", { body: "one occurrence" });
  assert.equal(sends, 1);
  assert.deepEqual(ledger.resultForRecord(ledger.getRecord("task:a")), expected);
});

test("unexpected sender throws become unknown without an alternate invocation", async () => {
  const { NotifierDeliveryCoordinator } = await loadDeliveryModule();
  const { ledger } = await createReadyLedger();
  let sends = 0;
  const coordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      sends += 1;
      throw new Error("private transport failure");
    },
  }, ledger);

  const outcome = await coordinator.deliver("session:hour", { body: "one route" });
  assert.equal(sends, 1);
  assert.deepEqual(outcome.result, {
    state: "unknown",
    transport: "unknown",
    evidence: "interrupted",
    attempted: "unknown",
  });
  assert.deepEqual(ledger.resultForRecord(ledger.getRecord("session:hour")), outcome.result);
});

test("a hostile sender result fails closed and leaves the durable attempting barrier", async () => {
  const { NotifierDeliveryCoordinator } = await loadDeliveryModule();
  const { ledger, storage } = await createReadyLedger();
  let sends = 0;
  const hostileResult = new Proxy({}, { ownKeys() { throw new Error("hostile result"); } });
  const coordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      sends += 1;
      return hostileResult;
    },
  }, ledger);

  const outcome = await coordinator.deliver("session:hour", { body: "one route" });
  assert.equal(sends, 1);
  assert.equal(outcome.persisted, false);
  assert.equal(outcome.result.state, "unknown");
  assert.equal(JSON.parse(storage.value).records["session:hour"].state, "attempting");
});

test("settlement write failure leaves durable attempting evidence and never resends", async () => {
  const { NotifierDeliveryCoordinator, NotifierDeliveryLedger } = await loadDeliveryModule();
  const { ledger, storage } = await createReadyLedger();
  storage.failWrites.add(3);
  let sends = 0;
  const coordinator = new NotifierDeliveryCoordinator({
    send: async () => {
      sends += 1;
      return {
        state: "accepted", transport: "notifier-v2", evidence: "structured-receipt", attempted: true,
        httpStatus: 200, providerMessageId: "ambiguous-persistence",
      };
    },
  }, ledger);

  const first = await coordinator.deliver("session:hour", { body: "one route" });
  const second = await coordinator.deliver("session:hour", { body: "no retry" });
  assert.equal(first.result.state, "unknown");
  assert.equal(first.persisted, false);
  assert.equal(second.sendInvoked, false);
  assert.equal(sends, 1);
  assert.equal(JSON.parse(storage.value).records["session:hour"].state, "attempting");

  const restarted = new NotifierDeliveryLedger(storage, "delivery-state", () => 5_000);
  assert.equal(restarted.load().recoveredAttemptingRecords, 1);
  assert.equal(restarted.getRecord("session:hour").state, "unknown");
  assert.equal(restarted.getRecord("session:hour").transport, "unknown");
});

test("terminal records prune after the dedupe horizon so the hourly ledger stays bounded", async () => {
  const storage = new FakeStorage(JSON.stringify({
    schemaVersion: 1,
    nextAttemptSequence: 3,
    records: {
      old: {
        state: "accepted", updatedAt: 10, transport: "notifier-v2", evidence: "structured-receipt",
        attempted: true, httpStatus: 200, providerMessageId: "old",
      },
      uncertain: {
        state: "unknown", updatedAt: 10, transport: "unknown", evidence: "interrupted", attempted: "unknown",
      },
      current: {
        state: "accepted", updatedAt: 500, transport: "notifier-v2", evidence: "structured-receipt",
        attempted: true, httpStatus: 200, providerMessageId: "current",
      },
    },
  }));
  const { ledger } = await createReadyLedger(storage);
  assert.equal(ledger.pruneResolvedBefore(100), true);
  assert.equal(ledger.getRecord("old"), undefined);
  assert.equal(ledger.getRecord("uncertain"), undefined);
  assert.equal(ledger.getRecord("current").state, "accepted");
});

test("closing an old ledger fences late settlement from overwriting a restarted instance", async () => {
  const { NotifierDeliveryCoordinator, NotifierDeliveryLedger } = await loadDeliveryModule();
  const { ledger, storage } = await createReadyLedger();
  let releaseSend;
  const oldCoordinator = new NotifierDeliveryCoordinator({
    send: () => new Promise((resolve) => { releaseSend = resolve; }),
  }, ledger);
  const oldDelivery = oldCoordinator.deliver("old:hour", { body: "old" });
  assert.equal(JSON.parse(storage.value).records["old:hour"].state, "attempting");

  ledger.close();
  const restarted = new NotifierDeliveryLedger(storage, "delivery-state", () => 10_000);
  assert.equal(restarted.load().recoveredAttemptingRecords, 1);
  const newClaim = restarted.beginAttempt("new:hour");
  assert.equal(newClaim.claimed, true);
  assert.equal(restarted.settleAttempt("new:hour", newClaim.attemptId, {
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 200,
    providerMessageId: "new-result",
  }).settled, true);

  releaseSend({
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 200,
    providerMessageId: "late-old-result",
  });
  const oldOutcome = await oldDelivery;
  assert.equal(oldOutcome.persisted, false);
  const persisted = JSON.parse(storage.value).records;
  assert.equal(persisted["old:hour"].state, "unknown");
  assert.equal(persisted["new:hour"].providerMessageId, "new-result");
});

test("bounded waits release a never-settling source operation", async () => {
  const { OperationDeadlineError, withOperationDeadline } = await loadDeliveryModule();
  await assert.rejects(
    withOperationDeadline(new Promise(() => undefined), 5),
    (error) => error instanceof OperationDeadlineError && error.timeoutMs === 5,
  );
});
