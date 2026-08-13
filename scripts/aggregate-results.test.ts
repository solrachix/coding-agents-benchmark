import test from "node:test";
import assert from "node:assert/strict";
import { aggregateExecutions } from "./aggregate-results.js";

test("aggregateExecutions calculates distribution, reliability and efficiency", () => {
  const result = aggregateExecutions([
    { key: "flash-max", score: 100, structuralScore: 100, functionalScore: 35, functionalMax: 35, duration: 10, cost: 1 },
    { key: "flash-max", score: 90, structuralScore: 90, functionalScore: 35, functionalMax: 35, duration: 20, cost: 3 },
    { key: "flash-max", score: 80, structuralScore: 80, functionalScore: 30, functionalMax: 35, duration: 30, cost: 2 },
    { key: "flash-max", score: null, structuralScore: 60, scoreStatus: "ui_unverified", duration: 40 },
  ])[0];

  assert.equal(result.runs, 4);
  assert.equal(result.successes, 3);
  assert.equal(result.mean, 90);
  assert.equal(result.median, 90);
  assert.equal(result.minimum, 80);
  assert.equal(result.maximum, 100);
  assert.equal(result.range, 20);
  assert.equal(result.p25, 85);
  assert.equal(result.p75, 95);
  assert.equal(result.iqr, 10);
  assert.equal(result.standardDeviation, 8.16);
  assert.equal(result.coefficientOfVariation, 9.07);
  assert.equal(result.successRate, 75);
  assert.equal(result.harnessFailures, 0);
  assert.equal(result.evaluatorErrors, 0);
  assert.equal(result.uiUnverified, 1);
  assert.equal(result.functionalFailures, 1);
  assert.equal(result.catastrophicModelFailures, 0);
  assert.equal(result.meanDuration, 25);
  assert.equal(result.meanCost, 2);
  assert.equal(result.meanScorePerMinute, 343.33);
  assert.equal(result.meanScorePerDollar, 56.67);
});

test("aggregateExecutions separates evaluator errors from functional model failures", () => {
  const [result] = aggregateExecutions([
    { key: "flash", score: null, functionalScore: 0, functionalMax: 35, functionalStatus: "evaluator_error", duration: 10 },
    { key: "flash", score: 60, functionalScore: 20, functionalMax: 35, functionalStatus: "failed", duration: 10 },
  ]);
  assert.equal(result.evaluatorErrors, 1);
  assert.equal(result.functionalFailures, 1);
});

test("aggregateExecutions keeps configurations separate", () => {
  const result = aggregateExecutions([
    { key: "flash-max", score: 100, duration: 10 },
    { key: "luna-xhigh", score: 95, duration: 12 },
  ]);

  assert.deepEqual(result.map((item) => item.key), ["flash-max", "luna-xhigh"]);
});
