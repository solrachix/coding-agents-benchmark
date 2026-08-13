import test from "node:test";
import assert from "node:assert/strict";
import { frontendScoreFromChecks, applyFrontendGates, detectFrontendGaming, searchTermForTitle, filterInteractionPassed } from "./frontend-challenge.js";

test("frontend challenge perfect checks score 100", () => {
  const score = frontendScoreFromChecks({ visual: 25, responsive: 15, e2e: 20, accessibility: 10, interactions: 10, architecture: 10, validation: 10 });
  assert.equal(score, 100);
});

test("frontend challenge gates build failure and weak e2e", () => {
  assert.equal(applyFrontendGates(95, { buildPassed: false, pageLoaded: true, e2e: 20, mobileBroken: false }), 69);
  assert.equal(applyFrontendGates(95, { buildPassed: true, pageLoaded: true, e2e: 9, mobileBroken: false }), 69);
  assert.equal(applyFrontendGates(95, { buildPassed: true, pageLoaded: true, e2e: 20, mobileBroken: true }), 79);
});

test("frontend challenge detects screenshot-only implementations without rejecting legitimate absolute positioning", () => {
  assert.equal(detectFrontendGaming("<img src=\"reference.png\" />", 1), 25);
  assert.equal(detectFrontendGaming("<div style={{position: 'absolute'}}>badge</div>", 12), 0);
});

test("frontend E2E derives a search term from the candidate's own first card", () => {
  assert.equal(searchTermForTitle("Designing for tomorrow"), "Designing");
  assert.equal(searchTermForTitle("AI"), "AI");
  assert.equal(searchTermForTitle(""), null);
});

test("frontend filter interaction accepts a changed result or an explicitly pressed filter", () => {
  assert.equal(filterInteractionPassed({ beforeCount: 6, afterCount: 2, pressed: true }), true);
  assert.equal(filterInteractionPassed({ beforeCount: 6, afterCount: 6, pressed: true }), true);
  assert.equal(filterInteractionPassed({ beforeCount: 6, afterCount: 6, pressed: false }), false);
});
