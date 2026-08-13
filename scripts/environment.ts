import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { runCommand } from "./utils.js";

export interface EnvironmentSnapshot {
  capturedAt: string;
  node: string;
  npm: string;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  hostname: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  copilotCliVersion?: string | null;
  copilotSdkVersion?: string | null;
}

function requiredNodeMajor(requirement: string): number | null {
  const match = requirement.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

export async function captureEnvironment(requiredNode: string): Promise<EnvironmentSnapshot> {
  const major = Number(process.versions.node.split(".")[0]);
  const required = requiredNodeMajor(requiredNode);
  if (required !== null && major < required) {
    throw new Error(`Node ${required}+ required by benchmark, current=${process.versions.node}`);
  }

  const npm = await runCommand("npm", ["--version"], process.cwd(), { timeout: 10_000 });
  if (npm.exitCode !== 0) throw new Error(`npm --version failed: ${npm.stderr}`);
  const cpu = cpus();
  const copilot = await runCommand("copilot", ["--version"], process.cwd(), { timeout: 10_000 });
  let copilotSdkVersion: string | null = null;
  try {
    const packageJson = await import("node:fs/promises").then(({ readFile }) => readFile(`${process.cwd()}/node_modules/@github/copilot-sdk/package.json`, "utf8"));
    copilotSdkVersion = (JSON.parse(packageJson) as { version?: string }).version ?? null;
  } catch {}
  return {
    capturedAt: new Date().toISOString(),
    node: process.versions.node,
    npm: npm.stdout.trim(),
    platform: platform(),
    release: release(),
    arch: process.arch,
    hostname: hostname(),
    cpuModel: cpu[0]?.model ?? "unknown",
    cpuCount: cpu.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    copilotCliVersion: copilot.exitCode === 0 ? copilot.stdout.trim() : null,
    copilotSdkVersion,
  };
}
