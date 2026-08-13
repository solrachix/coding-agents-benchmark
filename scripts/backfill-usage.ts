import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadMeta } from "./score-results.js";
import { parseTokenUsage } from "./token-usage.js";
import { RESULTS_DIR, saveJson } from "./utils.js";

async function main(): Promise<void> {
  let updated = 0;
  for (const benchmark of readdirSync(RESULTS_DIR)) {
    const benchmarkDir = join(RESULTS_DIR, benchmark);
    if (!statSync(benchmarkDir).isDirectory()) continue;
    for (const run of readdirSync(benchmarkDir)) {
      const resultDir = join(benchmarkDir, run);
      if (!statSync(resultDir).isDirectory()) continue;
      const meta = await loadMeta(resultDir);
      if (!meta || (meta.harness !== "opencode" && meta.harness !== "codex")) continue;
      const raw = await readFile(join(resultDir, "raw.log"), "utf-8").catch(() => null);
      if (raw === null) continue;
      await saveJson(join(resultDir, "usage.json"), parseTokenUsage(raw, meta.harness));
      updated++;
    }
  }
  console.log(`Backfilled token usage for ${updated} result(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
