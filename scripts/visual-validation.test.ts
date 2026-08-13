import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:net";
import { getVisualAssetPath, RESULTS_DIR } from "./utils.js";
import { selectBrowser, selectServerScript, waitForPort } from "./visual-validation.js";

test("selectServerScript prefers the production start script", () => {
  assert.equal(selectServerScript({ scripts: { dev: "next dev", start: "next start" } }), "start");
  assert.equal(selectServerScript({ scripts: { dev: "vite" } }), "dev");
  assert.equal(selectServerScript({ scripts: { test: "vitest" } }), null);
});

test("getVisualAssetPath keeps screenshots under reports/assets", () => {
  const path = getVisualAssetPath("greenfield", join(RESULTS_DIR, "greenfield/codex__demo"));
  assert.match(path, /reports\/assets\/greenfield\/codex__demo\/home\.png$/);
});

test("selectBrowser returns a supported browser or null when none is installed", () => {
  assert.ok(["agent-browser", "google-chrome", null].includes(selectBrowser()));
});

test("waitForPort checks TCP readiness without requiring fetch", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(await waitForPort(address.port, 1_000), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await waitForPort(address.port, 100), false);
});
