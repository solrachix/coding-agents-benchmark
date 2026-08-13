import test from "node:test";
import assert from "node:assert/strict";
import { extractModelRuntimeMetadata } from "./model-metadata.js";

test("extractModelRuntimeMetadata records observable model revision/fingerprint without inventing them", () => {
  const output = [
    JSON.stringify({ type: "start", model: "deepseek-v4-flash", model_revision: "0731" }),
    JSON.stringify({ response: { system_fingerprint: "fp_abc" } }),
  ].join("\n");
  const result = extractModelRuntimeMetadata(output, "opencode/deepseek-v4-flash");
  assert.equal(result.requestedModel, "opencode/deepseek-v4-flash");
  assert.equal(result.resolvedModel, "deepseek-v4-flash");
  assert.equal(result.modelRevision, "0731");
  assert.equal(result.systemFingerprint, "fp_abc");
});

test("extractModelRuntimeMetadata leaves revision unknown when provider does not expose it", () => {
  const result = extractModelRuntimeMetadata("plain log output", "gpt-5.6-luna");
  assert.equal(result.resolvedModel, null);
  assert.equal(result.modelRevision, null);
  assert.equal(result.systemFingerprint, null);
});

test("extractModelRuntimeMetadata rejects ambiguous empty-tree git hashes as model revisions", () => {
  const result = extractModelRuntimeMetadata(
    JSON.stringify({ type: "step_finish", revision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }),
    "opencode-go/deepseek-v4-flash"
  );
  assert.equal(result.modelRevision, null);
});

test("extractModelRuntimeMetadata ignores OpenCode workspace snapshots", () => {
  const result = extractModelRuntimeMetadata(
    JSON.stringify({ type: "step_finish", part: { snapshot: "acb9f87b87329f0a53c947bddf238c061d9edfcc" } }),
    "opencode-go/deepseek-v4-flash"
  );
  assert.equal(result.modelRevision, null);
});
