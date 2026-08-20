import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";

export const ROOT = resolve(import.meta.dirname, "..");
export const RESULTS_DIR = join(ROOT, "results");
export const REPORTS_DIR = join(ROOT, "reports");
export const CONFIG_DIR = join(ROOT, "config");
export const PROMPTS_DIR = join(ROOT, "prompts");
export const FIXTURES_DIR = join(ROOT, "fixtures");

export class CampaignAbortError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "CampaignAbortError";
  }
}

export async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let abortError: unknown;
  async function consume(): Promise<void> {
    while (true) {
      if (abortError) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        abortError ??= error;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
  if (abortError) throw abortError;
  return results;
}

const activeProcessCleanups = new Set<() => void>();
let signalCleanupInstalled = false;

function installSignalCleanup(): void {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const cleanup of activeProcessCleanups) cleanup();
      process.exit(130);
    });
  }
}

export function registerProcessCleanup(cleanup: () => void): () => void {
  installSignalCleanup();
  activeProcessCleanups.add(cleanup);
  return () => activeProcessCleanups.delete(cleanup);
}

export function getVisualAssetDir(benchmark: string, resultDir: string): string {
  const relativeResultDir = relative(RESULTS_DIR, resultDir);
  const fallback = join(benchmark, relativeResultDir);
  return join(REPORTS_DIR, "assets", relativeResultDir || fallback);
}

export function getVisualAssetPath(benchmark: string, resultDir: string, name = "home.png"): string {
  return join(getVisualAssetDir(benchmark, resultDir), name);
}

export interface ModelConfig {
  id: string;
  enabled: boolean;
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelsConfig {
  opencode: ModelConfig[];
  codex: ModelConfig[];
  copilot: ModelConfig[];
}

export interface BenchmarkConfig {
  rounds: number;
  timeoutMinutes: number;
  shuffleRuns?: boolean;
  campaignSeed?: number;
  nodeVersion: string;
  packageManager: string;
  rubricVersion?: string;
  validations: {
    install: boolean;
    typecheck: boolean;
    test: boolean;
    build: boolean;
    lint: boolean;
  };
  visual?: {
    enabled: boolean;
    timeoutSeconds: number;
  };
  uiFunctional?: {
    enabled: boolean;
    timeoutSeconds: number;
  };
}

export function slugifyModel(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function parseModelId(modelId: string): { provider: string; model: string } {
  // e.g. "opencode/gpt-5.4-mini" -> provider="opencode-go", model="gpt-5.4-mini"
  // e.g. "gpt-5.4-mini" -> provider="openai", model="gpt-5.4-mini"
  const parts = modelId.split("/");
  if (parts.length === 2) {
    const providerMap: Record<string, string> = {
      opencode: "opencode-go",
      deepseek: "deepseek",
      openrouter: "openrouter",
    };
    return {
      provider: providerMap[parts[0]] ?? parts[0],
      model: parts[1],
    };
  }
  return { provider: "openai", model: modelId };
}

export function validateWorkspacePath(cwd: string, root: string): void {
  const resolvedCwd = resolve(cwd);
  const resolvedRoot = resolve(root);
  if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(`${resolvedRoot}/`)) {
    throw new Error(
      `Workspace path validation failed: ${resolvedCwd} is outside of ${resolvedRoot}`
    );
  }
}

export function detectHarnessError(output: string): { harnessError: boolean; harnessErrorType?: string } {
  if (/"code"\s*:\s*"deepseek_reasoning_content"/i.test(output)) {
    return { harnessError: true, harnessErrorType: "deepseek_reasoning_content" };
  }
  if (/token_expired|Provided authentication token is expired/i.test(output)) {
    return { harnessError: true, harnessErrorType: "authentication_expired" };
  }
  if (/CreditsError|Insufficient balance|exceeded your monthly quota/i.test(output)) {
    return { harnessError: true, harnessErrorType: "provider_credits" };
  }
  if (output.includes("context_length_exceeded") || output.includes("maximum context length")) {
    return { harnessError: true, harnessErrorType: "context_length_exceeded" };
  }
  if (/Copilot CLI not found|install copilot|Copilot SDK error/i.test(output)) {
    return { harnessError: true, harnessErrorType: "copilot_sdk_runtime" };
  }
  return { harnessError: false };
}

export function classifyProcessFailure(
  exitCode: number,
  current: { harnessError: boolean; harnessErrorType?: string },
  processInfo?: { timedOut?: boolean; signal?: NodeJS.Signals | null }
): { harnessError: boolean; harnessErrorType?: string } {
  if (current.harnessError) return current;
  if (processInfo?.timedOut) return { harnessError: true, harnessErrorType: "agent_timeout" };
  if (exitCode === 0) return current;
  if (processInfo?.signal) return { harnessError: true, harnessErrorType: `process_signal_${processInfo.signal}` };
  return { harnessError: true, harnessErrorType: `process_exit_${exitCode}` };
}

export function projectHasManifest(projectDir: string): boolean {
  return existsSync(join(projectDir, "package.json"));
}

export function getResultDir(benchmark: string, engine: string, model: string, round: number, reasoningEffort?: ReasoningEffort, executionId?: string): string {
  const effortSlug = reasoningEffort ? `__effort-${reasoningEffort}` : "";
  const executionSlug = executionId ? `__execution-${slugifyModel(executionId)}` : "";
  const slug = `${engine}__${slugifyModel(model)}${effortSlug}__round-${round}${executionSlug}`;
  return join(RESULTS_DIR, benchmark, slug);
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function cleanDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

export async function loadJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

export async function saveJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export function formatDuration(ms: number): number {
  return Math.round(ms / 100) / 10; // 1 decimal place
}

export function createExecutionId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(".", "");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

export function hashText(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function initializeIsolatedGit(projectDir: string): boolean {
  if (existsSync(join(projectDir, ".git"))) return false;
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "benchmark@local.invalid"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Benchmark Baseline"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "benchmark baseline"], { cwd: projectDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function archiveCurrentReports(executionId: string): Promise<string[]> {
  const archiveDir = join(REPORTS_DIR, "archive", executionId);
  const archived: string[] = [];
  for (const filename of ["report.md", "report.json"]) {
    const source = join(REPORTS_DIR, filename);
    if (!existsSync(source)) continue;
    ensureDir(archiveDir);
    const destination = join(archiveDir, filename);
    await rename(source, destination);
    archived.push(destination);
  }
  return archived;
}

export async function archiveCurrentResults(executionId: string): Promise<string[]> {
  const archiveRoot = join(RESULTS_DIR, "archive", executionId);
  const archived: string[] = [];
  if (!existsSync(RESULTS_DIR)) return archived;

  for (const benchmark of readdirSync(RESULTS_DIR)) {
    if (benchmark === "archive") continue;
    const source = join(RESULTS_DIR, benchmark);
    const info = statSync(source);
    if (info.isFile()) {
      ensureDir(archiveRoot);
      const destination = join(archiveRoot, benchmark);
      await rename(source, destination);
      archived.push(destination);
      continue;
    }
    if (!info.isDirectory()) continue;
    const destination = join(archiveRoot, benchmark);
    ensureDir(archiveRoot);
    await rename(source, destination);
    archived.push(destination);
  }
  return archived;
}


export function commandPath(cmd: string): string | null {
  try {
    return execFileSync("bash", ["-lc", `command -v ${JSON.stringify(cmd)}`], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function maskSecrets(input: string): string {
  return input
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "***REDACTED***")
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/g, "Bearer ***REDACTED***")
    .replace(/api[_-]?key[:=\s]+[a-zA-Z0-9_-]+/gi, "api_key=***REDACTED***");
}

export async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  options?: {
    timeout?: number;
    env?: Record<string, string | undefined>;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      detached: useProcessGroup,
      env: { ...process.env, ...options?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = options?.timeout ?? 10 * 60 * 1000;

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (useProcessGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Process may already be gone.
      }
    };
    const unregisterCleanup = registerProcessCleanup(() => killTree("SIGTERM"));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5000).unref();
    }, timeout);

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString("utf-8"); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString("utf-8"); });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      unregisterCleanup();
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut, signal });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      unregisterCleanup();
      resolve({ exitCode: 1, stdout, stderr: stderr + "\n" + String(err), timedOut, signal: null });
    });
  });
}

export async function resolveBinPath(cwd: string, binName: string): Promise<string | null> {
  try {
    const candidates = [
      join(cwd, "node_modules", binName, "bin", `${binName}.js`),
      join(cwd, "node_modules", binName, "dist", "cli.mjs"),
      join(cwd, "node_modules", binName, "dist", "cli.js"),
      join(cwd, "node_modules", binName, "bin", binName),
      join(cwd, "node_modules", binName, "vitest.mjs"),
      join(cwd, "node_modules", binName, "bin", `${binName}.mjs`),
      join(cwd, "node_modules", ".bin", binName),
    ];
    // Hard-coded overrides for known packages when generic paths don't exist
    const overrides: Record<string, string> = {
      tsc: join(cwd, "node_modules", "typescript", "bin", "tsc"),
      eslint: join(cwd, "node_modules", "eslint", "bin", "eslint.js"),
      next: join(cwd, "node_modules", "next", "dist", "bin", "next"),
    };
    if (overrides[binName] && existsSync(overrides[binName])) {
      return overrides[binName];
    }
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function runLocalBin(
  binName: string,
  args: string[],
  cwd: string,
  timeout?: number
): Promise<{ exitCode: number; output: string } | null> {
  const binPath = await resolveBinPath(cwd, binName);
  if (!binPath) return null;
  const result = await runCommand("node", [binPath, ...args], cwd, { timeout });
  return { exitCode: result.exitCode, output: result.stdout + "\n" + result.stderr };
}

export async function runNpmScript(
  script: string,
  cwd: string,
  timeout?: number
): Promise<{ exitCode: number; output: string }> {
  // Prefer npm run for composite scripts; fallback to direct bin path
  // to work around broken symlinks/copies in node_modules/.bin on some filesystems.
  let result = await runCommand("npm", ["run", script], cwd, { timeout });

  const isBinLinkError =
    result.exitCode !== 0 &&
    (result.stderr.includes("Cannot find module") || result.stderr.includes("ERR_MODULE_NOT_FOUND"));

  if (isBinLinkError) {
    try {
      const pkgPath = join(cwd, "package.json");
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const scriptValue: string | undefined = pkg.scripts?.[script];
      if (typeof scriptValue === "string") {
        const tokens = scriptValue.trim().split(/\s+/);
        const binName = tokens[0];
        const binPath = await resolveBinPath(cwd, binName);
        if (binPath) {
          const args = tokens.slice(1);
          result = await runCommand("node", [binPath, ...args], cwd, { timeout });
        }
      }
    } catch {
      // ignore fallback errors and keep original result
    }
  }

  return {
    exitCode: result.exitCode,
    output: result.stdout + "\n" + result.stderr,
  };
}

export async function runNpmInstall(cwd: string, timeout?: number): Promise<{ exitCode: number; output: string }> {
  const result = await runCommand("npm", ["install"], cwd, { timeout });
  return {
    exitCode: result.exitCode,
    output: result.stdout + "\n" + result.stderr,
  };
}

const IGNORED_COPY = new Set([
  "node_modules",
  ".next",
  "dist",
  ".git",
  "prisma/dev.db",
  "prisma/dev.db-journal",
  ".DS_Store",
  "coverage",
]);

export function copyFixture(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readdirSync(src);
  for (const entry of entries) {
    if (IGNORED_COPY.has(entry)) continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyFixture(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
