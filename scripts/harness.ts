import { runCommand } from "./utils.js";

export interface HarnessProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  durationSeconds: number;
}

export async function runHarnessProcess(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  options?: { env?: Record<string, string | undefined> }
): Promise<HarnessProcessResult> {
  const startedAt = Date.now();
  const result = await runCommand(command, args, cwd, { timeout, env: options?.env });

  return {
    ...result,
    durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
}
