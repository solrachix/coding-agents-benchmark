import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeIsolatedGit } from "./utils.js";
import { detectPenalties } from "./penalties.js";

async function makeBaseline() {
  const root = await mkdtemp(join(tmpdir(), "benchmark-penalties-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "src/lib"), { recursive: true });
  await mkdir(join(root, "prisma"), { recursive: true });
  await writeFile(join(root, "tests/books.test.ts"), "expect(1).toBe(1)\n");
  await writeFile(join(root, "src/lib/import.ts"), "export function x(){ try { return 1 } catch (error) { throw error } }\n");
  await writeFile(join(root, "src/lib/books.ts"), "export const x = 1\n");
  await writeFile(join(root, "prisma/schema.prisma"), "model Book { id String @id }\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "next build", lint: "eslint ." } }));
  assert.equal(initializeIsolatedGit(root), true);
  return root;
}

test("bugfix penalties detect modified visible tests and validation scripts", async () => {
  const root = await makeBaseline();
  try {
    await writeFile(join(root, "tests/books.test.ts"), "expect(true).toBe(true)\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "true", test: "true", build: "true", lint: "true" } }));
    const penalties = detectPenalties(root, root, "bugfix");
    assert.equal(penalties.testsModified, true);
    assert.equal(penalties.validationScriptsModified, true);
    assert.ok(penalties.penaltyPoints >= 35);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing Prisma is penalized instead of crashing the evaluator", async () => {
  const root = await makeBaseline();
  try {
    await rm(join(root, "prisma/schema.prisma"), { force: true });
    const penalties = detectPenalties(root, root, "bugfix");
    assert.equal(penalties.prismaRemoved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
