import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compatibilityMarker = "BRAT compatibility mirror";

test("Controller runtime does not require the nonstandard styles-ui.css asset", async () => {
  const source = await readFile(join(pluginRoot, "src", "main.ts"), "utf8");

  assert.doesNotMatch(source, /styles-ui\.css/);
  assert.doesNotMatch(source, /tps-controller-ui-styles/);
});

test("standard styles.css contains the complete legacy UI stylesheet", async () => {
  const [standardStyles, legacyStyles] = await Promise.all([
    readFile(join(pluginRoot, "styles.css"), "utf8"),
    readFile(join(pluginRoot, "styles-ui.css"), "utf8"),
  ]);
  const markerIndex = standardStyles.indexOf(compatibilityMarker);

  assert.notEqual(markerIndex, -1, "styles.css should explain the BRAT compatibility mirror");
  assert.ok(
    standardStyles.slice(markerIndex).trimEnd().endsWith(legacyStyles.trim()),
    "styles.css should end with an exact copy of every legacy styles-ui.css rule",
  );
});
