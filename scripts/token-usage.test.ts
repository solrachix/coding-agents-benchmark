import test from "node:test";
import assert from "node:assert/strict";
import { parseTokenUsage, copilotMetricsToTokenUsage } from "./token-usage.js";

test("copilot metrics preserve AI credits and aggregate model tokens", () => {
  assert.deepEqual(copilotMetricsToTokenUsage({
    totalNanoAiu: 8_740_000_000,
    totalPremiumRequestCost: 4.5,
    modelMetrics: {
      "gpt-5.6-luna": {
        totalNanoAiu: 8_740_000_000,
        usage: { inputTokens: 27_302, outputTokens: 7_004 },
      },
    },
  }), {
    source: "copilot_sdk",
    totalTokens: 34_306,
    inputTokens: 27_302,
    outputTokens: 7_004,
    aiCredits: 8.74,
    premiumRequestCost: 4.5,
    modelMetrics: {
      "gpt-5.6-luna": {
        inputTokens: 27_302,
        outputTokens: 7_004,
        aiCredits: 8.74,
      },
    },
  });
});

test("parseTokenUsage aggregates OpenCode step usage and cost", () => {
  const log = [
    JSON.stringify({ type: "step_finish", sessionID: "session-1", part: { tokens: { total: 100, input: 70, output: 20, reasoning: 10, cache: { read: 5, write: 2 } }, cost: 0.01 } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { total: 50, input: 30, output: 15, reasoning: 5, cache: { read: 8, write: 0 } }, cost: 0.02 } }),
  ].join("\n");

  assert.deepEqual(parseTokenUsage(log, "opencode"), {
    source: "opencode_json",
    sessionId: "session-1",
    totalTokens: 150,
    inputTokens: 100,
    outputTokens: 35,
    reasoningTokens: 15,
    cacheReadTokens: 13,
    cacheWriteTokens: 2,
    cost: 0.03,
  });
});

test("parseTokenUsage reads the Codex summary token count", () => {
  assert.deepEqual(parseTokenUsage("hook: Stop\ntokens used\n49.576\n", "codex"), {
    source: "codex_summary",
    totalTokens: 49576,
  });
});

test("parseTokenUsage reports unavailable data without inventing a breakdown", () => {
  assert.deepEqual(parseTokenUsage("agent failed before usage was emitted", "codex"), {
    source: "unavailable",
  });
});
