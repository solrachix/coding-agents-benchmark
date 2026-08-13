import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { readdir, readFile, stat, writeFile, copyFile } from "node:fs/promises";
import { computeScore, loadMeta, loadScore, type Meta, type Score } from "./score-results.js";
import { detectPenalties } from "./penalties.js";
import { validateProject, type ValidationResult } from "./validate-project.js";
import { runUiFunctionalEvaluator, type UiFunctionalValidation } from "./ui-functional-evaluator.js";
import { saveJson, runWithConcurrency, RESULTS_DIR, FIXTURES_DIR, ensureDir } from "./utils.js";

const IGNORED_DIRS = new Set(["node_modules", ".next", ".benchmark-evaluator", ".git", "coverage", "dist", "generated", ".prisma"]);

export async function snapshotProject(projectDir: string): Promise<{
  hash: string;
  files: Map<string, string>;
  changedFilesComparedTo: (before: { files: Map<string, string> }) => string[];
}> {
  const files = new Map<string, string>();
  async function visit(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relativePath = relative(projectDir, fullPath);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && !/\.(db|db-journal|db-shm|db-wal)$/.test(entry.name)) {
        files.set(relativePath, createHash("sha256").update(await readFile(fullPath)).digest("hex"));
      }
    }
  }
  await visit(resolve(projectDir));
  const hash = createHash("sha256");
  for (const [relativePath, contentHash] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(contentHash);
    hash.update("\0");
  }
  return {
    hash: hash.digest("hex"),
    files,
    changedFilesComparedTo(before) {
      return [...new Set([...before.files.keys(), ...files.keys()])]
        .filter((path) => before.files.get(path) !== files.get(path))
        .sort((a, b) => a.localeCompare(b));
    },
  };
}

export async function hashProject(projectDir: string): Promise<string> {
  return (await snapshotProject(projectDir)).hash;
}

export function reevaluationPolicy(meta: Pick<Meta, "exitCode" | "harnessError"> | { exitCode: number; scoreStatus: string }): { preserveOfficialScore: boolean; harnessError: boolean } {
  const cleanExit = meta.exitCode === 0;
  return { preserveOfficialScore: cleanExit, harnessError: !cleanExit };
}

async function preserveOriginals(resultDir: string): Promise<void> {
  for (const filename of ["meta.json", "score.json"]) {
    const source = join(resultDir, filename);
    const destination = join(resultDir, filename.replace(".json", ".original.json"));
    try { await stat(destination); } catch { await copyFile(source, destination); }
  }
  const validationLog = join(resultDir, "validation.log");
  const originalLog = join(resultDir, "validation.original.log");
  try { await stat(originalLog); } catch { try { await copyFile(validationLog, originalLog); } catch {} }
  const originalValidation = join(resultDir, "validation.original.json");
  try { await stat(originalValidation); } catch {
    await saveJson(originalValidation, { preserved: false, source: "validation.original.log", reason: "V2.3 did not persist structured validation.json" });
  }
}

async function listRuns(executionId: string): Promise<Array<{ resultDir: string; meta: Meta; score: Score }>> {
  const runs: Array<{ resultDir: string; meta: Meta; score: Score }> = [];
  for (const benchmark of ["greenfield", "bugfix"]) {
    const benchmarkDir = join(RESULTS_DIR, benchmark);
    let entries: string[];
    try { entries = await readdir(benchmarkDir); } catch { continue; }
    for (const entry of entries) {
      const resultDir = join(benchmarkDir, entry);
      const meta = await loadMeta(resultDir);
      const score = await loadScore(resultDir);
      if (meta?.executionId === executionId && score) runs.push({ resultDir, meta, score });
    }
  }
  return runs;
}

async function reevaluateRun(run: { resultDir: string; meta: Meta; score: Score }, timeoutMinutes: number): Promise<void> {
  await preserveOriginals(run.resultDir);
  const projectDir = join(run.resultDir, "project");
  const before = await snapshotProject(projectDir);
  const validation = await validateProject(projectDir, timeoutMinutes, { install: false, typecheck: true, test: true, build: true, lint: true }, run.meta.benchmark);
  await saveJson(join(run.resultDir, "validation.reevaluated.json"), validation);
  const ui: UiFunctionalValidation = run.meta.benchmark === "greenfield"
    ? await runUiFunctionalEvaluator(projectDir, run.resultDir, run.meta.benchmark, 90_000)
    : { enabled: false, status: "skipped", passedChecks: 0, totalChecks: 0, score: 0, maxScore: 0, reason: "bugfix_has_no_ui_score", output: "UI evaluator skipped for bugfix." };
  await saveJson(join(run.resultDir, "ui-functional.reevaluated.json"), ui);
  const fixtureDir = run.meta.benchmark === "bugfix" ? join(FIXTURES_DIR, "bugfix-app") : null;
  const penalties = detectPenalties(projectDir, fixtureDir, run.meta.benchmark);
  const policy = reevaluationPolicy(run.meta);
  const score = await computeScore(validation, penalties, { projectDir, benchmark: run.meta.benchmark, harnessError: policy.harnessError, ui });
  await saveJson(join(run.resultDir, "score.reevaluated.json"), score);
  const after = await snapshotProject(projectDir);
  await saveJson(join(run.resultDir, "reevaluation.json"), {
    version: "2.3.1",
    agentRerun: false,
    originalExecutionId: run.meta.executionId,
    originalScoreStatus: run.score.scoreStatus,
    reevaluatedScoreStatus: score.scoreStatus,
    preserveOfficialScore: policy.preserveOfficialScore,
    projectHashBefore: before.hash,
    projectHashAfter: after.hash,
    projectUnchanged: before.hash === after.hash,
    changedFiles: after.changedFilesComparedTo(before),
    validations: { install: false, typecheck: true, test: true, build: true, lint: true },
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const executionIndex = args.indexOf("--execution");
  const executionId = executionIndex >= 0 ? args[executionIndex + 1] : undefined;
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency = concurrencyIndex >= 0 ? Math.max(1, Number.parseInt(args[concurrencyIndex + 1] ?? "1", 10) || 1) : 1;
  const dryRun = args.includes("--dry-run");
  if (!executionId) throw new Error("Uso: npm run reevaluate -- --execution <executionId> [--concurrency N]");
  const config = JSON.parse(await readFile(join(resolve("."), "config/benchmark.json"), "utf-8")) as { timeoutMinutes: number };
  const runs = await listRuns(executionId);
  if (!runs.length) throw new Error(`Nenhuma execução concluída encontrada para ${executionId}`);
  if (dryRun) {
    console.log(`Reavaliaria ${runs.length} execução(ões), sem chamar agente/modelo, concorrência ${concurrency}.`);
    for (const run of runs) console.log(`  ${run.meta.benchmark} | ${run.meta.model} | round ${run.meta.round} | exit ${run.meta.exitCode}`);
    return;
  }
  console.log(`Reavaliando ${runs.length} execução(ões), sem chamar agente/modelo, concorrência ${concurrency}.`);
  await runWithConcurrency(runs, concurrency, async (run) => {
    await reevaluateRun(run, config.timeoutMinutes);
    console.log(`Reavaliado: ${run.meta.benchmark}/${run.meta.model}/round-${run.meta.round}`);
  });
  console.log("Reavaliação concluída. Evidências originais preservadas.");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exit(1); });
