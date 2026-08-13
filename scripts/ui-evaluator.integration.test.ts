import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPort } from "./visual-validation.js";

test("UI evaluator infrastructure reaches a local app without relying on Ready stdout and cleans it up", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "benchmark-ui-integration-"));
  const port = 30_000 + Math.floor(Math.random() * 1_000);
  await writeFile(join(projectDir, "server.mjs"), `
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<main data-testid=book-list>local app</main>");
}).listen(Number(process.env.PORT), "127.0.0.1");
`, "utf8");

  const server = spawn(process.execPath, [join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  try {
    assert.equal(await waitForPort(port, 5_000), true);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-testid=book-list/);
  } finally {
    if (process.platform !== "win32" && server.pid) process.kill(-server.pid, "SIGTERM");
    else server.kill("SIGTERM");
    await new Promise((resolve) => server.once("close", resolve));
  }
  assert.equal(await waitForPort(port, 500), false);
});
