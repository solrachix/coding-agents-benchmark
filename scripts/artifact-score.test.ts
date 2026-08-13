import test from "node:test";
import assert from "node:assert/strict";
import { reportableScores } from "./score-results.js";

test("reportableScores preserves artifact score when the run timed out", () => {
  assert.deepEqual(reportableScores({ total: 100, artifactScore: 100, scoreStatus: "harness_failed" }), {
    artifactScore: 100,
    officialScore: null,
    status: "harness_failed",
  });
});
