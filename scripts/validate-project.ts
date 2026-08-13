import { join } from "node:path";
import { writeFile, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  runNpmInstall,
  runNpmScript,
  runLocalBin,
  maskSecrets,
} from "./utils.js";
import { runHiddenEvaluator, type FunctionalValidation } from "./hidden-evaluator.js";

export interface ValidationResult {
  install: { enabled: boolean; passed: boolean; output: string };
  typecheck: { enabled: boolean; passed: boolean; output: string };
  test: { enabled: boolean; passed: boolean; output: string };
  build: { enabled: boolean; passed: boolean; output: string };
  lint: { enabled: boolean; passed: boolean; output: string };
  functional: FunctionalValidation;
  installDurationSeconds: number;
  readmeExists: boolean;
  packageJsonExists: boolean;
}

async function scriptExists(projectDir: string, script: string): Promise<boolean> {
  try {
    const pkgPath = join(projectDir, "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    return typeof pkg.scripts?.[script] === "string";
  } catch {
    return false;
  }
}

type ValidationConfig = {
  install: boolean;
  typecheck: boolean;
  test: boolean;
  build: boolean;
  lint: boolean;
};

const ALL_VALIDATIONS: ValidationConfig = {
  install: true,
  typecheck: true,
  test: true,
  build: true,
  lint: true,
};

function skipped(enabled: boolean, name: string) {
  return { enabled, passed: !enabled, output: enabled ? "" : `Skipped: ${name} desabilitado` };
}

async function runDirectOrScript(
  projectDir: string,
  script: string,
  bin: string,
  args: string[],
  timeout: number
): Promise<{ exitCode: number; output: string }> {
  const direct = await runLocalBin(bin, args, projectDir, timeout);
  if (direct !== null) return direct;
  if (await scriptExists(projectDir, script)) return runNpmScript(script, projectDir, timeout);
  return { exitCode: 1, output: `Validação '${script}' indisponível: binário local e script ausentes.` };
}

export async function validateProject(
  projectDir: string,
  timeoutMinutes: number,
  validations: ValidationConfig = ALL_VALIDATIONS,
  benchmark = "greenfield"
): Promise<ValidationResult> {
  const timeout = timeoutMinutes * 60 * 1000;
  const result: ValidationResult = {
    install: skipped(validations.install, "install"),
    typecheck: skipped(validations.typecheck, "typecheck"),
    test: skipped(validations.test, "test"),
    build: skipped(validations.build, "build"),
    lint: skipped(validations.lint, "lint"),
    functional: { enabled: true, status: "evaluator_error", passed: false, passedTests: 0, totalTests: 7, score: 0, maxScore: 35, output: "Not run", reason: "not_run" },
    installDurationSeconds: 0,
    readmeExists: false,
    packageJsonExists: false,
  };

  try { await access(join(projectDir, "README.md")); result.readmeExists = true; } catch {}
  try { await access(join(projectDir, "package.json")); result.packageJsonExists = true; } catch {}

  if (validations.install) {
    const installStarted = Date.now();
    const installRes = await runNpmInstall(projectDir, timeout);
    result.installDurationSeconds = Math.round((Date.now() - installStarted) / 100) / 10;
    result.install = { enabled: true, passed: installRes.exitCode === 0, output: maskSecrets(installRes.output) };
    if (!result.install.passed) return result;
  }

  if (validations.typecheck) {
    const res = await runDirectOrScript(projectDir, "typecheck", "tsc", ["--noEmit"], timeout);
    result.typecheck = { enabled: true, passed: res.exitCode === 0, output: maskSecrets(res.output) };
  }

  if (validations.test) {
    // Do not trust the candidate-controlled `npm test` script for scoring.
    // Execute a supported local test runner directly.
    const vitest = await runLocalBin("vitest", ["run"], projectDir, timeout);
    const jest = vitest === null ? await runLocalBin("jest", ["--runInBand"], projectDir, timeout) : null;
    const res = vitest ?? jest;
    if (res) {
      result.test = { enabled: true, passed: res.exitCode === 0, output: maskSecrets(res.output) };
    } else {
      result.test = { enabled: true, passed: false, output: "Nenhum runner suportado encontrado diretamente (Vitest/Jest). O script npm test não é usado para pontuação." };
    }
  }

  if (validations.build) {
    const res = await runDirectOrScript(projectDir, "build", "next", ["build"], timeout);
    result.build = { enabled: true, passed: res.exitCode === 0, output: maskSecrets(res.output) };
  }

  if (validations.lint) {
    const eslintConfigExists = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs"]
      .some((name) => existsSync(join(projectDir, name)));
    const res = eslintConfigExists
      ? await runDirectOrScript(projectDir, "lint", "eslint", ["."], timeout)
      : await (async () => (await scriptExists(projectDir, "lint"))
          ? runNpmScript("lint", projectDir, timeout)
          : { exitCode: 1, output: "Configuração/script de lint não encontrado." })();
    result.lint = { enabled: true, passed: res.exitCode === 0, output: maskSecrets(res.output) };
  }

  // The evaluator is injected only after the coding agent has exited.
  result.functional = await runHiddenEvaluator(projectDir, timeout);
  return result;
}

export async function saveValidationLog(projectDir: string, result: ValidationResult): Promise<void> {
  const logPath = join(projectDir, "..", "validation.log");
  const status = (check: { enabled: boolean; passed: boolean }): string =>
    !check.enabled ? "SKIP" : check.passed ? "PASS" : "FAIL";
  const lines: string[] = [
    `install: ${status(result.install)}`, result.install.output, "---",
    `typecheck: ${status(result.typecheck)}`, result.typecheck.output, "---",
    `test: ${status(result.test)}`, result.test.output, "---",
    `build: ${status(result.build)}`, result.build.output, "---",
    `lint: ${status(result.lint)}`, result.lint.output, "---",
    `hidden-functional: ${result.functional.status === "evaluator_error" ? "ERROR" : status(result.functional)} (${result.functional.passedTests}/${result.functional.totalTests}, ${result.functional.score}/${result.functional.maxScore})${result.functional.reason ? ` reason=${result.functional.reason}` : ""}`,
    result.functional.output, "---",
    `readmeExists: ${result.readmeExists}`,
    `packageJsonExists: ${result.packageJsonExists}`,
  ];
  await writeFile(logPath, lines.join("\n"), "utf-8");
}
