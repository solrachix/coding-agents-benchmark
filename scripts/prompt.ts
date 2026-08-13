import { readFile } from "node:fs/promises";

const PREFIX = [
  "Benchmark execution mode: work autonomously and implement the requested task directly in the target directory.",
  "Do not ask clarifying questions, do not offer design options, do not invoke brainstorming or planning workflows, and do not stop after describing a plan.",
  "When the task presents options and one is marked recommended, always choose the recommended option.",
  "Use your best judgment for unspecified details. The benchmark is judged by the files and validations produced before the command exits.",
  "",
].join("\n");

export async function buildBenchmarkPrompt(promptPath: string): Promise<string> {
  return PREFIX + await readFile(promptPath, "utf-8");
}
