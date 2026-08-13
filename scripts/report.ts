import { generateReport } from "./generate-report.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RESULTS_DIR } from "./utils.js";

const includeAll = process.argv.includes("--all");

readFile(join(RESULTS_DIR, "campaign.json"), "utf-8")
  .then((raw) => JSON.parse(raw) as { executionId?: string })
  .catch((): { executionId?: string } => ({}))
  .then(({ executionId }) => generateReport(includeAll ? undefined : executionId))
  .catch((err) => {
  console.error(err);
  process.exit(1);
  });
