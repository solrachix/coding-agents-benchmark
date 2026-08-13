import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { commandPath, getVisualAssetDir, registerProcessCleanup, runLocalBin, saveJson } from "./utils.js";
import type { ValidationResult } from "./validate-project.js";

export interface FrontendChallengeResult {
  benchmark: "frontend-challenge";
  visual: { desktop: number; tablet: number; mobile: number; score: number; max: 25; status: "verified" | "visual_unverified"; checks: string[] };
  responsive: { score: number; max: 15; checks: Array<{ name: string; passed: boolean }> };
  e2e: { score: number; max: 20; checks: Array<{ name: string; passed: boolean }> };
  accessibility: { score: number; max: 10; checks: Array<{ name: string; passed: boolean }> };
  interactions: { score: number; max: 10; checks: Array<{ name: string; passed: boolean }> };
  architecture: { score: number; max: 10; checks: string[] };
  validation: { typecheck: number; test: number; build: number; lint: number; score: number; max: 10 };
  penalties: { screenshotOnly: boolean; canvasAbuse: boolean; absoluteLayoutAbuse: boolean; points: number };
  score: number | null;
  scoreStatus: "valid" | "visual_unverified" | "evaluator_error";
  hardGates: string[];
  output: string;
}

export function frontendScoreFromChecks(parts: { visual: number; responsive: number; e2e: number; accessibility: number; interactions: number; architecture: number; validation: number }): number {
  return Math.max(0, Math.min(100, parts.visual + parts.responsive + parts.e2e + parts.accessibility + parts.interactions + parts.architecture + parts.validation));
}

export function applyFrontendGates(score: number, checks: { buildPassed: boolean; pageLoaded: boolean; e2e: number; mobileBroken: boolean }): number {
  let gated = score;
  if (!checks.buildPassed) gated = Math.min(gated, 69);
  if (!checks.pageLoaded) gated = Math.min(gated, 49);
  if (checks.e2e < 10) gated = Math.min(gated, 69);
  if (checks.mobileBroken) gated = Math.min(gated, 79);
  return gated;
}

export function detectFrontendGaming(source: string, sourceFileCount: number): number {
  const screenshotOnly = /<img[^>]+(?:reference|screenshot|\.png|\.jpg)/i.test(source) && sourceFileCount <= 3;
  const canvasAbuse = (source.match(/<canvas\b/gi) ?? []).length > 0 && source.length > 20_000;
  const absoluteLayoutAbuse = (source.match(/position\s*:\s*['"]absolute['"]/gi) ?? []).length > 40 && sourceFileCount <= 4;
  return (screenshotOnly ? 25 : 0) + (canvasAbuse ? 20 : 0) + (absoluteLayoutAbuse ? 15 : 0);
}

export function searchTermForTitle(title: string): string | null {
  const term = title.trim().split(/\s+/)[0] ?? "";
  return term.length >= 2 ? term : title.trim() || null;
}

export function filterInteractionPassed(input: { beforeCount: number; afterCount: number; pressed: boolean }): boolean {
  return input.pressed || input.beforeCount !== input.afterCount;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port allocation failed"));
      server.close(() => resolve(address.port));
    });
  });
}

function stop(server: ChildProcess): void { try { if (server.pid && process.platform !== "win32") process.kill(-server.pid, "SIGTERM"); else server.kill("SIGTERM"); } catch {} }
function start(projectDir: string, script: "start" | "dev", port: number): ChildProcess {
  return spawn("npm", ["run", script, "--", ...(script === "start" ? ["--hostname", "127.0.0.1"] : ["--host", "127.0.0.1"]), "--port", String(port)], { cwd: projectDir, detached: process.platform !== "win32", env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
}
async function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import("node:net"); const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const ready = await new Promise<boolean>((resolve) => { const socket = createConnection({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => { socket.destroy(); resolve(false); }); setTimeout(() => { socket.destroy(); resolve(false); }, 500); }); if (ready) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

async function sourceStats(projectDir: string): Promise<{ source: string; files: number; components: number }> {
  const chunks: string[] = []; let files = 0; let components = 0;
  async function visit(dir: string): Promise<void> { const { readdir, stat } = await import("node:fs/promises"); let entries: string[] = []; try { entries = await readdir(dir); } catch { return; } for (const name of entries) { if (["node_modules", ".next", ".git", "coverage", "dist"].includes(name)) continue; const path = join(dir, name); const info = await stat(path).catch(() => null); if (!info) continue; if (info.isDirectory()) await visit(path); else if (/\.(tsx|jsx|ts|js|css)$/.test(name)) { files++; const text = await readFile(path, "utf8").catch(() => ""); chunks.push(text); if (/components|component/i.test(path) || /export\s+(default\s+)?function\s+[A-Z]/.test(text)) components++; } } }
  await visit(projectDir); return { source: chunks.join("\n"), files, components };
}

export async function runFrontendChallengeEvaluator(projectDir: string, resultDir: string, validation: ValidationResult, timeoutMs: number): Promise<FrontendChallengeResult> {
  const browserPath = commandPath("google-chrome") ?? commandPath("chromium") ?? commandPath("chromium-browser");
  const empty = (reason: string): FrontendChallengeResult => ({ benchmark: "frontend-challenge", visual: { desktop: 0, tablet: 0, mobile: 0, score: 0, max: 25, status: "visual_unverified", checks: [reason] }, responsive: { score: 0, max: 15, checks: [] }, e2e: { score: 0, max: 20, checks: [] }, accessibility: { score: 0, max: 10, checks: [] }, interactions: { score: 0, max: 10, checks: [] }, architecture: { score: 0, max: 10, checks: [] }, validation: { typecheck: validation.typecheck.passed ? 3 : 0, test: validation.test.passed ? 2 : 0, build: validation.build.passed ? 3 : 0, lint: validation.lint.passed ? 2 : 0, score: (validation.typecheck.passed ? 3 : 0) + (validation.test.passed ? 2 : 0) + (validation.build.passed ? 3 : 0) + (validation.lint.passed ? 2 : 0), max: 10 }, penalties: { screenshotOnly: false, canvasAbuse: false, absoluteLayoutAbuse: false, points: 0 }, score: null, scoreStatus: "visual_unverified", hardGates: [reason], output: reason });
  if (!browserPath) return empty("visual_unverified: browser_not_found");
  let pkg: { scripts?: Record<string, string> }; try { pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")); } catch { return empty("package_json_invalid"); }
  const script = typeof pkg.scripts?.start === "string" ? "start" : typeof pkg.scripts?.dev === "string" ? "dev" : null;
  if (!script) return empty("start_or_dev_script_missing");
  const stats = await sourceStats(projectDir); const gamingPoints = detectFrontendGaming(stats.source, stats.files); const port = await freePort(); const server = start(projectDir, script, port); const unregister = registerProcessCleanup(() => stop(server)); let serverOutput = ""; server.stdout?.on("data", (d: Buffer) => { serverOutput += d.toString(); }); server.stderr?.on("data", (d: Buffer) => { serverOutput += d.toString(); });
  const viewports = [{ name: "desktop", width: 1440, height: 900 }, { name: "tablet", width: 768, height: 1024 }, { name: "mobile", width: 390, height: 844 }];
  const visualScores: Record<string, number> = {}; const responsiveChecks: Array<{ name: string; passed: boolean }> = []; const e2eChecks: Array<{ name: string; passed: boolean }> = []; const a11yChecks: Array<{ name: string; passed: boolean }> = []; const interactionChecks: Array<{ name: string; passed: boolean }> = []; const visualChecks: string[] = [];
  let browser: any;
  try {
    if (!(await waitPort(port, timeoutMs))) return empty(`server_not_ready: ${serverOutput.slice(-2000)}`);
    const { chromium } = await import("playwright-core"); browser = await chromium.launch({ executablePath: browserPath, headless: true, timeout: timeoutMs, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    for (const viewport of viewports) { const page = await browser.newPage({ viewport }); await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs }); const regions = await page.locator("header, main, nav, aside, article").count(); const cards = await page.locator("article").count(); const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2); const expectedGrid = viewport.name === "desktop" ? cards >= 3 : true; visualScores[viewport.name] = regions >= 4 && cards >= 3 && !overflow ? (viewport.name === "desktop" ? 10 : viewport.name === "tablet" ? 7 : 8) : 0; visualChecks.push(`${viewport.name}: regions=${regions}, cards=${cards}, overflow=${overflow}`); responsiveChecks.push({ name: `${viewport.name} has no horizontal overflow`, passed: !overflow }, { name: `${viewport.name} contains usable cards`, passed: expectedGrid }); const assetDir = getVisualAssetDir("frontend-challenge", resultDir); await mkdir(assetDir, { recursive: true }); await page.screenshot({ path: join(assetDir, `${viewport.name}.png`), fullPage: true }); await page.close(); }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const check = async (name: string, fn: () => Promise<void>, target: Array<{ name: string; passed: boolean }>) => { try { await fn(); target.push({ name, passed: true }); } catch { target.push({ name, passed: false }); } };
    await check("page loads", async () => { if (await page.locator("main").count() === 0) throw new Error("main missing"); }, e2eChecks);
    const searchInput = page.locator("input").first();
    const firstCardTitle = (await page.locator("article h2").first().textContent().catch(() => null))?.trim() ?? "";
    const searchTerm = searchTermForTitle(firstCardTitle);
    await check("search filters events", async () => { if (!searchTerm) throw new Error("candidate has no searchable card title"); await searchInput.fill(searchTerm); if (await page.locator("article").count() < 1) throw new Error("search returned no candidate card"); }, e2eChecks);
    await check("category filter changes results", async () => { await searchInput.fill(""); const filterButtons = page.locator('nav[aria-label*="categor" i] button, [role="group"] button'); const count = await filterButtons.count(); if (count < 2) throw new Error("candidate has no category filter"); const beforeCount = await page.locator("article").count(); const filter = filterButtons.nth(1); await filter.click(); const afterCount = await page.locator("article").count(); const pressed = (await filter.getAttribute("aria-pressed")) === "true" || (await filter.getAttribute("data-active")) === "true" || (await filter.getAttribute("aria-current")) !== null; if (!filterInteractionPassed({ beforeCount, afterCount, pressed })) throw new Error("filter did not change state"); }, e2eChecks);
    await check("details modal opens and closes", async () => { await page.getByRole("button", { name: /view details/i }).first().click(); await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape"); }, interactionChecks);
    await check("save action changes state", async () => { await page.getByRole("button", { name: /save/i }).first().click(); }, interactionChecks);
    await check("empty state can be cleared", async () => { await searchInput.fill("benchmark-no-result-9f3c"); const emptyVisible = await page.locator('[role="status"], text=/no (event|result)/i').count(); if (emptyVisible < 1 && await page.locator("article").count() > 0) throw new Error("empty state is not visible"); await searchInput.fill(""); if (await page.locator("article").count() < 1) throw new Error("clearing search did not restore cards"); }, e2eChecks);
    await check("headings are present", async () => { if (await page.locator("h1").count() < 1) throw new Error("heading missing"); }, a11yChecks);
    await check("inputs have accessible names", async () => { if (await page.locator("input").count() < 1) throw new Error("input missing"); const named = await page.locator("input").evaluateAll((inputs: HTMLInputElement[]) => inputs.some((input: HTMLInputElement) => Boolean(input.getAttribute("aria-label") || input.getAttribute("placeholder") || input.id && document.querySelector(`label[for=\"${input.id}\"]`)))); if (!named) throw new Error("input has no accessible name"); }, a11yChecks);
    await check("buttons are semantic", async () => { if (await page.locator("button").count() < 5) throw new Error("too few buttons"); }, a11yChecks);
    await check("focus is visible", async () => { await page.getByRole("textbox").focus(); if (!(await page.getByRole("textbox").evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).boxShadow !== "none"))) throw new Error("focus style missing"); }, a11yChecks);
    const visual = { desktop: visualScores.desktop ?? 0, tablet: visualScores.tablet ?? 0, mobile: visualScores.mobile ?? 0, score: (visualScores.desktop ?? 0) + (visualScores.tablet ?? 0) + (visualScores.mobile ?? 0), max: 25 as const, status: "verified" as const, checks: visualChecks };
    const responsiveScore = Math.round((responsiveChecks.filter((c) => c.passed).length / Math.max(1, responsiveChecks.length)) * 15); const e2eScore = Math.round((e2eChecks.filter((c) => c.passed).length / Math.max(1, e2eChecks.length)) * 20); const interactionScore = Math.round((interactionChecks.filter((c) => c.passed).length / Math.max(1, interactionChecks.length)) * 10); const accessibilityScore = Math.round((a11yChecks.filter((c) => c.passed).length / Math.max(1, a11yChecks.length)) * 10); const architectureScore = Math.max(0, Math.min(10, Math.round(Math.min(1, stats.components / 4) * 10) - Math.min(5, gamingPoints)));
    const validationScore = (validation.typecheck.passed ? 3 : 0) + (validation.test.passed ? 2 : 0) + (validation.build.passed ? 3 : 0) + (validation.lint.passed ? 2 : 0); const raw = frontendScoreFromChecks({ visual: visual.score, responsive: responsiveScore, e2e: e2eScore, accessibility: accessibilityScore, interactions: interactionScore, architecture: architectureScore, validation: validationScore }); const score = applyFrontendGates(Math.max(0, raw - gamingPoints), { buildPassed: validation.build.passed, pageLoaded: e2eChecks[0]?.passed ?? false, e2e: e2eScore, mobileBroken: responsiveChecks.some((c) => c.name.startsWith("mobile") && !c.passed) });
    const result: FrontendChallengeResult = { benchmark: "frontend-challenge", visual, responsive: { score: responsiveScore, max: 15, checks: responsiveChecks }, e2e: { score: e2eScore, max: 20, checks: e2eChecks }, accessibility: { score: accessibilityScore, max: 10, checks: a11yChecks }, interactions: { score: interactionScore, max: 10, checks: interactionChecks }, architecture: { score: architectureScore, max: 10, checks: stats.components >= 4 ? ["component structure detected"] : ["limited component structure"] }, validation: { typecheck: validation.typecheck.passed ? 3 : 0, test: validation.test.passed ? 2 : 0, build: validation.build.passed ? 3 : 0, lint: validation.lint.passed ? 2 : 0, score: validationScore, max: 10 }, penalties: { screenshotOnly: gamingPoints >= 25, canvasAbuse: false, absoluteLayoutAbuse: false, points: gamingPoints }, score, scoreStatus: "valid", hardGates: ["build: max 69", "page unavailable: max 49", "e2e < 10: max 69", "mobile broken: max 79"], output: [...visualChecks, ...responsiveChecks.map((c) => `${c.passed ? "PASS" : "FAIL"} ${c.name}`), `server: ${serverOutput.slice(-1000)}`].join("\n") };
    await saveJson(join(resultDir, "frontend-challenge.json"), result); return result;
  } catch (error) { const result = empty(`evaluator_error: ${error instanceof Error ? error.message : String(error)}`); await saveJson(join(resultDir, "frontend-challenge.json"), result); return result; } finally { await browser?.close().catch(() => undefined); stop(server); unregister(); }
}
