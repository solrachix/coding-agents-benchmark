import test from "node:test";
import assert from "node:assert/strict";
import { getScoreStatus } from "./score-results.js";

const ui = (status: "passed" | "failed" | "skipped") => ({
  enabled: true,
  status,
  passedChecks: status === "passed" ? 6 : 0,
  totalChecks: 6,
  score: status === "passed" ? 15 : 0,
  maxScore: 15,
  output: "",
});

test("greenfield requires a verifiable UI environment, but a real UI failure remains a scored model failure", () => {
  assert.equal(getScoreStatus(false, "greenfield", ui("passed")), "valid");
  assert.equal(getScoreStatus(false, "greenfield", ui("failed")), "valid");
  assert.equal(getScoreStatus(false, "greenfield", ui("skipped")), "ui_unverified");
  assert.equal(getScoreStatus(true, "greenfield", ui("passed")), "harness_failed");
});

test("bugfix does not require the greenfield UI evaluator", () => {
  assert.equal(getScoreStatus(false, "bugfix"), "valid");
});

test("evaluator errors are distinct from functional model failures", () => {
  assert.equal(getScoreStatus(false, "bugfix", undefined, "failed"), "valid");
  assert.equal(getScoreStatus(false, "bugfix", undefined, "evaluator_error"), "evaluator_error");
});
