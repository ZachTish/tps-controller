import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const buildResult = await build({
  entryPoints: [fileURLToPath(new URL("../src/services/s3-credential-service.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const credentials = await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles[0].text).toString("base64")}`);

function memorySecretStorage(initial = new Map(), failName = "") {
  const values = new Map(initial);
  const writes = [];
  return {
    values,
    writes,
    getSecret(name) {
      return values.get(name) || null;
    },
    setSecret(name, value) {
      writes.push(name);
      if (name === failName) throw new Error("simulated SecretStorage failure");
      values.set(name, value);
    },
  };
}

test("legacy plaintext credentials migrate to named SecretStorage entries before fields are purged", () => {
  const rule = { accessKey: "  legacy-access  ", secretKey: "  legacy-secret  " };
  const storage = memorySecretStorage();
  const result = credentials.migrateLegacyS3Credentials(rule, storage);
  assert.equal(result.migrated, 2);
  assert.equal(result.retainedLegacy, 0);
  assert.equal(rule.accessKeySecretName, credentials.DEFAULT_S3_ACCESS_KEY_SECRET_NAME);
  assert.equal(rule.secretKeySecretName, credentials.DEFAULT_S3_SECRET_KEY_SECRET_NAME);
  assert.equal(Object.hasOwn(rule, "accessKey"), false);
  assert.equal(Object.hasOwn(rule, "secretKey"), false);
  assert.equal(storage.values.size, 2);
});

test("migration never overwrites populated named secrets", () => {
  const existing = new Map([
    [credentials.DEFAULT_S3_ACCESS_KEY_SECRET_NAME, "existing-access"],
    [credentials.DEFAULT_S3_SECRET_KEY_SECRET_NAME, "existing-secret"],
  ]);
  const storage = memorySecretStorage(existing);
  const rule = { accessKey: "legacy-access", secretKey: "legacy-secret" };
  const result = credentials.migrateLegacyS3Credentials(rule, storage);
  assert.equal(result.migrated, 0);
  assert.equal(result.reusedExisting, 0);
  assert.equal(result.retainedLegacy, 2);
  assert.equal(storage.writes.length, 0);
  assert.deepEqual(storage.values, existing);
  assert.equal(Object.hasOwn(rule, "accessKey"), true);
  assert.equal(Object.hasOwn(rule, "secretKey"), true);
});

test("a failed secret write retains only the unmigrated legacy field", () => {
  const storage = memorySecretStorage(new Map(), credentials.DEFAULT_S3_SECRET_KEY_SECRET_NAME);
  const rule = { accessKey: "legacy-access", secretKey: "legacy-secret" };
  const result = credentials.migrateLegacyS3Credentials(rule, storage);
  assert.equal(result.migrated, 1);
  assert.equal(result.retainedLegacy, 1);
  assert.deepEqual(result.failedFields, ["secret-key"]);
  assert.equal(Object.hasOwn(rule, "accessKey"), false);
  assert.equal(Object.hasOwn(rule, "secretKey"), true);
});

test("an unconfirmed field survives settings persistence and reload until a confirmed retry purges it", () => {
  const firstStorage = memorySecretStorage(new Map(), credentials.DEFAULT_S3_SECRET_KEY_SECRET_NAME);
  const firstRule = { accessKey: "legacy-access", secretKey: "legacy-secret" };
  credentials.migrateLegacyS3Credentials(firstRule, firstStorage);
  const retained = credentials.takeRetainedLegacyS3Credentials(firstRule);
  assert.equal(Object.hasOwn(firstRule, "secretKey"), false);

  const persisted = credentials.withRetainedLegacyS3Credentials(firstRule, retained);
  const reloaded = JSON.parse(JSON.stringify(persisted));
  assert.equal(Object.hasOwn(reloaded, "accessKey"), false);
  assert.equal(Object.hasOwn(reloaded, "secretKey"), true);

  const retryStorage = memorySecretStorage(firstStorage.values);
  const retry = credentials.migrateLegacyS3Credentials(reloaded, retryStorage);
  assert.equal(retry.migrated, 1);
  assert.equal(Object.hasOwn(reloaded, "secretKey"), false);
});

test("execution resolves trimmed credentials and rejects missing or conflicting references safely", () => {
  const refs = {
    accessKeySecretName: "access-ref",
    secretKeySecretName: "secret-ref",
  };
  const values = new Map([
    ["access-ref", "  runtime-access  "],
    ["secret-ref", "\truntime-secret\n"],
  ]);
  assert.deepEqual(credentials.resolveS3Credentials(refs, (name) => values.get(name) || null), {
    accessKeyId: "runtime-access",
    secretAccessKey: "runtime-secret",
  });
  assert.throws(
    () => credentials.resolveS3Credentials(refs, () => null),
    (error) => error.code === "missing-access-key" && !error.message.includes("runtime-access"),
  );
  assert.throws(
    () => credentials.resolveS3Credentials({ accessKeySecretName: "same", secretKeySecretName: "same" }, () => "value"),
    (error) => error.code === "conflicting-references",
  );
});
