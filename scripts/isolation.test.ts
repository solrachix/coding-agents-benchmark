import test from "node:test";
import assert from "node:assert/strict";
import { getResultDir, createExecutionId, hashText } from "./utils.js";

test("execution ids make repeated benchmark runs use different result directories", () => {
  const first = getResultDir("greenfield", "opencode", "openai/gpt-5.6-luna", 1, "medium", "run-a");
  const second = getResultDir("greenfield", "opencode", "openai/gpt-5.6-luna", 1, "medium", "run-b");
  assert.notEqual(first, second);
  assert.match(first, /execution-run-a/);
});

test("createExecutionId is timestamped and filesystem-safe", () => {
  assert.match(createExecutionId(new Date("2026-08-11T12:34:56.789Z")), /^20260811T123456789Z-[a-z0-9]+$/);
});

test("hashText is stable for prompt provenance", () => {
  assert.equal(hashText("same prompt"), hashText("same prompt"));
  assert.notEqual(hashText("same prompt"), hashText("different prompt"));
  assert.match(hashText("same prompt"), /^[a-f0-9]{64}$/);
});
