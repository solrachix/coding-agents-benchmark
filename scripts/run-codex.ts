import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  cleanDir,
  getResultDir,
  ensureDir,
  saveJson,
  maskSecrets,
  copyFixture,
  FIXTURES_DIR,
  PROMPTS_DIR,
  parseModelId,
  validateWorkspacePath,
  detectHarnessError,
  classifyProcessFailure,
  projectHasManifest,
  formatDuration,
  commandExists,
  hashText,
  initializeIsolatedGit,
  runCommand,
  ROOT,
} from "./utils.js";
import { runHarnessProcess } from "./harness.js";
import { validateProject, saveValidationLog } from "./validate-project.js";
import { computeScore, saveScore, generateManualReviewTemplate } from "./score-results.js";
import { detectPenalties } from "./penalties.js";
import { captureVisual } from "./visual-validation.js";
import { runUiFunctionalEvaluator } from "./ui-functional-evaluator.js";
import { extractModelRuntimeMetadata } from "./model-metadata.js";
import { captureProjectMetadata } from "./project-metadata.js";
import { parseTokenUsage } from "./token-usage.js";
import type { BenchmarkConfig, ModelConfig } from "./utils.js";
import { buildBenchmarkPrompt } from "./prompt.js";
import { runFrontendChallengeEvaluator } from "./frontend-challenge.js";

export async function runCodex(
  benchmark: string,
  modelConfig: ModelConfig,
  round: number,
  config: BenchmarkConfig,
  executionId: string
): Promise<void> {
  const model = modelConfig.id;
  const resultDir = getResultDir(benchmark, "codex", model, round, modelConfig.reasoningEffort, executionId);
  const projectDir = join(resultDir, "project");
  // Validate paths
  validateWorkspacePath(projectDir, ROOT);
  validateWorkspacePath(resultDir, ROOT);
  cleanDir(projectDir);
  ensureDir(resultDir);

  const promptPath = join(PROMPTS_DIR, `${benchmark}.md`);
  const prompt = await buildBenchmarkPrompt(promptPath);

  let fixtureDir: string | null = null;
  if (benchmark === "bugfix" || benchmark === "frontend-challenge") {
    fixtureDir = join(FIXTURES_DIR, benchmark === "bugfix" ? "bugfix-app" : "frontend-challenge");
    copyFixture(fixtureDir, projectDir);
  }

  const isolatedGit = initializeIsolatedGit(projectDir);

  const { provider, model: modelName } = parseModelId(model);

  // Check if codex CLI is available
  if (!commandExists("codex")) {
    console.error("[codex] CLI not found. Skipping. Install with: npm install -g @openai/codex");
    const meta = {
      benchmark,
      harness: "codex",
      provider,
      model: modelName,
      round,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      agentDurationSeconds: 0,
      installDurationSeconds: 0,
      validationDurationSeconds: 0,
      totalDurationSeconds: 0,
      exitCode: 127,
      harnessError: true,
      harnessErrorType: "codex_cli_not_found",
    };
    await saveJson(join(resultDir, "meta.json"), meta);
    await writeFile(
      join(resultDir, "raw.log"),
      "Error: codex CLI not found in PATH. Install with: npm install -g @openai/codex\n",
      "utf-8"
    );
    return;
  }

  const startedAt = new Date().toISOString();
  const args = ["exec", "-m", model];
  if (modelConfig.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${modelConfig.reasoningEffort}`);
  }
  args.push(prompt);

  const version = await runCommand("codex", ["--version"], projectDir, { timeout: 10_000 });
  const harnessVersion = (version.stdout + version.stderr).trim().split("\n").pop() ?? "unknown";
  const promptHash = hashText(prompt);

  const timeout = config.timeoutMinutes * 60 * 1000;
  const totalStartTime = Date.now();
  const result = await runHarnessProcess("codex", args, projectDir, timeout);
  const agentDurationSeconds = result.durationSeconds;

  await writeFile(join(resultDir, "raw.log"), maskSecrets(result.stdout + "\n" + result.stderr), "utf-8");
  const usage = parseTokenUsage(result.stdout + "\n" + result.stderr, "codex");
  await saveJson(join(resultDir, "usage.json"), usage);
  const modelRuntime = extractModelRuntimeMetadata(result.stdout + "\n" + result.stderr, model);
  await saveJson(join(resultDir, "model-runtime.json"), modelRuntime);

  const harnessErrorInfo = classifyProcessFailure(
    result.exitCode,
    detectHarnessError(result.stdout + result.stderr),
    { timedOut: result.timedOut, signal: result.signal }
  );
  if (!harnessErrorInfo.harnessError && !projectHasManifest(projectDir)) {
    harnessErrorInfo.harnessError = true;
    harnessErrorInfo.harnessErrorType = "empty_project";
  }

  // Validation
  const validationStart = Date.now();
  const validation = await validateProject(projectDir, config.timeoutMinutes, config.validations, benchmark);
  const validationDurationSeconds = formatDuration(Date.now() - validationStart);

  await saveValidationLog(projectDir, validation);

  const frontend = benchmark === "frontend-challenge" ? await runFrontendChallengeEvaluator(projectDir, resultDir, validation, (config.visual?.timeoutSeconds ?? 45) * 1000) : undefined;
  if (frontend) await saveJson(join(resultDir, "frontend-challenge.json"), frontend);

  const uiFunctional = config.uiFunctional?.enabled === false
    ? { enabled: false, status: "skipped" as const, passedChecks: 0, totalChecks: 0, score: 0, maxScore: benchmark === "greenfield" ? 15 : 0, reason: "disabled_in_config", output: "UI evaluator disabled in config." }
    : await runUiFunctionalEvaluator(projectDir, resultDir, benchmark, (config.uiFunctional?.timeoutSeconds ?? 90) * 1000);
  await saveJson(join(resultDir, "ui-functional.json"), uiFunctional);

  const visual = await captureVisual(projectDir, resultDir, benchmark, config.visual);
  await saveJson(join(resultDir, "visual.json"), visual);

  const totalDurationSeconds = formatDuration(Date.now() - totalStartTime);
  const installDurationSeconds = validation.installDurationSeconds;

  // Penalties
  const penalties = detectPenalties(projectDir, fixtureDir, benchmark);
  const projectMetadata = await captureProjectMetadata(projectDir);
  await saveJson(join(resultDir, "project-metadata.json"), projectMetadata);

  // Score
  const score = await computeScore(validation, penalties, {
    projectDir,
    benchmark,
    harnessError: harnessErrorInfo.harnessError,
    ui: uiFunctional,
    frontend,
  });
  await saveScore(resultDir, score);
  await generateManualReviewTemplate(resultDir, score);

  const meta = {
    benchmark,
    harness: "codex",
    provider,
    model: modelName,
    reasoningEffort: modelConfig.reasoningEffort,
    rubricVersion: score.rubricVersion,
    scoreStatus: score.scoreStatus,
    round,
    startedAt,
    finishedAt: new Date().toISOString(),
    agentDurationSeconds,
    installDurationSeconds,
    validationDurationSeconds,
    totalDurationSeconds,
    visualStatus: visual.status,
    visualScreenshotCount: visual.screenshots.length,
    uiFunctionalStatus: uiFunctional.status,
    functionalStatus: validation.functional.status,
    functionalReason: validation.functional.reason,
    uiFunctionalScore: uiFunctional.score,
    modelRuntime,
    projectMetadata,
    executionId,
    promptHash,
    harnessVersion,
    isolatedGit,
    usage,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    signal: result.signal,
    ...(harnessErrorInfo.harnessError ? {
      harnessError: true,
      harnessErrorType: harnessErrorInfo.harnessErrorType,
    } : {}),
  };
  await saveJson(join(resultDir, "meta.json"), meta);

  console.log(`[codex] ${model} (${modelConfig.reasoningEffort ?? "default"}) round ${round} done. Exit: ${result.exitCode}. Score: ${score.total}`);
}
