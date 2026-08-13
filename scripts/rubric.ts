import { join, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { ValidationResult } from "./validate-project.js";
import type { Penalties } from "./penalties.js";

export const RUBRIC_VERSION = "2.3";

export type Dimension =
  | "deliverableCompleteness"
  | "domainCorrectness"
  | "testQuality"
  | "errorHandling"
  | "persistence"
  | "uiIntegration"
  | "architecture"
  | "productionReadiness";

export type DimensionScores = Record<Dimension, number>;
export type DimensionEvidence = Record<Dimension, string[]>;

export interface RubricScore {
  rubricVersion: string;
  total: number | null;
  objectiveScore: number;
  tier: "A" | "B" | "C" | "D";
  dimensions: DimensionScores;
  evidence: DimensionEvidence;
}

interface ProjectSnapshot {
  paths: Set<string>;
  codeText: string;
  testText: string;
  testFiles: number;
  sourceFiles: number;
}

const DIMENSIONS: Dimension[] = [
  "deliverableCompleteness", "domainCorrectness", "testQuality", "errorHandling",
  "persistence", "uiIntegration", "architecture", "productionReadiness",
];
const IGNORED = new Set(["node_modules", ".next", "dist", "coverage", ".git", ".benchmark-evaluator", "generated", ".prisma"]);

async function snapshotProject(projectDir: string): Promise<ProjectSnapshot> {
  const paths = new Set<string>();
  const codeChunks: string[] = [];
  const testChunks: string[] = [];
  let testFiles = 0;
  let sourceFiles = 0;

  async function visit(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (IGNORED.has(entry)) continue;
      const absolute = join(dir, entry);
      const rel = relative(projectDir, absolute);
      const info = await stat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) { await visit(absolute); continue; }
      paths.add(rel);
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
        sourceFiles++;
        const content = await readFile(absolute, "utf-8").catch(() => "");
        if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry)) {
          testFiles++;
          testChunks.push(content);
        } else {
          codeChunks.push(content);
        }
      } else if (/\.(prisma|json)$/.test(entry)) {
        // Config/schema may contribute structural evidence; README text intentionally does not.
        codeChunks.push(await readFile(absolute, "utf-8").catch(() => ""));
      }
    }
  }

  await visit(projectDir);
  return { paths, codeText: codeChunks.join("\n"), testText: testChunks.join("\n"), testFiles, sourceFiles };
}

function add(evidence: DimensionEvidence, dimension: Dimension, condition: boolean, text: string): number {
  if (condition) evidence[dimension].push(text);
  return condition ? 1 : 0;
}

function tier(total: number): "A" | "B" | "C" | "D" {
  if (total >= 80) return "A";
  if (total >= 60) return "B";
  if (total >= 40) return "C";
  return "D";
}

/**
 * Structural/heuristic score. This is intentionally secondary in rubric v2:
 * the final score is assembled in score-results.ts and is dominated by the
 * post-agent hidden functional evaluator.
 */
export async function scoreProject(
  projectDir: string,
  validation: ValidationResult,
  penalties: Penalties,
  _benchmark: string
): Promise<RubricScore> {
  const project = await snapshotProject(projectDir);
  const evidence = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, []])) as unknown as DimensionEvidence;
  const has = (path: string) => project.paths.has(path);
  const code = project.codeText;
  const tests = project.testText;

  const completenessChecks = [
    add(evidence, "deliverableCompleteness", has("package.json"), "package.json"),
    add(evidence, "deliverableCompleteness", has("README.md"), "README.md"),
    add(evidence, "deliverableCompleteness", has("prisma/schema.prisma"), "Prisma schema"),
    add(evidence, "deliverableCompleteness", project.testFiles > 0, "project tests"),
    add(evidence, "deliverableCompleteness", has("prisma/seed.ts") || has("prisma/seed.js"), "database seed"),
    add(evidence, "deliverableCompleteness", has(".env.example") || has(".env.sample"), "environment template"),
    add(evidence, "deliverableCompleteness", [...project.paths].some((p) => p.startsWith("src/app/")), "App Router files"),
  ];

  const hasCatch = /catch\s*(?:\([^)]*\))?\s*\{/.test(code);
  const hasSilentCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}/.test(code);

  const dimensions: DimensionScores = {
    deliverableCompleteness: Math.round((completenessChecks.reduce((a, b) => a + b, 0) / completenessChecks.length) * 25),
    domainCorrectness:
      (validation.typecheck.passed ? 4 : 0) +
      (validation.functional.score >= 34 ? 10 : Math.round(validation.functional.score / 4)) +
      (add(evidence, "domainCorrectness", /PrismaClient|prisma\./.test(code), "Prisma data layer") * 3) +
      (add(evidence, "domainCorrectness", /z\.object|z\.enum|safeParse/.test(code), "Zod validation") * 3),
    testQuality:
      (validation.test.passed ? 5 : 0) +
      Math.min(4, project.testFiles) +
      (add(evidence, "testQuality", /expect\s*\(/.test(tests), "assertions in test files") * 3) +
      (add(evidence, "testQuality", /(search|import|validation|schema)/i.test(tests), "domain scenarios in tests") * 3),
    errorHandling:
      (add(evidence, "errorHandling", hasCatch, "explicit catch handling") * 3) +
      (add(evidence, "errorHandling", /throw new Error|safeParse|NextResponse\.json/.test(code), "explicit errors") * 4) +
      (add(evidence, "errorHandling", hasCatch && !hasSilentCatch, "no empty catch") * 3),
    persistence:
      (add(evidence, "persistence", has("prisma/schema.prisma"), "Prisma schema") * 3) +
      (add(evidence, "persistence", /PrismaClient|prisma\./.test(code), "database client") * 3) +
      (add(evidence, "persistence", /DATABASE_URL|migration|seed/.test(code), "database setup") * 2) +
      (add(evidence, "persistence", !/\b(?:const|let)\s+books\s*=\s*\[/.test(code), "not obviously in-memory") * 2),
    uiIntegration:
      (add(evidence, "uiIntegration", [...project.paths].some((p) => p.startsWith("src/app/")), "App Router UI") * 3) +
      (add(evidence, "uiIntegration", [...project.paths].some((p) => p.includes("components/")), "components") * 2) +
      (add(evidence, "uiIntegration", /(form|fetch\(|useState|server action|action=)/i.test(code), "UI interaction") * 2) +
      (add(evidence, "uiIntegration", /(search|import|delete|edit|create)/i.test(code), "requested interactions") * 3),
    architecture:
      (add(evidence, "architecture", [...project.paths].some((p) => p.includes("src/lib/")), "lib separation") * 2) +
      (add(evidence, "architecture", [...project.paths].some((p) => p.includes("components/")), "component separation") * 1) +
      (add(evidence, "architecture", project.sourceFiles >= 6, "multiple source modules") * 1) +
      add(evidence, "architecture", has("prisma/schema.prisma"), "persistence separated"),
    productionReadiness:
      (add(evidence, "productionReadiness", !/sk-[a-zA-Z0-9]{20,}|OPENAI_API_KEY\s*=\s*['\"]/.test(code), "no embedded secrets") * 2) +
      add(evidence, "productionReadiness", !/(?:\:\s*any\b|\bas\s+any\b|@ts-ignore|@ts-expect-error|eslint-disable)/.test(code), "no obvious shortcuts") +
      add(evidence, "productionReadiness", has(".env.example") || has(".env.sample"), "environment documented") +
      add(evidence, "productionReadiness", validation.lint.passed, "lint clean"),
  };

  dimensions.domainCorrectness = Math.min(20, dimensions.domainCorrectness);
  dimensions.testQuality = Math.min(15, dimensions.testQuality);
  const rawTotal = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const total = Math.max(0, Math.min(100, rawTotal - penalties.penaltyPoints));
  return { rubricVersion: RUBRIC_VERSION, total, objectiveScore: total, tier: tier(total), dimensions, evidence };
}
