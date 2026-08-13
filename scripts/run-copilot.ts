import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  cleanDir, getResultDir, ensureDir, saveJson, maskSecrets, copyFixture,
  FIXTURES_DIR, PROMPTS_DIR, parseModelId, validateWorkspacePath,
  detectHarnessError, classifyProcessFailure, projectHasManifest,
  formatDuration, hashText, initializeIsolatedGit, ROOT,
  CampaignAbortError,
} from "./utils.js";
import { validateProject, saveValidationLog } from "./validate-project.js";
import { computeScore, saveScore, generateManualReviewTemplate } from "./score-results.js";
import { detectPenalties } from "./penalties.js";
import { captureVisual } from "./visual-validation.js";
import { runUiFunctionalEvaluator } from "./ui-functional-evaluator.js";
import { captureProjectMetadata } from "./project-metadata.js";
import { copilotMetricsToTokenUsage, type TokenUsage } from "./token-usage.js";
import type { BenchmarkConfig, ModelConfig } from "./utils.js";
import { buildBenchmarkPrompt } from "./prompt.js";
import type { ModelRuntimeMetadata } from "./model-metadata.js";

type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
type QuotaSnapshot = {
  isUnlimitedEntitlement: boolean;
  entitlementRequests?: number;
  usedRequests?: number;
  usageAllowedWithExhaustedQuota: boolean;
  remainingPercentage: number;
  overage?: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
};

export function inspectCopilotQuota(result: { quotaSnapshots: Record<string, QuotaSnapshot | undefined> }): { allowed: boolean; reason?: string; resetDate?: string } {
  for (const key of ["premium_interactions", "chat"]) {
    const quota = result.quotaSnapshots[key];
    if (!quota || quota.isUnlimitedEntitlement || quota.remainingPercentage > 0) continue;
    if (quota.usageAllowedWithExhaustedQuota || quota.overageAllowedWithExhaustedQuota) continue;
    return { allowed: false, reason: `${key} quota exhausted`, ...(quota.resetDate ? { resetDate: quota.resetDate } : {}) };
  }
  return { allowed: true };
}

export function isFatalCopilotHarnessError(errorType: string | undefined): boolean {
  return errorType === "provider_credits" || errorType === "authentication_expired";
}

export function createCopilotClientOptions<T>(connection: T): { connection: T } {
  return { connection };
}
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function copilotCreditsToUsd(aiCredits: number | undefined): number | null {
  return aiCredits === undefined ? null : Math.round(aiCredits * 0.01 * 1e8) / 1e8;
}

export function resolveCopilotCliPath(): string | null {
  const candidates = [
    process.env.COPILOT_CLI_PATH,
    (() => { try { return execFileSync("which", ["copilot"], { encoding: "utf8" }).trim(); } catch { return ""; } })(),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function preflightCopilot(): Promise<{ allowed: boolean; reason?: string; resetDate?: string }> {
  const sdk = await import("@github/copilot-sdk");
  const cliPath = resolveCopilotCliPath();
  if (!cliPath) return { allowed: false, reason: "Copilot CLI not found" };
  const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: cliPath }) });
  try {
    await client.start();
    return inspectCopilotQuota(await client.rpc.account.getQuota({}));
  } catch (error) {
    return { allowed: false, reason: `Copilot preflight failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function resolveReasoningEffort(client: { rpc: { models: { list(params: Record<string, never>): Promise<{ models: Array<{ id: string; supportedReasoningEfforts?: string[] }> }> } } }, model: string, requested: CopilotReasoningEffort | undefined): Promise<CopilotReasoningEffort | undefined> {
  if (!requested) return undefined;
  try {
    const catalog = await client.rpc.models.list({});
    const entry = catalog.models.find((candidate) => candidate.id === model);
    return entry?.supportedReasoningEfforts?.includes(requested) ? requested : undefined;
  } catch {
    // A catalog failure must not make a valid model run fail; let the runtime use its default.
    return undefined;
  }
}

function modelRuntime(requestedModel: string, metrics: Record<string, unknown>): ModelRuntimeMetadata {
  const modelIds = Object.keys((metrics.modelMetrics ?? {}) as Record<string, unknown>);
  return {
    requestedModel,
    resolvedModel: modelIds.length === 1 ? modelIds[0] : null,
    modelRevision: null,
    systemFingerprint: null,
    observedModelIds: modelIds,
    evidence: modelIds.length ? ["session.rpc.usage.getMetrics().modelMetrics"] : [],
  };
}

function copilotVersions(cliPath: string): { copilotCliVersion: string | null; copilotSdkVersion: string | null } {
  let copilotCliVersion: string | null = null;
  try { copilotCliVersion = execFileSync(cliPath, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(); } catch {}
  let copilotSdkVersion: string | null = null;
  try {
    const packageJson = readFileSync(join(ROOT, "node_modules/@github/copilot-sdk/package.json"), "utf8");
    copilotSdkVersion = (JSON.parse(packageJson) as { version?: string }).version ?? null;
  } catch {}
  return { copilotCliVersion, copilotSdkVersion };
}

export async function runCopilot(
  benchmark: string,
  modelConfig: ModelConfig,
  round: number,
  config: BenchmarkConfig,
  executionId: string,
): Promise<void> {
  const model = modelConfig.id;
  const reasoningEffort = modelConfig.reasoningEffort === "minimal" ? undefined : modelConfig.reasoningEffort;
  const resultDir = getResultDir(benchmark, "copilot-sdk", model, round, modelConfig.reasoningEffort, executionId);
  const projectDir = join(resultDir, "project");
  validateWorkspacePath(projectDir, ROOT);
  validateWorkspacePath(resultDir, ROOT);
  cleanDir(projectDir);
  ensureDir(resultDir);
  const prompt = await buildBenchmarkPrompt(join(PROMPTS_DIR, `${benchmark}.md`));
  let fixtureDir: string | null = null;
  if (benchmark === "bugfix") {
    fixtureDir = join(FIXTURES_DIR, "bugfix-app");
    copyFixture(fixtureDir, projectDir);
  }
  const isolatedGit = initializeIsolatedGit(projectDir);
  const startedAt = new Date().toISOString();
  const totalStartTime = Date.now();
  let agentDurationSeconds = 0;
  let output = "";
  let exitCode = 0;
  let appliedReasoningEffort: CopilotReasoningEffort | undefined;
  let usage: TokenUsage = { source: "unavailable" };
  let runtime: ModelRuntimeMetadata = {
    requestedModel: model, resolvedModel: null, modelRevision: null,
    systemFingerprint: null, observedModelIds: [], evidence: [],
  };

  try {
    const sdk = await import("@github/copilot-sdk");
    const cliPath = resolveCopilotCliPath();
    if (!cliPath) throw new Error("Copilot CLI not found. Set COPILOT_CLI_PATH or install copilot.");
    const client = new sdk.CopilotClient(createCopilotClientOptions(
      sdk.RuntimeConnection.forStdio({ path: cliPath }),
    ));
    const versions = copilotVersions(cliPath);
    let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
    try {
      await client.start();
      appliedReasoningEffort = await resolveReasoningEffort(client, model, reasoningEffort);
      session = await client.createSession({
        model,
        reasoningEffort: appliedReasoningEffort,
        streaming: false,
        onPermissionRequest: sdk.approveAll,
        workingDirectory: projectDir,
      });
      const agentStart = Date.now();
      const response = await session.sendAndWait({ prompt }, config.timeoutMinutes * 60_000);
      agentDurationSeconds = formatDuration(Date.now() - agentStart);
      output = JSON.stringify({ response }, null, 2);
      try {
        const metrics = await session.rpc.usage.getMetrics() as unknown as Record<string, unknown>;
        output = JSON.stringify({ response, metrics }, null, 2);
        usage = copilotMetricsToTokenUsage(metrics as unknown as Parameters<typeof copilotMetricsToTokenUsage>[0]);
        runtime = modelRuntime(model, metrics);
      } catch (error) {
        output += `\n\nUsage metrics unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
      runtime.copilotCliVersion = versions.copilotCliVersion;
      runtime.copilotSdkVersion = versions.copilotSdkVersion;
    } finally {
      await session?.disconnect().catch(() => undefined);
      await client.stop().catch(() => undefined);
    }
  } catch (error) {
    exitCode = 1;
    output = `Copilot SDK error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  }

  await writeFile(join(resultDir, "raw.log"), maskSecrets(output), "utf-8");
  await saveJson(join(resultDir, "usage.json"), usage);
  await saveJson(join(resultDir, "model-runtime.json"), runtime);
  let harnessErrorInfo = classifyProcessFailure(exitCode, detectHarnessError(output));
  if (!harnessErrorInfo.harnessError && !projectHasManifest(projectDir)) {
    harnessErrorInfo = { harnessError: true, harnessErrorType: "empty_project" };
  }
  if (isFatalCopilotHarnessError(harnessErrorInfo.harnessErrorType)) {
    throw new CampaignAbortError(
      harnessErrorInfo.harnessErrorType!,
      `Copilot campaign aborted after ${harnessErrorInfo.harnessErrorType}: ${output.split("\n")[0]}`,
    );
  }
  const { provider, model: modelName } = parseModelId(model);
  const validationStart = Date.now();
  const validation = await validateProject(projectDir, config.timeoutMinutes, config.validations, benchmark);
  const validationDurationSeconds = formatDuration(Date.now() - validationStart);
  await saveValidationLog(projectDir, validation);
  const uiFunctional = config.uiFunctional?.enabled === false
    ? { enabled: false, status: "skipped" as const, passedChecks: 0, totalChecks: 0, score: 0, maxScore: benchmark === "greenfield" ? 15 : 0, reason: "disabled_in_config", output: "UI evaluator disabled in config." }
    : await runUiFunctionalEvaluator(projectDir, resultDir, benchmark, (config.uiFunctional?.timeoutSeconds ?? 90) * 1000);
  await saveJson(join(resultDir, "ui-functional.json"), uiFunctional);
  const visual = await captureVisual(projectDir, resultDir, benchmark, config.visual);
  await saveJson(join(resultDir, "visual.json"), visual);
  const penalties = detectPenalties(projectDir, fixtureDir, benchmark);
  const projectMetadata = await captureProjectMetadata(projectDir);
  await saveJson(join(resultDir, "project-metadata.json"), projectMetadata);
  const score = await computeScore(validation, penalties, { projectDir, benchmark, harnessError: harnessErrorInfo.harnessError, ui: uiFunctional });
  await saveScore(resultDir, score);
  await generateManualReviewTemplate(resultDir, score);
  const totalDurationSeconds = formatDuration(Date.now() - totalStartTime);
  await saveJson(join(resultDir, "meta.json"), {
    benchmark, harness: "copilot-sdk", provider: "github-copilot", model: modelName,
    reasoningEffort: (typeof appliedReasoningEffort === "undefined" ? "default" : appliedReasoningEffort),
    requestedReasoningEffort: modelConfig.reasoningEffort,
    rubricVersion: score.rubricVersion,
    scoreStatus: score.scoreStatus, round, startedAt, finishedAt: new Date().toISOString(),
    agentDurationSeconds, installDurationSeconds: validation.installDurationSeconds,
    validationDurationSeconds, totalDurationSeconds, visualStatus: visual.status,
    visualScreenshotCount: visual.screenshots.length, uiFunctionalStatus: uiFunctional.status,
    functionalStatus: validation.functional.status, functionalReason: validation.functional.reason,
    uiFunctionalScore: uiFunctional.score, modelRuntime: runtime, projectMetadata,
    executionId, promptHash: hashText(prompt), usage, exitCode, isolatedGit,
    copilotCliVersion: runtime.copilotCliVersion ?? null,
    copilotSdkVersion: runtime.copilotSdkVersion ?? null,
    ...(harnessErrorInfo.harnessError ? { harnessError: true, harnessErrorType: harnessErrorInfo.harnessErrorType } : {}),
  });
  console.log(`[copilot-sdk] ${model} (${modelConfig.reasoningEffort ?? "default"}) round ${round} done. Exit: ${exitCode}. Score: ${score.total}`);
}
