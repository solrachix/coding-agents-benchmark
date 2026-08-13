import test from "node:test";
import assert from "node:assert/strict";
import { effectiveScore, shouldIncludeExecution } from "./generate-report.js";

test("report filtering keeps only the selected campaign when an execution id is provided", () => {
  assert.equal(shouldIncludeExecution("run-1", "run-1"), true);
  assert.equal(shouldIncludeExecution("run-2", "run-1"), false);
  assert.equal(shouldIncludeExecution(undefined, "run-1"), false);
  assert.equal(shouldIncludeExecution("run-1", undefined), true);
});

test("effective score accepts only a clean, unchanged valid reevaluation", () => {
  const base = { score: null, reevaluatedScore: 100, reevaluation: { reevaluatedScoreStatus: "valid", projectUnchanged: true, preserveOfficialScore: true } } as const;
  assert.equal(effectiveScore(base), 100);
  assert.equal(effectiveScore({ ...base, reevaluation: { ...base.reevaluation, projectUnchanged: false } }), null);
  assert.equal(effectiveScore({ ...base, reevaluation: { ...base.reevaluation, preserveOfficialScore: false } }), null);
  assert.equal(effectiveScore({ score: 89, reevaluatedScore: 100, reevaluation: undefined }), 89);
});
