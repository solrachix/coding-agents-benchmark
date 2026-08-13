import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = "file:./test.db";
const dbPath = join(process.cwd(), "prisma", "test.db");
rmSync(dbPath, { force: true });
const prismaBin = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
execFileSync("node", [prismaBin, "db", "push", "--skip-generate"], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
});
