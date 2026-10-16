import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function importBundled(entryPoint) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entryPoint, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const providers = await importBundled("../src/services/notification-delivery-provider.ts");
const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
const notificationViewSource = await readFile(new URL("../src/views/notification-view.ts", import.meta.url), "utf8");

test("notification provider registry is explicit and extensible", () => {
  assert.deepEqual(
    providers.NOTIFICATION_DELIVERY_PROVIDERS.map(({ id, label }) => ({ id, label })),
    [
      { id: "tishos", label: "TishOS" },
      { id: "ntfy", label: "ntfy" },
    ],
  );
  assert.equal(providers.DEFAULT_NOTIFICATION_DELIVERY_PROVIDER, "tishos");
  assert.equal(providers.isNotificationDeliveryProvider("tishos"), true);
  assert.equal(providers.isNotificationDeliveryProvider("ntfy"), true);
  assert.equal(providers.isNotificationDeliveryProvider("none"), false);
});

test("provider migration uses TishOS for legacy mobile/User devices and preserves desktop Controller ntfy", () => {
  const migrate = ({ value, persisted, isMobile, role }) => providers.resolveNotificationDeliveryProvider(
    value,
    persisted,
    !isMobile && role === "controller",
  );

  assert.equal(migrate({ value: undefined, persisted: false, isMobile: false, role: "user" }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: true, role: "controller" }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: false, role: "user" }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: false, role: undefined }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: false, role: "controller" }), "ntfy");
  assert.equal(providers.resolveNotificationDeliveryProvider("tishos", true), "tishos");
  assert.equal(providers.resolveNotificationDeliveryProvider("ntfy", false), "ntfy");
  assert.equal(providers.resolveNotificationDeliveryProvider("invalid", true), "tishos");
});
