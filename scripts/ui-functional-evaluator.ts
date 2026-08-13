import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandPath, ensureDir, getVisualAssetDir, registerProcessCleanup } from "./utils.js";

export interface UiFunctionalValidation {
  enabled: boolean;
  status: "passed" | "failed" | "skipped";
  passedChecks: number;
  totalChecks: number;
  score: number;
  maxScore: number;
  reason?: string;
  output: string;
  screenshot?: string;
}

export const UI_MAX_SCORE = 15;
const TOTAL_CHECKS = 6;

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function startServer(projectDir: string, script: "start" | "dev", port: number): ChildProcess {
  const args = ["run", script, "--", ...(script === "start" ? ["--hostname", "127.0.0.1"] : ["--host", "127.0.0.1"]), "--port", String(port)];
  return spawn("npm", args, {
    cwd: projectDir,
    shell: false,
    detached: process.platform !== "win32",
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stopServer(server: ChildProcess): void {
  try {
    if (process.platform !== "win32" && server.pid) process.kill(-server.pid, "SIGTERM");
    else if (!server.killed) server.kill("SIGTERM");
  } catch {
    // already stopped
  }
}

async function serverScript(projectDir: string): Promise<"start" | "dev" | null> {
  try {
    const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
    if (typeof pkg.scripts?.start === "string") return "start";
    if (typeof pkg.scripts?.dev === "string") return "dev";
  } catch {
    // invalid package json
  }
  return null;
}

export async function runUiFunctionalEvaluator(
  projectDir: string,
  resultDir: string,
  benchmark: string,
  timeoutMs: number
): Promise<UiFunctionalValidation> {
  if (benchmark !== "greenfield") {
    return { enabled: false, status: "skipped", passedChecks: 0, totalChecks: 0, score: 0, maxScore: 0, reason: "not_applicable", output: "UI functional evaluator is only scored for greenfield." };
  }

  const executablePath = commandPath("google-chrome") ?? commandPath("chromium") ?? commandPath("chromium-browser");
  if (!executablePath) {
    return { enabled: true, status: "skipped", passedChecks: 0, totalChecks: TOTAL_CHECKS, score: 0, maxScore: UI_MAX_SCORE, reason: "chromium_not_found", output: "Playwright could not find a system Chrome/Chromium executable." };
  }

  const script = await serverScript(projectDir);
  if (!script) {
    return { enabled: true, status: "failed", passedChecks: 0, totalChecks: TOTAL_CHECKS, score: 0, maxScore: UI_MAX_SCORE, reason: "start_or_dev_script_missing", output: "package.json has neither start nor dev script." };
  }

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = startServer(projectDir, script, port);
  const unregisterServerCleanup = registerProcessCleanup(() => stopServer(server));
  let serverOutput = "";
  server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
  server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

  const log: string[] = [];
  let passedChecks = 0;
  const importDir = await mkdtemp(join(tmpdir(), "benchmark-import-"));
  const unique = `Benchmark Dune ${Date.now()}`;
  const importedTitle = `Benchmark Snow Crash ${Date.now()}`;

  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passedChecks += 1;
      log.push(`PASS ${name}`);
    } catch (error) {
      log.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let browser: any = null;
  try {
    const playwrightModule = "playwright-core";
    const { chromium } = await import(playwrightModule);
    browser = await chromium.launch({ executablePath, headless: true, timeout: timeoutMs, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("dialog", (dialog: { accept(): Promise<void> }) => void dialog.accept());
    const deadline = Date.now() + timeoutMs;
    let loaded = false;
    let lastNavigationError = "";
    while (Date.now() < deadline && !loaded) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(5_000, Math.max(1_000, deadline - Date.now())) });
        loaded = true;
      } catch (error) {
        lastNavigationError = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!loaded) throw new Error(`Could not load ${url}: ${lastNavigationError}`);

    await check("initial page loads without runtime error", async () => {
      if (pageErrors.length) throw new Error(pageErrors.join(" | "));
      await page.getByTestId("book-list").waitFor({ state: "visible", timeout: 5000 });
    });

    await check("creates a book through the UI", async () => {
      await page.getByTestId("add-book").click();
      await page.getByTestId("title-input").fill(unique);
      await page.getByTestId("author-input").fill("Frank Herbert");
      await page.getByTestId("status-select").selectOption("reading");
      const rating = page.getByTestId("rating-input");
      if (await rating.count()) await rating.fill("5");
      await page.getByTestId("save-book").click();
      await page.getByTestId("book-item").filter({ hasText: unique }).waitFor({ state: "visible", timeout: 7000 });
    });

    await check("searches case-insensitively through the UI", async () => {
      await page.getByTestId("search-input").fill(unique.toUpperCase());
      await page.getByTestId("book-item").filter({ hasText: unique }).waitFor({ state: "visible", timeout: 5000 });
    });

    await check("edits and persists status/rating through reload", async () => {
      const item = page.getByTestId("book-item").filter({ hasText: unique }).first();
      await item.getByTestId("edit-book").click();
      await page.getByTestId("status-select").selectOption("finished");
      const rating = page.getByTestId("rating-input");
      if (await rating.count()) await rating.fill("4");
      await page.getByTestId("save-book").click();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("search-input").fill(unique);
      const persisted = page.getByTestId("book-item").filter({ hasText: unique }).first();
      await persisted.waitFor({ state: "visible", timeout: 5000 });
      const status = await persisted.getAttribute("data-status");
      const persistedRating = await persisted.getAttribute("data-rating");
      if (status !== "finished") throw new Error(`expected data-status=finished, got ${status}`);
      if (persistedRating !== "4") throw new Error(`expected data-rating=4, got ${persistedRating}`);
    });

    await check("imports JSON through the UI", async () => {
      const filePath = join(importDir, "books.json");
      await writeFile(filePath, JSON.stringify({ books: [{
        id: "550e8400-e29b-41d4-a716-446655440010",
        title: importedTitle,
        author: "Neal Stephenson",
        status: "finished",
        rating: 5,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }] }), "utf-8");
      await page.getByTestId("import-json-input").setInputFiles(filePath);
      const submit = page.getByTestId("import-submit");
      if (await submit.count()) await submit.click();
      await page.getByTestId("search-input").fill(importedTitle);
      await page.getByTestId("book-item").filter({ hasText: importedTitle }).waitFor({ state: "visible", timeout: 7000 });
    });

    await check("deletes a book and keeps it deleted after reload", async () => {
      await page.getByTestId("search-input").fill(unique);
      const item = page.getByTestId("book-item").filter({ hasText: unique }).first();
      await item.getByTestId("delete-book").click();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("search-input").fill(unique);
      const count = await page.getByTestId("book-item").filter({ hasText: unique }).count();
      if (count !== 0) throw new Error("deleted book is still visible after reload");
    });

    const assetDir = getVisualAssetDir(benchmark, resultDir);
    ensureDir(assetDir);
    const screenshotPath = join(assetDir, "e2e-final.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const reportPath = `assets/${benchmark}/${resultDir.split("/").pop()}/e2e-final.png`;
    const score = Math.round((passedChecks / TOTAL_CHECKS) * UI_MAX_SCORE);
    return {
      enabled: true,
      status: passedChecks === TOTAL_CHECKS ? "passed" : "failed",
      passedChecks,
      totalChecks: TOTAL_CHECKS,
      score,
      maxScore: UI_MAX_SCORE,
      reason: passedChecks === TOTAL_CHECKS ? undefined : "one_or_more_ui_checks_failed",
      output: [...log, "", "--- server ---", serverOutput].join("\n"),
      screenshot: reportPath,
    };
  } catch (error) {
    return {
      enabled: true,
      status: "failed",
      passedChecks,
      totalChecks: TOTAL_CHECKS,
      score: Math.round((passedChecks / TOTAL_CHECKS) * UI_MAX_SCORE),
      maxScore: UI_MAX_SCORE,
      reason: "playwright_exception",
      output: [...log, String(error), "", "--- server ---", serverOutput].join("\n"),
    };
  } finally {
    await browser?.close().catch(() => undefined);
    stopServer(server);
    unregisterServerCleanup();
    await rm(importDir, { recursive: true, force: true });
  }
}
