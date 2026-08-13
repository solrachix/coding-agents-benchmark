import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { ensureDir, RESULTS_DIR, REPORTS_DIR } from "./utils.js";
import { loadMeta, loadScore } from "./score-results.js";
import type { TokenUsage } from "./token-usage.js";
import type { UiFunctionalValidation } from "./ui-functional-evaluator.js";
import type { EnvironmentSnapshot } from "./environment.js";
import type { ModelRuntimeMetadata } from "./model-metadata.js";
import { usableModelRevision } from "./model-metadata.js";
import type { ProjectMetadata } from "./project-metadata.js";
import { aggregateExecutions, type AggregatedResult } from "./aggregate-results.js";

interface VisualReport {
  status: "captured" | "skipped" | "failed";
  screenshots: Array<{ name: string; reportPath: string }>;
  reason?: string;
  diagnostic?: string;
}

export function shouldIncludeExecution(metaExecutionId: string | undefined, executionId: string | undefined): boolean {
  return executionId === undefined || metaExecutionId === executionId;
}

interface ReportRow {
  benchmark: string;
  harness: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  rubricVersion?: string;
  round: number;
  executionId?: string;
  promptHash?: string;
  harnessVersion?: string;
  isolatedGit?: boolean;
  score: number | null;
  effectiveScore: number | null;
  artifactScore: number;
  unverifiedScore?: number;
  objectiveScore: number;
  tier?: string;
  scoreStatus?: string;
  typecheck: boolean;
  test: boolean;
  build: boolean;
  lint: boolean;
  functionalScore: number;
  functionalMax: number;
  uiFunctionalScore: number;
  uiFunctionalMax: number;
  uiFunctionalStatus?: UiFunctionalValidation["status"];
  preservation: number;
  agentDuration: number;
  installDuration: number;
  validationDuration: number;
  totalDuration: number;
  exitCode: number;
  harnessError?: string;
  visualStatus?: VisualReport["status"];
  visualScreenshots: string[];
  visualReason?: string;
  visualDiagnostic?: string;
  functionalStatus?: "passed" | "failed" | "evaluator_error";
  functionalReason?: string;
  uiScreenshot?: string;
  usage?: TokenUsage;
  modelRuntime?: ModelRuntimeMetadata;
  projectMetadata?: ProjectMetadata;
  reevaluatedScore?: number | null;
  reevaluation?: { version?: string; projectUnchanged?: boolean; preserveOfficialScore?: boolean; originalScoreStatus?: string; reevaluatedScoreStatus?: string };
  resultDir: string;
}

export function effectiveScore(row: Pick<ReportRow, "score" | "reevaluatedScore" | "reevaluation">): number | null {
  if (row.score !== null) return row.score;
  const reevaluation = row.reevaluation;
  return reevaluation?.reevaluatedScoreStatus === "valid" &&
    reevaluation.projectUnchanged === true &&
    reevaluation.preserveOfficialScore === true
    ? row.reevaluatedScore ?? null
    : null;
}

function escapeCodeFence(content: string): string { return content; }
function fmt(value: number | null | undefined): string { return value === null || value === undefined ? "-" : String(value); }
function usdEquivalent(usage?: TokenUsage): number | null {
  return usage?.aiCredits === undefined ? null : Math.round(usage.aiCredits * 0.01 * 1e8) / 1e8;
}

function paretoQualityTime(values: AggregatedResult[]): AggregatedResult[] {
  const eligible = values.filter((value) => value.mean !== null && value.meanDuration !== null);
  return eligible.filter((candidate) => !eligible.some((other) =>
    other !== candidate &&
    (other.mean ?? -Infinity) >= (candidate.mean ?? -Infinity) &&
    (other.meanDuration ?? Infinity) <= (candidate.meanDuration ?? Infinity) &&
    ((other.mean ?? 0) > (candidate.mean ?? 0) || (other.meanDuration ?? 0) < (candidate.meanDuration ?? 0))
  ));
}

function paretoQualityCost(values: AggregatedResult[]): AggregatedResult[] {
  const eligible = values.filter((value) => value.mean !== null && value.meanCost !== null && value.meanCost > 0);
  return eligible.filter((candidate) => !eligible.some((other) =>
    other !== candidate &&
    (other.mean ?? -Infinity) >= (candidate.mean ?? -Infinity) &&
    (other.meanCost ?? Infinity) <= (candidate.meanCost ?? Infinity) &&
    ((other.mean ?? 0) > (candidate.mean ?? 0) || (other.meanCost ?? 0) < (candidate.meanCost ?? 0))
  ));
}

function paretoQualityCredits(values: AggregatedResult[]): AggregatedResult[] {
  const eligible = values.filter((value) => value.mean !== null && value.meanAiCredits !== null && value.meanAiCredits > 0);
  return eligible.filter((candidate) => !eligible.some((other) =>
    other !== candidate &&
    (other.mean ?? -Infinity) >= (candidate.mean ?? -Infinity) &&
    (other.meanAiCredits ?? Infinity) <= (candidate.meanAiCredits ?? Infinity) &&
    ((other.mean ?? 0) > (candidate.mean ?? 0) || (other.meanAiCredits ?? 0) < (candidate.meanAiCredits ?? 0))
  ));
}

export async function generateReport(executionId?: string): Promise<void> {
  const rows: ReportRow[] = [];
  ensureDir(RESULTS_DIR);
  const environment = await readFile(join(RESULTS_DIR, "environment.json"), "utf-8")
    .then((raw) => JSON.parse(raw) as EnvironmentSnapshot)
    .catch(() => null);

  for (const benchmark of readdirSync(RESULTS_DIR)) {
    const benchmarkPath = join(RESULTS_DIR, benchmark);
    const stat = statSync(benchmarkPath);
    if (!stat.isDirectory() || benchmark === "archive") continue;

    for (const run of readdirSync(benchmarkPath)) {
      const runPath = join(benchmarkPath, run);
      const runStat = statSync(runPath);
      if (!runStat.isDirectory()) continue;

      const meta = await loadMeta(runPath);
      const score = await loadScore(runPath);
      if (!meta || !score) continue;
      if (!shouldIncludeExecution(meta.executionId, executionId)) continue;
      const visual = await readFile(join(runPath, "visual.json"), "utf-8").then((raw) => JSON.parse(raw) as VisualReport).catch(() => null);
      const ui = await readFile(join(runPath, "ui-functional.json"), "utf-8").then((raw) => JSON.parse(raw) as UiFunctionalValidation).catch(() => null);
      const usage = await readFile(join(runPath, "usage.json"), "utf-8").then((raw) => JSON.parse(raw) as TokenUsage).catch(() => null);
      const modelRuntime = meta.modelRuntime ?? await readFile(join(runPath, "model-runtime.json"), "utf-8").then((raw) => JSON.parse(raw) as ModelRuntimeMetadata).catch(() => undefined);
      const projectMetadata = meta.projectMetadata ?? await readFile(join(runPath, "project-metadata.json"), "utf-8").then((raw) => JSON.parse(raw) as ProjectMetadata).catch(() => undefined);
      const reevaluated = await readFile(join(runPath, "score.reevaluated.json"), "utf-8").then((raw) => JSON.parse(raw) as { total?: number | null }).catch(() => undefined);
      const reevaluation = await readFile(join(runPath, "reevaluation.json"), "utf-8").then((raw) => JSON.parse(raw) as ReportRow["reevaluation"]).catch(() => undefined);

      const reportRow = {
        benchmark: meta.benchmark,
        harness: meta.harness,
        provider: meta.provider,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
        rubricVersion: meta.rubricVersion,
        round: meta.round,
        executionId: meta.executionId,
        promptHash: meta.promptHash,
        harnessVersion: meta.harnessVersion,
        isolatedGit: meta.isolatedGit,
        score: score.total,
        artifactScore: score.artifactScore ?? score.total ?? 0,
        unverifiedScore: score.unverifiedScore,
        objectiveScore: score.objectiveScore ?? score.total ?? 0,
        tier: score.total === null ? undefined : score.tier,
        scoreStatus: score.scoreStatus,
        typecheck: score.typecheck > 0,
        test: score.test > 0,
        build: score.build > 0,
        lint: score.lint > 0,
        functionalScore: score.functionalCompleteness ?? 0,
        functionalMax: score.functionalMax ?? 35,
        uiFunctionalScore: score.uiFunctional ?? 0,
        uiFunctionalMax: score.uiFunctionalMax ?? 0,
        uiFunctionalStatus: ui?.status ?? meta.uiFunctionalStatus,
        preservation: score.preservation ?? 0,
        agentDuration: meta.agentDurationSeconds,
        installDuration: meta.installDurationSeconds,
        validationDuration: meta.validationDurationSeconds,
        totalDuration: meta.totalDurationSeconds,
        exitCode: meta.exitCode,
        harnessError: meta.harnessErrorType,
        visualStatus: visual?.status ?? meta.visualStatus,
        visualScreenshots: visual?.screenshots.map((s) => s.reportPath) ?? [],
        visualReason: visual?.reason,
        visualDiagnostic: visual?.diagnostic,
        functionalStatus: meta.functionalStatus ?? (score.scoreStatus === "evaluator_error" ? "evaluator_error" : undefined),
        functionalReason: meta.functionalReason,
        uiScreenshot: ui?.screenshot,
        usage: meta.usage ?? usage ?? undefined,
        modelRuntime: modelRuntime ? { ...modelRuntime, modelRevision: usableModelRevision(modelRuntime.modelRevision) } : modelRuntime,
        projectMetadata,
        reevaluatedScore: reevaluated?.total,
        reevaluation,
        resultDir: runPath,
      } satisfies Omit<ReportRow, "effectiveScore">;
      rows.push({ ...reportRow, effectiveScore: effectiveScore(reportRow) });
    }
  }

  rows.sort((a, b) => (b.effectiveScore ?? -1) - (a.effectiveScore ?? -1));

  const mdLines: string[] = [
    "# Benchmark Report",
    "",
    "> **Nota:** Comparações entre harnesses diferentes medem `modelo + harness`. Aliases de modelo podem apontar para checkpoints diferentes ao longo do tempo; veja a metadata de runtime.",
    "",
  ];

  if (environment) {
    mdLines.push("## Ambiente", "", `- Node: \`${environment.node}\`; npm: \`${environment.npm}\`; SO: \`${environment.platform} ${environment.release} (${environment.arch})\``, `- CPU: \`${environment.cpuModel}\` × ${environment.cpuCount}; RAM: \`${Math.round(environment.totalMemoryBytes / 1024 ** 3)} GiB\``, "");
  }

  mdLines.push(
    "## Resultados",
    "",
    "| Benchmark | Harness | Provider | Model | Effort | Round | Score | Reevaluated | Effective | Artifact | Heuristic | Hidden | UI | Preserve | Tier | Status | Revision | Typecheck | Test | Build | Lint | Agent | Total | Tokens | Cache read | Cache write | AI credits | US$ eq. | Legacy cost |",
    "|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|"
  );
  for (const r of rows) {
    const hidden = r.functionalStatus === "evaluator_error" ? "ERROR" : `${r.functionalScore}/${r.functionalMax}`;
    mdLines.push(`| ${r.benchmark} | ${r.harness} | ${r.provider} | ${r.model} | ${r.reasoningEffort ?? "default"} | ${r.round} | ${r.score ?? "-"} | ${r.reevaluatedScore ?? "-"} | ${r.effectiveScore ?? "-"} | ${r.artifactScore} | ${r.unverifiedScore ?? "-"} | ${hidden} | ${r.uiFunctionalMax ? `${r.uiFunctionalScore}/${r.uiFunctionalMax}` : "-"} | ${r.benchmark === "bugfix" ? `${r.preservation}/15` : "-"} | ${r.tier ?? "-"} | ${r.scoreStatus ?? "legacy"} | ${r.modelRuntime?.modelRevision ?? "unknown"} | ${r.typecheck ? "✅" : "❌"} | ${r.test ? "✅" : "❌"} | ${r.build ? "✅" : "❌"} | ${r.lint ? "✅" : "❌"} | ${r.agentDuration}s | ${r.totalDuration}s | ${r.usage?.totalTokens?.toLocaleString("pt-BR") ?? "-"} | ${r.usage?.cacheReadTokens?.toLocaleString("pt-BR") ?? "-"} | ${r.usage?.cacheWriteTokens?.toLocaleString("pt-BR") ?? "-"} | ${r.usage?.aiCredits !== undefined ? r.usage.aiCredits : "-"} | ${usdEquivalent(r.usage) ?? "-"} | ${r.usage?.cost !== undefined ? `$${r.usage.cost}` : "-"} |`);
  }

  mdLines.push("", "## Summary");
  const best = rows.find((row) => row.effectiveScore !== null);
  if (best) mdLines.push(`- Melhor score efetivo: ${best.effectiveScore} (${best.harness} / ${best.provider} / ${best.model})`);

  const aggregates = aggregateExecutions(rows.map((row) => ({
    key: [row.benchmark, row.harness, row.provider, row.model, row.reasoningEffort ?? "default"].join(" / "),
    score: row.effectiveScore,
    structuralScore: row.unverifiedScore,
    functionalScore: row.functionalScore,
    functionalMax: row.functionalMax,
    uiStatus: row.uiFunctionalStatus,
    scoreStatus: row.scoreStatus,
    functionalStatus: row.functionalStatus,
    harnessError: row.harnessError,
    duration: row.totalDuration,
    cost: usdEquivalent(row.usage) ?? row.usage?.cost,
    aiCredits: row.usage?.aiCredits,
  })));

  mdLines.push("", "## Estatísticas por Configuração", "", "| Configuração | Runs | Válidos | Média | Mediana | Min | Max | Range | P25 | P75 | SD | CV | Sucesso | Harness fail | Evaluator error | UI ? | Func. fail | Modelo <70 | Tempo | Score/min | AI credits | US$ eq. | Score/credit | Score/$ |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of aggregates) {
    mdLines.push(`| ${a.key} | ${a.runs} | ${a.successes} | ${fmt(a.mean)} | ${fmt(a.median)} | ${fmt(a.minimum)} | ${fmt(a.maximum)} | ${fmt(a.range)} | ${fmt(a.p25)} | ${fmt(a.p75)} | ${fmt(a.standardDeviation)} | ${a.coefficientOfVariation !== null ? `${a.coefficientOfVariation}%` : "-"} | ${a.successRate}% | ${a.harnessFailures} | ${a.evaluatorErrors} | ${a.uiUnverified} | ${a.functionalFailures} | ${a.catastrophicModelFailures} | ${fmt(a.meanDuration)}s | ${fmt(a.meanScorePerMinute)} | ${fmt(a.meanAiCredits)} | ${a.meanCost !== null ? `$${a.meanCost}` : "-"} | ${fmt(a.meanScorePerCredit)} | ${fmt(a.meanScorePerDollar)} |`);
  }
  mdLines.push("", "> `Harness fail`, `evaluator error`, `UI não verificada` e `falha funcional do agente` são contados separadamente; erro de provider não é tratado como falha de capacidade do modelo.");

  const timePareto = paretoQualityTime(aggregates);
  if (timePareto.length) {
    mdLines.push("", "## Fronteira de Pareto — qualidade × tempo", "");
    for (const a of timePareto.sort((x, y) => (y.mean ?? 0) - (x.mean ?? 0))) mdLines.push(`- ${a.key}: média ${a.mean}, ${a.meanDuration}s/run`);
  }
  const costPareto = paretoQualityCost(aggregates);
  if (costPareto.length) {
    mdLines.push("", "## Fronteira de Pareto — qualidade × custo", "");
    for (const a of costPareto.sort((x, y) => (y.mean ?? 0) - (x.mean ?? 0))) mdLines.push(`- ${a.key}: média ${a.mean}, $${a.meanCost}/run`);
  }
  const creditsPareto = paretoQualityCredits(aggregates);
  if (creditsPareto.length) {
    mdLines.push("", "## Fronteira de Pareto — qualidade × AI credits", "");
    for (const a of creditsPareto.sort((x, y) => (y.mean ?? 0) - (x.mean ?? 0))) mdLines.push(`- ${a.key}: média ${a.mean}, ${a.meanAiCredits} AI credits/run`);
  }

  const harnessErrors = rows.filter((r) => r.harnessError);
  if (harnessErrors.length) {
    mdLines.push("", "## Erros de Harness/Provider");
    for (const r of harnessErrors) mdLines.push(`- ${r.harness} / ${r.provider} / ${r.model}: ${r.harnessError}`);
  }

  mdLines.push("", "## Detalhes Por Execução");
  for (const r of rows) {
    const [validationLog, manualReview, uiLog] = await Promise.all([
      readFile(join(r.resultDir, "validation.log"), "utf-8").catch(() => "(validation.log ausente)"),
      readFile(join(r.resultDir, "manual-review.md"), "utf-8").catch(() => "(manual-review.md ausente)"),
      readFile(join(r.resultDir, "ui-functional.json"), "utf-8").catch(() => "(ui-functional.json ausente)"),
    ]);
    const score = await loadScore(r.resultDir);
    const meta = await loadMeta(r.resultDir);
    const deps = { ...r.projectMetadata?.dependencies, ...r.projectMetadata?.devDependencies };
    const resolved = r.projectMetadata?.resolvedVersions ?? {};

    mdLines.push(`### ${r.benchmark} / ${r.harness} / ${r.provider} / ${r.model} / ${r.reasoningEffort ?? "default"} / round ${r.round}`);
    mdLines.push(`- Result dir: \`${r.resultDir}\``);
    mdLines.push(`- Execução: \`${r.executionId ?? "legacy"}\`, harness \`${r.harnessVersion ?? "legacy"}\`, prompt hash \`${r.promptHash ?? "legacy"}\`, Git baseline: \`${r.isolatedGit ?? "legacy"}\``);
    mdLines.push(`- Modelo solicitado: \`${r.modelRuntime?.requestedModel ?? r.model}\`; resolvido observado: \`${r.modelRuntime?.resolvedModel ?? "unknown"}\`; revisão: \`${r.modelRuntime?.modelRevision ?? "unknown"}\`; fingerprint: \`${r.modelRuntime?.systemFingerprint ?? "unknown"}\``);
    mdLines.push(`- Stack gerada: Next \`${resolved.next ?? deps.next ?? "-"}\`, Prisma \`${resolved.prisma ?? resolved["@prisma/client"] ?? deps.prisma ?? deps["@prisma/client"] ?? "-"}\`, Zod \`${resolved.zod ?? deps.zod ?? "-"}\`, Vitest \`${resolved.vitest ?? deps.vitest ?? "-"}\`, Jest \`${resolved.jest ?? deps.jest ?? "-"}\`; package hash \`${r.projectMetadata?.packageJsonHash?.slice(0, 12) ?? "-"}\``);
    mdLines.push(`- Exit code: \`${r.exitCode}\`; score oficial: \`${r.score}\`; artifact score: \`${r.artifactScore}\`; heurístico: \`${r.unverifiedScore ?? "-"}\`; hidden: \`${r.functionalStatus === "evaluator_error" ? "ERROR" : `${r.functionalScore}/${r.functionalMax}`}\`; UI: \`${r.uiFunctionalMax ? `${r.uiFunctionalScore}/${r.uiFunctionalMax} (${r.uiFunctionalStatus})` : "n/a"}\`; preservação: \`${r.benchmark === "bugfix" ? `${r.preservation}/15` : "n/a"}\``);
    if (r.reevaluation) mdLines.push(`- Reavaliação ${r.reevaluation.version ?? "2.3.1"}: score \`${r.reevaluatedScore ?? "-"}\`; agente rerodado: \`não\`; projeto inalterado: \`${r.reevaluation.projectUnchanged ?? "unknown"}\`; score oficial preservado: \`${r.reevaluation.preserveOfficialScore ?? false}\``);
    mdLines.push(`- Durações: agent \`${r.agentDuration}s\`, install \`${r.installDuration}s\`, validation \`${r.validationDuration}s\`, total \`${r.totalDuration}s\``);
    mdLines.push(`- Visual smoke: \`${r.visualStatus ?? "legacy"}\`${r.visualReason ? ` (${r.visualReason})` : ""}`);
    if (r.visualDiagnostic) mdLines.push("- Diagnóstico visual:", "````text", r.visualDiagnostic.slice(-4000), "````");
    mdLines.push(`- Uso: total \`${r.usage?.totalTokens?.toLocaleString("pt-BR") ?? "-"}\`, input \`${r.usage?.inputTokens?.toLocaleString("pt-BR") ?? "-"}\`, output \`${r.usage?.outputTokens?.toLocaleString("pt-BR") ?? "-"}\`, reasoning \`${r.usage?.reasoningTokens?.toLocaleString("pt-BR") ?? "-"}\`, cache read \`${r.usage?.cacheReadTokens?.toLocaleString("pt-BR") ?? "-"}\`, cache write \`${r.usage?.cacheWriteTokens?.toLocaleString("pt-BR") ?? "-"}\`, AI credits \`${r.usage?.aiCredits ?? "-"}\`, US$ equivalente \`${usdEquivalent(r.usage) ?? "-"}\`, custo legado \`${r.usage?.cost !== undefined ? `$${r.usage.cost}` : "-"}\``);
    for (const screenshot of [...r.visualScreenshots, ...(r.uiScreenshot ? [r.uiScreenshot] : [])]) mdLines.push(`![${screenshot.split("/").pop() ?? "screenshot"}](${screenshot})`);
    if (meta?.harnessErrorType) mdLines.push(`- Harness error: \`${meta.harnessErrorType}\``);
    if (score) {
      mdLines.push(`- Breakdown: hidden \`${score.functionalCompleteness}/${score.functionalMax}\`, UI \`${score.uiFunctional}/${score.uiFunctionalMax}\`, preservation \`${score.preservation}/15\`, typecheck \`${score.typecheck}\`, test \`${score.test}\`, build \`${score.build}\`, lint \`${score.lint}\`, architecture \`${score.architecture}\`, README \`${score.readmeSetup}\`, penalties \`${score.penalties.penaltyPoints}\``);
      mdLines.push(`- Penalties: testsRemoved=${score.penalties.testsRemoved}, testsModified=${score.penalties.testsModified}, validationScriptsModified=${score.penalties.validationScriptsModified}, prismaRemoved=${score.penalties.prismaRemoved}, any=${score.penalties.usedAny}, tsIgnore=${score.penalties.usedTsIgnore}, tsExpectError=${score.penalties.usedTsExpectError}, eslintDisable=${score.penalties.usedEslintDisable}, jsonImportNotFixed=${score.penalties.jsonImportNotFixed}, appRewritten=${score.penalties.appRewritten}`);
    }
    mdLines.push("", "**manual-review.md**", "````md", escapeCodeFence(manualReview), "````", "", "**validation.log**", "````text", escapeCodeFence(validationLog), "````", "", "**ui-functional.json**", "````json", escapeCodeFence(uiLog), "````", "");
  }

  mdLines.push("", "## Falhas comuns", "- `scoreStatus=evaluator_error`: o próprio evaluator não conseguiu produzir resultado; os pontos hidden não são atribuídos como falha do modelo.", "- `scoreStatus=ui_unverified`: o ambiente não conseguiu executar Playwright/Chrome; o greenfield não recebe score final comparável.", "- `harnessError`: erro de CLI/provider/timeout, separado de falha funcional do agente.", "- Consulte validation.log, ui-functional.json e manual-review.md por execução.");

  ensureDir(REPORTS_DIR);
  await writeFile(join(REPORTS_DIR, "report.md"), mdLines.join("\n"), "utf-8");
  await writeFile(join(REPORTS_DIR, "report.json"), JSON.stringify({ environment, rows, aggregates, pareto: { qualityTime: timePareto.map((x) => x.key), qualityCost: costPareto.map((x) => x.key), qualityCredits: creditsPareto.map((x) => x.key) }, generatedAt: new Date().toISOString() }, null, 2), "utf-8");
  console.log("Report generated at reports/report.md");
}
