import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commandExists,
  ensureDir,
  getVisualAssetPath,
  REPORTS_DIR,
  registerProcessCleanup,
  runCommand,
  saveJson,
} from "./utils.js";
import type { BenchmarkConfig } from "./utils.js";

export interface VisualScreenshot {
  name: string;
  reportPath: string;
}

export interface VisualCaptureResult {
  status: "captured" | "skipped" | "failed";
  browser: "agent-browser" | "google-chrome" | null;
  screenshots: VisualScreenshot[];
  reason?: string;
  diagnostic?: string;
}

export function selectBrowser(): "agent-browser" | "google-chrome" | null {
  if (commandExists("agent-browser")) return "agent-browser";
  if (commandExists("google-chrome")) return "google-chrome";
  return null;
}

export function selectServerScript(packageJson: { scripts?: Record<string, string> }): "start" | "dev" | null {
  if (typeof packageJson.scripts?.start === "string") return "start";
  if (typeof packageJson.scripts?.dev === "string") return "dev";
  return null;
}

function browserArgs(session: string, command: string, ...args: string[]): string[] {
  return ["--session", session, command, ...args];
}

export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function startServer(projectDir: string, script: "start" | "dev", port: number): ChildProcess {
  const args = ["run", script, "--", ...(script === "start"
    ? ["--hostname", "127.0.0.1"]
    : ["--host", "127.0.0.1"]), "--port", String(port)];
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

async function captureWithChrome(
  url: string,
  screenshotPath: string,
  projectDir: string,
  timeoutMs: number
): Promise<{ exitCode: number }> {
  const profileDir = await mkdtemp(join(tmpdir(), "benchmark-chrome-"));
  try {
    return await runCommand("google-chrome", [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--window-size=1440,1000",
      "--virtual-time-budget=3000",
      `--user-data-dir=${profileDir}`,
      `--screenshot=${screenshotPath}`,
      url,
    ], projectDir, { timeout: timeoutMs });
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

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
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function captureVisual(
  projectDir: string,
  resultDir: string,
  benchmark: string,
  config: BenchmarkConfig["visual"]
): Promise<VisualCaptureResult> {
  const skipped = (reason: string): VisualCaptureResult => ({
    status: "skipped",
    browser: null,
    screenshots: [],
    reason,
  });

  if (!config?.enabled) return skipped("disabled_in_config");
  if (!existsSync(join(projectDir, "package.json"))) return skipped("package_json_missing");
  let browser = selectBrowser();
  if (!browser) return skipped("browser_not_found");

  let packageJson: { scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"));
  } catch {
    return skipped("package_json_invalid");
  }

  const script = selectServerScript(packageJson);
  if (!script) return skipped("start_or_dev_script_missing");

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const session = `benchmark-${benchmark}-${resultDir.split("/").pop() ?? "run"}`;
  const screenshotPath = getVisualAssetPath(benchmark, resultDir);
  ensureDir(join(REPORTS_DIR, "assets", benchmark, resultDir.split("/").pop() ?? "run"));
  const server = startServer(projectDir, script, port);
  const unregisterServerCleanup = registerProcessCleanup(() => stopServer(server));
  let serverOutput = "";
  server.stdout?.on("data", (data: Buffer) => { serverOutput += data.toString(); });
  server.stderr?.on("data", (data: Buffer) => { serverOutput += data.toString(); });

  try {
    const timeoutMs = (config.timeoutSeconds ?? 45) * 1000;
    if (!(await waitForPort(port, timeoutMs))) {
      return { status: "failed", browser, screenshots: [], reason: "server_not_ready", diagnostic: serverOutput.slice(-4000) };
    }

    let screenshot;
    if (browser === "agent-browser") {
      const open = await runCommand("agent-browser", browserArgs(session, "open", url), projectDir, { timeout: timeoutMs });
      if (open.exitCode !== 0) {
        if (!commandExists("google-chrome")) {
          return { status: "failed", browser, screenshots: [], reason: "browser_open_failed", diagnostic: open.stderr.slice(-4000) };
        }
        browser = "google-chrome";
        screenshot = await captureWithChrome(url, screenshotPath, projectDir, timeoutMs);
      } else {
        await runCommand("agent-browser", browserArgs(session, "wait", "--load", "networkidle"), projectDir, { timeout: timeoutMs });
        screenshot = await runCommand("agent-browser", browserArgs(session, "screenshot", screenshotPath), projectDir, { timeout: timeoutMs });
        if (screenshot.exitCode !== 0 && commandExists("google-chrome")) {
          browser = "google-chrome";
          screenshot = await captureWithChrome(url, screenshotPath, projectDir, timeoutMs);
        }
      }
    } else {
      screenshot = await captureWithChrome(url, screenshotPath, projectDir, timeoutMs);
    }
    if (screenshot.exitCode !== 0 || !existsSync(screenshotPath)) {
      const screenshotStderr = "stderr" in screenshot && typeof screenshot.stderr === "string" ? screenshot.stderr : "";
      return { status: "failed", browser, screenshots: [], reason: "screenshot_failed", diagnostic: `${screenshotStderr.slice(-2000)}\n${serverOutput.slice(-2000)}` };
    }
    return {
      status: "captured",
      browser,
      screenshots: [{ name: "home", reportPath: `assets/${benchmark}/${resultDir.split("/").pop()}/home.png` }],
    };
  } catch (error) {
    return { status: "failed", browser, screenshots: [], reason: String(error), diagnostic: serverOutput.slice(-4000) };
  } finally {
    if (browser === "agent-browser") {
      await runCommand("agent-browser", browserArgs(session, "close"), projectDir, { timeout: 10_000 }).catch(() => undefined);
    }
    stopServer(server);
    unregisterServerCleanup();
    await saveJson(join(resultDir, "visual-server.log.json"), { output: serverOutput });
  }
}
