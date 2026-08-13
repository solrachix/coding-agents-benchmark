import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { maskSecrets, resolveBinPath, ROOT, runCommand } from "./utils.js";

export interface FunctionalValidation {
  enabled: boolean;
  status: "passed" | "failed" | "evaluator_error";
  passed: boolean;
  passedTests: number;
  totalTests: number;
  score: number;
  maxScore: number;
  output: string;
  reason?: string;
}

interface EvaluatorJson {
  passedTests: number;
  totalTests: number;
  failures: Array<{ name: string; error: string }>;
}

const TOTAL_TESTS = 7;
export const FUNCTIONAL_MAX_SCORE = 35;

export function evaluatorDatabaseUrl(projectDir: string): { url: string; path: string } {
  const path = resolve(projectDir, ".benchmark-evaluator", "benchmark-evaluator.db");
  return { path, url: `file:${path}` };
}

export function evaluatorScript(projectDir: string): string {
  const url = (relativePath: string) => pathToFileURL(resolve(projectDir, relativePath)).href;
  return `
async function main() {
const assert = (await import("node:assert/strict")).default;

const { prisma } = await import(${JSON.stringify(url("src/lib/db.ts"))});
const { bookSchema } = await import(${JSON.stringify(url("src/lib/schema.ts"))});
const { createBook, deleteBook, listBooks, searchBooks, updateBook } = await import(${JSON.stringify(url("src/lib/books.ts"))});
const { importBooksFromJson } = await import(${JSON.stringify(url("src/lib/import.ts"))});

const failures = [];
let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
  totalTests += 1;
  try {
    await fn();
    passedTests += 1;
    console.log("PASS " + name);
  } catch (error) {
    failures.push({ name, error: error instanceof Error ? (error.stack || error.message) : String(error) });
    console.error("FAIL " + name);
  }
}

async function reset() {
  await prisma.book.deleteMany();
}

await test("validates the full persisted book shape with Zod", async () => {
  assert.doesNotThrow(() => bookSchema.parse({
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "Dune",
    author: "Frank Herbert",
    status: "reading",
    rating: 5,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  }));
  assert.throws(() => bookSchema.parse({
    id: "bad-id",
    title: "Dune",
    author: "Frank Herbert",
    status: "invalid",
    rating: 8,
    createdAt: "nope",
    updatedAt: "nope",
  }));
});

await test("creates and lists books using the real database", async () => {
  await reset();
  const created = await createBook({ title: "Dune", author: "Frank Herbert", status: "reading", rating: 5 });
  assert.ok(created?.id);
  const books = await listBooks();
  assert.ok(books.some((book) => book.id === created.id && book.title === "Dune"));
});

await test("searches title case-insensitively", async () => {
  await reset();
  await createBook({ title: "Dune Messiah", author: "Frank Herbert", status: "want_to_read" });
  const books = await searchBooks("dUnE");
  assert.ok(books.some((book) => book.title === "Dune Messiah"));
});

await test("searches author case-insensitively", async () => {
  await reset();
  await createBook({ title: "Neuromancer", author: "William Gibson", status: "finished", rating: 5 });
  const books = await searchBooks("gIbSoN");
  assert.ok(books.some((book) => book.author === "William Gibson"));
});

await test("updates and deletes a persisted book", async () => {
  await reset();
  const created = await createBook({ title: "Old", author: "Author", status: "want_to_read" });
  const updated = await updateBook(created.id, { title: "New", status: "finished", rating: 4 });
  assert.equal(updated.title, "New");
  assert.equal(updated.status, "finished");
  await deleteBook(created.id);
  assert.equal((await listBooks()).some((book) => book.id === created.id), false);
});

await test("imports valid JSON and persists the imported book", async () => {
  await reset();
  const json = JSON.stringify({ books: [{
    id: "550e8400-e29b-41d4-a716-446655440001",
    title: "Snow Crash",
    author: "Neal Stephenson",
    status: "finished",
    rating: 5,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z"
  }] });
  const imported = await importBooksFromJson(json);
  assert.equal(imported.length, 1);
  assert.ok((await listBooks()).some((book) => book.title === "Snow Crash"));
});

await test("rejects malformed JSON and invalid imported books", async () => {
  await reset();
  await assert.rejects(() => importBooksFromJson("{not-json"));
  const invalid = JSON.stringify({ books: [{
    id: "bad-id",
    title: "Broken",
    author: "Nobody",
    status: "invalid",
    rating: 10,
    createdAt: "bad-date",
    updatedAt: "bad-date"
  }] });
  await assert.rejects(() => importBooksFromJson(invalid));
});

await prisma.$disconnect();
console.log("__BENCHMARK_RESULT__" + JSON.stringify({ passedTests, totalTests, failures }));
process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
}

function parseEvaluatorJson(output: string): EvaluatorJson | null {
  const marker = "__BENCHMARK_RESULT__";
  const line = output.split(/\r?\n/).find((value) => value.startsWith(marker));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(marker.length)) as EvaluatorJson;
    if (!Number.isFinite(parsed.passedTests) || !Number.isFinite(parsed.totalTests) || parsed.totalTests <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function runHiddenEvaluator(projectDir: string, timeoutMs: number): Promise<FunctionalValidation> {
  const evaluatorDir = join(projectDir, ".benchmark-evaluator");
  const scriptPath = join(evaluatorDir, "functional.hidden.ts");
  await rm(evaluatorDir, { recursive: true, force: true });
  await mkdir(evaluatorDir, { recursive: true });
  await writeFile(scriptPath, evaluatorScript(projectDir), "utf-8");

  const prismaBin = join(projectDir, "node_modules", "prisma", "build", "index.js");
  const tsxBin = await resolveBinPath(ROOT, "tsx");
  if (!existsSync(prismaBin) || !tsxBin) {
    return {
      enabled: true,
      status: "evaluator_error",
      passed: false,
      passedTests: 0,
      totalTests: TOTAL_TESTS,
      score: 0,
      maxScore: FUNCTIONAL_MAX_SCORE,
      output: `Hidden evaluator prerequisites missing: ${!existsSync(prismaBin) ? "project Prisma" : "benchmark tsx"}. It does not depend on the candidate's Vitest/Jest.`,
      reason: "prerequisites_missing",
    };
  }

  const database = evaluatorDatabaseUrl(projectDir);
  await mkdir(join(projectDir, ".benchmark-evaluator"), { recursive: true });
  const env = { DATABASE_URL: database.url, NODE_ENV: "test" };
  await rm(database.path, { force: true }).catch(() => undefined);

  const generate = await runCommand("node", [prismaBin, "generate"], projectDir, { timeout: timeoutMs, env });
  if (generate.exitCode !== 0) {
    return {
      enabled: true, passed: false, passedTests: 0, totalTests: TOTAL_TESTS, score: 0, maxScore: FUNCTIONAL_MAX_SCORE,
      output: maskSecrets(`Prisma generate failed.\n${generate.stdout}\n${generate.stderr}`),
      status: "evaluator_error", reason: "prisma_generate_failed",
    };
  }

  const push = await runCommand("node", [prismaBin, "db", "push", "--skip-generate"], projectDir, { timeout: timeoutMs, env });
  if (push.exitCode !== 0) {
    return {
      enabled: true, passed: false, passedTests: 0, totalTests: TOTAL_TESTS, score: 0, maxScore: FUNCTIONAL_MAX_SCORE,
      output: maskSecrets(`Prisma evaluator DB setup failed.\n${push.stdout}\n${push.stderr}`),
      status: "evaluator_error", reason: "prisma_db_setup_failed",
    };
  }

  // Execute with the benchmark's own TS runtime. The candidate may use Vitest, Jest,
  // or any other visible test runner without affecting this evaluator.
  const run = await runCommand("node", [tsxBin, scriptPath], projectDir, { timeout: timeoutMs, env });
  const combined = `${run.stdout}\n${run.stderr}`;
  const parsed = parseEvaluatorJson(combined);
  if (!parsed) {
    return {
      enabled: true, status: "evaluator_error", passed: false, passedTests: 0, totalTests: TOTAL_TESTS,
      score: 0, maxScore: FUNCTIONAL_MAX_SCORE, output: maskSecrets(combined), reason: "structured_result_missing",
    };
  }
  const passedTests = parsed?.passedTests ?? 0;
  const totalTests = parsed?.totalTests ?? TOTAL_TESTS;
  const score = Math.round((passedTests / Math.max(1, totalTests)) * FUNCTIONAL_MAX_SCORE);

  return {
    enabled: true,
    status: run.exitCode === 0 && passedTests === totalTests ? "passed" : "failed",
    passed: run.exitCode === 0 && passedTests === totalTests,
    passedTests,
    totalTests,
    score,
    maxScore: FUNCTIONAL_MAX_SCORE,
    output: maskSecrets(combined),
  };
}
