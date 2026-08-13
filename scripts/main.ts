import { join } from "node:path";
import { generateReport } from "./generate-report.js";
import { archiveCurrentReports, archiveCurrentResults, CampaignAbortError, createExecutionId, loadJson, saveJson, RESULTS_DIR, ensureDir, runWithConcurrency } from "./utils.js";
import { runOpenCode } from "./run-opencode.js";
import { runCodex } from "./run-codex.js";
import { preflightCopilot, runCopilot } from "./run-copilot.js";
import type { ModelsConfig, BenchmarkConfig, ModelConfig } from "./utils.js";
import { captureEnvironment } from "./environment.js";

function parseArgs(argv: string[]): { benchmark?: string; engine?: string; model?: string; dryRun?: boolean; noArchive?: boolean; seed?: number; concurrency: number } {
  const args = argv.slice(2);
  const result: ReturnType<typeof parseArgs> = { concurrency: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--benchmark" && args[i + 1]) result.benchmark = args[i + 1];
    if (args[i] === "--engine" && args[i + 1]) result.engine = args[i + 1];
    if (args[i] === "--model" && args[i + 1]) result.model = args[i + 1];
    if (args[i] === "--seed" && args[i + 1]) result.seed = Number(args[i + 1]);
    if (args[i] === "--dry-run") result.dryRun = true;
    if (args[i] === "--no-archive") result.noArchive = true;
    if (args[i] === "--concurrency" && args[i + 1]) result.concurrency = Math.max(1, Number.parseInt(args[i + 1], 10) || 1);
  }
  return result;
}

interface PlannedRun {
  benchmark: string;
  engine: "opencode" | "codex" | "copilot";
  config: ModelConfig;
  round: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle<T>(values: T[], seed: number): T[] {
  const result = [...values];
  const random = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildPlan(models: ModelsConfig, config: BenchmarkConfig, args: ReturnType<typeof parseArgs>): PlannedRun[] {
  const benchmarks = args.benchmark ? [args.benchmark] : ["greenfield", "bugfix", "frontend-challenge"];
  const planned: PlannedRun[] = [];
  for (const benchmark of benchmarks) {
    if (!args.engine || args.engine === "opencode") {
      for (const model of models.opencode) {
        if (!model.enabled || (args.model && model.id !== args.model)) continue;
        for (let round = 1; round <= config.rounds; round++) planned.push({ benchmark, engine: "opencode", config: model, round });
      }
    }
    if (!args.engine || args.engine === "codex") {
      for (const model of models.codex) {
        if (!model.enabled || (args.model && model.id !== args.model)) continue;
        for (let round = 1; round <= config.rounds; round++) planned.push({ benchmark, engine: "codex", config: model, round });
      }
    }
    if (!args.engine || args.engine === "copilot") {
      for (const model of models.copilot) {
        if (!model.enabled || (args.model && model.id !== args.model)) continue;
        for (let round = 1; round <= config.rounds; round++) planned.push({ benchmark, engine: "copilot", config: model, round });
      }
    }
  }
  return planned;
}

async function main() {
  const args = parseArgs(process.argv);
  const models = await loadJson<ModelsConfig>(join(import.meta.dirname, "../config/models.json"));
  const config = await loadJson<BenchmarkConfig>(join(import.meta.dirname, "../config/benchmark.json"));
  let planned = buildPlan(models, config, args);

  if (planned.length === 0) {
    console.log("No enabled model matched the requested filters.");
    return;
  }

  const executionId = createExecutionId();
  const environment = await captureEnvironment(config.nodeVersion);
  const seed = Number.isFinite(args.seed) ? args.seed! : (config.campaignSeed ?? Number.parseInt(executionId.slice(-8), 16));
  if (config.shuffleRuns !== false) planned = shuffle(planned, seed);

  if (args.dryRun) {
    console.log("\n=== DRY RUN ===");
    console.log(`Would execute ${planned.length} run(s), seed=${seed}, concurrency=${args.concurrency}:\n`);
    console.log(`Environment: Node ${environment.node}, npm ${environment.npm}, ${environment.platform}/${environment.arch}, ${environment.cpuModel} x${environment.cpuCount}\n`);
    for (const p of planned) console.log(`  ${p.benchmark} | ${p.engine} | ${p.config.id} [${p.config.reasoningEffort ?? "default"}] | round ${p.round}`);
    console.log("\nNo credits will be spent.");
    return;
  }

  if (planned.some((run) => run.engine === "copilot")) {
    const preflight = await preflightCopilot();
    if (!preflight.allowed) {
      console.error(`Copilot preflight blocked the campaign: ${preflight.reason ?? "quota unavailable"}${preflight.resetDate ? `; reset=${preflight.resetDate}` : ""}`);
      process.exitCode = 2;
      return;
    }
  }

  const archivedResults = args.noArchive ? [] : await archiveCurrentResults(executionId);
  const archivedReports = args.noArchive ? [] : await archiveCurrentReports(executionId);
  if (archivedResults.length > 0) console.log(`Previous results archived under results/archive/${executionId}/`);
  if (archivedReports.length > 0) console.log(`Previous report archived under reports/archive/${executionId}/`);
  console.log(`Execution ID: ${executionId}`);
  console.log(`Campaign seed: ${seed}${config.shuffleRuns === false ? " (shuffle disabled)" : ""}`);
  console.log(`Concurrency: ${args.concurrency}`);
  ensureDir(RESULTS_DIR);
  await saveJson(join(RESULTS_DIR, "environment.json"), environment);
  await saveJson(join(RESULTS_DIR, "campaign.json"), {
    executionId,
    seed,
    concurrency: args.concurrency,
    shuffled: config.shuffleRuns !== false,
    environment,
    runs: planned.map((p) => ({ benchmark: p.benchmark, engine: p.engine, model: p.config.id, effort: p.config.reasoningEffort, round: p.round })),
  });

  try {
    await runWithConcurrency(planned, args.concurrency, async (run) => {
      try {
        if (run.engine === "opencode") await runOpenCode(run.benchmark, run.config, run.round, config, executionId);
        else if (run.engine === "codex") await runCodex(run.benchmark, run.config, run.round, config, executionId);
        else await runCopilot(run.benchmark, run.config, run.round, config, executionId);
      } catch (err) {
        console.error(`[${run.engine}] ${run.config.id} round ${run.round} failed:`, err);
        if (err instanceof CampaignAbortError) throw err;
      }
    });
  } catch (error) {
    if (error instanceof CampaignAbortError) {
      console.error(`Campaign stopped early: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  await generateReport(executionId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
