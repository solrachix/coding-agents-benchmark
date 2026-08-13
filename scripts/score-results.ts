import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { ValidationResult } from "./validate-project.js";
import { saveJson } from "./utils.js";
import type { Penalties } from "./penalties.js";
import { scoreProject, type RubricScore } from "./rubric.js";
import type { TokenUsage } from "./token-usage.js";
import type { UiFunctionalValidation } from "./ui-functional-evaluator.js";
import type { ModelRuntimeMetadata } from "./model-metadata.js";
import type { ProjectMetadata } from "./project-metadata.js";

export interface Score extends RubricScore {
  scoreStatus: "valid" | "harness_failed" | "ui_unverified" | "evaluator_error";
  total: number | null;
  artifactScore: number;
  /** Legacy structural/heuristic score, retained for diagnosis only. */
  unverifiedScore?: number;
  objectiveScore: number;
  typecheck: number;
  test: number;
  build: number;
  lint: number;
  readmeSetup: number;
  securityNoShortcuts: number;
  functionalCompleteness: number;
  functionalMax: number;
  uiFunctional: number;
  uiFunctionalMax: number;
  preservation: number;
  architecture: number;
  validation: number;
  penalties: Penalties;
}

export function getScoreStatus(
  harnessError: boolean,
  benchmark: string,
  ui?: UiFunctionalValidation,
  functionalStatus?: "passed" | "failed" | "evaluator_error"
): Score["scoreStatus"] {
  if (harnessError) return "harness_failed";
  if (functionalStatus === "evaluator_error") return "evaluator_error";
  if (benchmark === "greenfield" && ui?.status === "skipped") return "ui_unverified";
  return "valid";
}

export function reportableScores(score: Pick<Score, "total" | "scoreStatus"> & Partial<Pick<Score, "artifactScore">>): {
  artifactScore: number;
  officialScore: number | null;
  status: Score["scoreStatus"];
} {
  return {
    artifactScore: score.artifactScore ?? score.total ?? 0,
    officialScore: score.scoreStatus === "valid" ? score.total : null,
    status: score.scoreStatus,
  };
}

export interface Meta {
  benchmark: string;
  harness: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  requestedReasoningEffort?: string;
  rubricVersion?: string;
  round: number;
  executionId?: string;
  promptHash?: string;
  harnessVersion?: string;
  isolatedGit?: boolean;
  startedAt: string;
  finishedAt: string;
  agentDurationSeconds: number;
  installDurationSeconds: number;
  validationDurationSeconds: number;
  totalDurationSeconds: number;
  exitCode: number;
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
  visualStatus?: "captured" | "skipped" | "failed";
  visualScreenshotCount?: number;
  uiFunctionalStatus?: UiFunctionalValidation["status"];
  uiFunctionalScore?: number;
  usage?: TokenUsage;
  modelRuntime?: ModelRuntimeMetadata;
  projectMetadata?: ProjectMetadata;
  harnessError?: boolean;
  harnessErrorType?: string;
  functionalStatus?: "passed" | "failed" | "evaluator_error";
  functionalReason?: string;
}

function finalTier(total: number): "A" | "B" | "C" | "D" {
  if (total >= 80) return "A";
  if (total >= 60) return "B";
  if (total >= 40) return "C";
  return "D";
}

export async function computeScore(
  validation: ValidationResult,
  penalties?: Penalties,
  options?: {
    projectDir?: string;
    benchmark?: string;
    harnessError?: boolean;
    ui?: UiFunctionalValidation;
  }
): Promise<Score> {
  const effectivePenalties: Penalties = penalties ?? {
    testsRemoved: false,
    testsModified: false,
    validationScriptsModified: false,
    prismaRemoved: false,
    usedAny: false,
    usedTsIgnore: false,
    usedTsExpectError: false,
    usedEslintDisable: false,
    jsonImportNotFixed: false,
    appRewritten: false,
    penaltyPoints: 0,
  };

  const benchmark = options?.benchmark ?? "";
  const rubric = await scoreProject(options?.projectDir ?? ".", validation, effectivePenalties, benchmark);
  const heuristicScore = rubric.total ?? 0;

  // Rubric v2.3: behavior first. Both benchmarks sum to 100 before penalties.
  const functionalCompleteness = validation.functional.score; // 0..35
  const functionalMax = validation.functional.maxScore;
  const typecheck = validation.typecheck.enabled && validation.typecheck.passed ? 15 : 0;
  const test = validation.test.enabled && validation.test.passed ? 10 : 0;
  const build = validation.build.enabled && validation.build.passed ? 10 : 0;
  const lint = validation.lint.enabled && validation.lint.passed ? 5 : 0;
  const architecture = Math.min(5, rubric.dimensions.architecture);
  const readmeSetup = validation.readmeExists ? 5 : 0;
  const securityNoShortcuts = 0;

  const uiFunctional = benchmark === "greenfield" ? (options?.ui?.score ?? 0) : 0;
  const uiFunctionalMax = benchmark === "greenfield" ? 15 : 0;
  const preservation = benchmark === "bugfix" &&
    !effectivePenalties.testsRemoved &&
    !effectivePenalties.testsModified &&
    !effectivePenalties.validationScriptsModified ? 15 : 0;

  let final = functionalCompleteness + typecheck + test + build + lint + architecture + readmeSetup + uiFunctional + preservation;
  final = Math.max(0, final - effectivePenalties.penaltyPoints);

  // Hard gates.
  if (functionalCompleteness < 25) final = Math.min(final, 69);
  if (!validation.typecheck.passed || !validation.build.passed) final = Math.min(final, 79);
  if (benchmark === "greenfield" && options?.ui?.status === "failed") final = Math.min(final, 89);
  final = Math.min(100, final);

  const scoreStatus = getScoreStatus(options?.harnessError ?? false, benchmark, options?.ui, validation.functional.status);
  // An environment that cannot run the required UI E2E does not produce a comparable greenfield score.
  const total = scoreStatus === "valid" ? final : null;

  return {
    ...rubric,
    total,
    artifactScore: final,
    unverifiedScore: heuristicScore,
    objectiveScore: final,
    tier: finalTier(final),
    scoreStatus,
    typecheck,
    test,
    build,
    lint,
    readmeSetup,
    securityNoShortcuts,
    functionalCompleteness,
    functionalMax,
    uiFunctional,
    uiFunctionalMax,
    preservation,
    architecture,
    validation: 0,
    penalties: effectivePenalties,
  };
}

export async function saveScore(resultDir: string, score: Score): Promise<void> {
  await saveJson(join(resultDir, "score.json"), score);
}

export async function generateManualReviewTemplate(resultDir: string, score?: Score): Promise<void> {
  const path = join(resultDir, "manual-review.md");
  const content = `# Manual Review Checklist

- Score final: ${score?.total ?? "indisponível"} / 100
- Score heurístico estrutural: ${score?.unverifiedScore ?? "indisponível"} / 100
- Hidden functional: ${score?.functionalCompleteness ?? 0} / ${score?.functionalMax ?? 35}
- UI functional: ${score?.uiFunctional ?? 0} / ${score?.uiFunctionalMax ?? 0}
- Preservação do fixture: ${score?.preservation ?? 0} / ${score?.uiFunctionalMax ? 0 : 15}
- Tier final: ${score?.total !== null && score?.total !== undefined ? score.tier : "indisponível"}
- [ ] O app realmente usa banco?
- [ ] A importação JSON funciona?
- [ ] A busca funciona por título e autor sem diferenciar maiúsculas/minúsculas?
- [ ] O greenfield passou pelos fluxos E2E de criar/buscar/editar/importar/deletar?
- [ ] Os testes visíveis foram preservados no bugfix?
- [ ] Os scripts de validação foram preservados no bugfix?
- [ ] Tem APIs inventadas?
- [ ] Tem \`any\`/\`ts-ignore\`/\`eslint-disable\` desnecessário?
- [ ] O código está organizado?
- [ ] O projeto parece sustentável?

## Dimensões heurísticas (diagnóstico; não somam diretamente o score final)

${score ? Object.entries(score.dimensions).map(([name, value]) => `- ${name}: ${value}`).join("\n") : "Execute o benchmark para preencher."}

> Rubrica 2.3: hidden evaluator usa o runtime do benchmark, não o runner de testes do candidato. Greenfield exige E2E funcional de UI; bugfix recompensa preservação do fixture.
`;
  await writeFile(path, content, "utf-8");
}

export async function loadMeta(resultDir: string): Promise<Meta | null> {
  try { return JSON.parse(await readFile(join(resultDir, "meta.json"), "utf-8")) as Meta; } catch { return null; }
}

export async function loadScore(resultDir: string): Promise<Score | null> {
  try { return JSON.parse(await readFile(join(resultDir, "score.json"), "utf-8")) as Score; } catch { return null; }
}

export async function loadValidation(_resultDir: string): Promise<ValidationResult | null> {
  return null;
}
