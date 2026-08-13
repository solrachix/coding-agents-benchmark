import test from "node:test";
import assert from "node:assert/strict";
import { copilotCreditsToUsd, createCopilotClientOptions, inspectCopilotQuota, isFatalCopilotHarnessError, resolveCopilotCliPath } from "./run-copilot.js";

test("Copilot AI credits remain separate from USD", () => {
  assert.equal(copilotCreditsToUsd(8.74), 0.0874);
  assert.equal(copilotCreditsToUsd(undefined), null);
});

test("Copilot harness resolves an installed CLI path", () => {
  const path = resolveCopilotCliPath();
  assert.ok(path === null || path.endsWith("copilot") || path.endsWith("index.js"));
});

test("Copilot preflight rejects exhausted premium quota before model runs", () => {
  assert.deepEqual(inspectCopilotQuota({
    quotaSnapshots: {
      premium_interactions: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 300,
        usedRequests: 300,
        usageAllowedWithExhaustedQuota: false,
        remainingPercentage: 0,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: "2026-09-01T00:00:00Z",
      },
    },
  }), {
    allowed: false,
    reason: "premium_interactions quota exhausted",
    resetDate: "2026-09-01T00:00:00Z",
  });
});

test("Copilot quota rejection aborts the remaining campaign", () => {
  assert.equal(isFatalCopilotHarnessError("provider_credits"), true);
  assert.equal(isFatalCopilotHarnessError("authentication_expired"), true);
  assert.equal(isFatalCopilotHarnessError("agent_timeout"), false);
  assert.equal(isFatalCopilotHarnessError(undefined), false);
});

test("Copilot SDK uses the CLI authentication instead of a per-result home", () => {
  assert.deepEqual(createCopilotClientOptions("shared-stdio-connection"), {
    connection: "shared-stdio-connection",
  });
});
