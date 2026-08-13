import { join } from "node:path";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface Penalties {
  testsRemoved: boolean;
  testsModified: boolean;
  validationScriptsModified: boolean;
  prismaRemoved: boolean;
  usedAny: boolean;
  usedTsIgnore: boolean;
  usedTsExpectError: boolean;
  usedEslintDisable: boolean;
  jsonImportNotFixed: boolean;
  appRewritten: boolean;
  penaltyPoints: number;
}

const IGNORED_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".git", ".benchmark-evaluator", "generated", ".prisma"]);

function countTestFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory() && !IGNORED_DIRS.has(entry)) count += countTestFiles(fullPath);
      else if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry)) count++;
    }
  } catch {}
  return count;
}

function grepFiles(dir: string, pattern: RegExp): boolean {
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory() && !IGNORED_DIRS.has(entry)) {
        if (grepFiles(fullPath, pattern)) return true;
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        const content = readFileSync(fullPath, "utf-8");
        pattern.lastIndex = 0;
        if (pattern.test(content)) return true;
      }
    }
  } catch {}
  return false;
}

function hasSilentErrorHandling(projectDir: string): boolean {
  try {
    const content = readFileSync(join(projectDir, "src", "lib", "import.ts"), "utf-8");
    return /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}/.test(content) ||
      /catch\s*(?:\([^)]*\))?\s*\{[^}]*continue\s*;?[^}]*\}/s.test(content);
  } catch {
    return false;
  }
}

function gitDiffNames(projectDir: string, pathspec: string[]): string[] {
  if (!existsSync(join(projectDir, ".git"))) return [];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...pathspec], { cwd: projectDir, encoding: "utf-8" });
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function baselinePackageScripts(projectDir: string): Record<string, string> | null {
  try {
    const raw = execFileSync("git", ["show", "HEAD:package.json"], { cwd: projectDir, encoding: "utf-8" });
    return JSON.parse(raw).scripts ?? {};
  } catch {
    return null;
  }
}

function currentPackageScripts(projectDir: string): Record<string, string> | null {
  try { return JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")).scripts ?? {}; } catch { return null; }
}

function validationScriptsChanged(projectDir: string): boolean {
  const before = baselinePackageScripts(projectDir);
  const after = currentPackageScripts(projectDir);
  if (!before || !after) return false;
  return ["typecheck", "test", "build", "lint"].some((key) => before[key] !== after[key]);
}

function sourceRewriteRatio(projectDir: string): number {
  if (!existsSync(join(projectDir, ".git"))) return 0;
  try {
    const diff = execFileSync("git", ["diff", "--numstat", "HEAD", "--", "src"], { cwd: projectDir, encoding: "utf-8" });
    const changed = diff.split("\n").filter(Boolean).reduce((sum, line) => {
      const [a, d] = line.split("\t");
      return sum + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
    const baseline = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "src"], { cwd: projectDir, encoding: "utf-8" })
      .split("\n").filter((p) => /\.(ts|tsx|js|jsx)$/.test(p))
      .reduce((sum, file) => {
        try {
          const content = execFileSync("git", ["show", `HEAD:${file}`], { cwd: projectDir, encoding: "utf-8" });
          return sum + Math.max(1, content.split("\n").length);
        } catch { return sum; }
      }, 0);
    return baseline > 0 ? changed / baseline : 0;
  } catch {
    return 0;
  }
}

export function detectPenalties(projectDir: string, fixtureDir: string | null, benchmark: string): Penalties {
  const penalties: Penalties = {
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

  if (benchmark === "bugfix" && fixtureDir) {
    penalties.testsRemoved = countTestFiles(projectDir) < countTestFiles(fixtureDir);
    penalties.testsModified = gitDiffNames(projectDir, ["tests"]).length > 0;
    penalties.validationScriptsModified = validationScriptsChanged(projectDir);
    penalties.prismaRemoved = !existsSync(join(projectDir, "prisma", "schema.prisma"));
    penalties.appRewritten = sourceRewriteRatio(projectDir) > 0.7;
    penalties.jsonImportNotFixed = hasSilentErrorHandling(projectDir);
  }

  penalties.usedAny = grepFiles(projectDir, /(?:\:\s*any\b|\bas\s+any\b|<any>|\b(?:Promise|Array)<any>)/);
  penalties.usedTsIgnore = grepFiles(projectDir, /@ts-ignore/);
  penalties.usedTsExpectError = grepFiles(projectDir, /@ts-expect-error/);
  penalties.usedEslintDisable = grepFiles(projectDir, /eslint-disable/);

  if (penalties.testsRemoved) penalties.penaltyPoints += 20;
  if (penalties.testsModified) penalties.penaltyPoints += 20;
  if (penalties.validationScriptsModified) penalties.penaltyPoints += 15;
  if (penalties.prismaRemoved) penalties.penaltyPoints += 15;
  if (penalties.appRewritten) penalties.penaltyPoints += 10;
  if (penalties.jsonImportNotFixed) penalties.penaltyPoints += 5;
  if (penalties.usedAny) penalties.penaltyPoints += 5;
  if (penalties.usedTsIgnore) penalties.penaltyPoints += 5;
  if (penalties.usedTsExpectError) penalties.penaltyPoints += 3;
  if (penalties.usedEslintDisable) penalties.penaltyPoints += 3;

  return penalties;
}
