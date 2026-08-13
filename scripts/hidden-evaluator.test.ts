import test from "node:test";
import assert from "node:assert/strict";
import { evaluatorDatabaseUrl, evaluatorScript, runHiddenEvaluator } from "./hidden-evaluator.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBinPath, ROOT, runCommand } from "./utils.js";

test("hidden evaluator uses an absolute database path inside the isolated result project", () => {
  const database = evaluatorDatabaseUrl("/tmp/benchmark-project");
  assert.equal(database.path, "/tmp/benchmark-project/.benchmark-evaluator/benchmark-evaluator.db");
  assert.equal(database.url, "file:/tmp/benchmark-project/.benchmark-evaluator/benchmark-evaluator.db");
});

test("hidden evaluator reports evaluator_error when it cannot produce a structured result", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "benchmark-hidden-error-"));
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  const result = await runHiddenEvaluator(projectDir, 1_000);
  assert.equal(result.status, "evaluator_error");
  assert.match(result.reason ?? "", /prisma|prerequisite|setup/i);
  assert.equal(result.score, 0);
});

test("hidden evaluator CJS regression fixture reaches its structured result marker", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "benchmark-hidden-cjs-"));
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  await mkdir(join(projectDir, "src/lib"), { recursive: true });
  await writeFile(join(projectDir, "src/lib/db.ts"), "export const prisma = { book: { deleteMany: async () => { globalThis.__books = []; } }, $disconnect: async () => undefined };", "utf8");
  await writeFile(join(projectDir, "src/lib/schema.ts"), "export const bookSchema = { parse: (value) => { if (!/^[0-9a-f-]{36}$/.test(value.id) || !['want_to_read','reading','finished'].includes(value.status) || value.rating > 5) throw new Error('invalid'); return value; } };", "utf8");
  await writeFile(join(projectDir, "src/lib/books.ts"), "const state = () => globalThis.__books ??= []; export const createBook = async (value) => { const book = { id: '550e8400-e29b-41d4-a716-446655440002', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...value }; state().push(book); return book; }; export const deleteBook = async (id) => { globalThis.__books = state().filter((b) => b.id !== id); }; export const listBooks = async () => [...state()]; export const searchBooks = async (query) => state().filter((b) => (b.title + b.author).toLowerCase().includes(query.toLowerCase())); export const updateBook = async (id, value) => { const book = state().find((b) => b.id === id); Object.assign(book, value); return book; };", "utf8");
  await writeFile(join(projectDir, "src/lib/import.ts"), "import { createBook } from './books.ts'; export const importBooksFromJson = async (text) => { const data = JSON.parse(text); if (!Array.isArray(data.books)) throw new Error('invalid'); return Promise.all(data.books.map((book) => { if (!book.id || !/^[0-9a-f-]{36}$/.test(book.id) || !['want_to_read','reading','finished'].includes(book.status) || book.rating > 5) throw new Error('invalid'); const { id, createdAt, updatedAt, ...input } = book; return createBook(input); })); };", "utf8");
  const scriptPath = join(projectDir, "functional.hidden.ts");
  await writeFile(scriptPath, evaluatorScript(projectDir), "utf8");
  const tsxBin = await resolveBinPath(ROOT, "tsx");
  assert.ok(tsxBin);
  const result = await runCommand("node", [tsxBin, scriptPath], projectDir, { timeout: 5_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(/Top-level await|ERR_REQUIRE_ASYNC_MODULE/.test(result.stdout + result.stderr), false);
  assert.match(result.stdout, /__BENCHMARK_RESULT__/);
});
