import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { CampaignAbortError, runWithConcurrency, validateWorkspacePath } from "./utils.js";
import { validateProject } from "./validate-project.js";
import { runHarnessProcess } from "./harness.js";
import { classifyProcessFailure, detectHarnessError, projectHasManifest } from "./utils.js";
import { scoreProject } from "./rubric.js";

test("validateWorkspacePath accepts the root and its descendants", () => {
  const root = resolve("/tmp/benchmark-root");

  assert.doesNotThrow(() => validateWorkspacePath(root, root));
  assert.doesNotThrow(() => validateWorkspacePath(resolve(root, "results/run"), root));
});

test("runWithConcurrency limits active tasks and preserves all results", async () => {
  let active = 0;
  let peak = 0;
  const result = await runWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8]);
});

test("runWithConcurrency stops scheduling queued work after a campaign abort", async () => {
  const started: number[] = [];
  const completed: number[] = [];

  await assert.rejects(
    runWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new CampaignAbortError("provider_credits", "monthly quota exhausted");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed.push(value);
      return value;
    }),
    (error: unknown) => error instanceof CampaignAbortError && error.reason === "provider_credits",
  );

  assert.deepEqual(started.sort(), [0, 1]);
  assert.deepEqual(completed, [1]);
});

test("validateWorkspacePath rejects a path sharing only the root prefix", () => {
  const root = resolve("/tmp/benchmark-root");

  assert.throws(() => validateWorkspacePath(resolve("/tmp/benchmark-root-escape"), root));
});

test("validateProject skips checks disabled in the benchmark configuration", async () => {
  const result = await validateProject(resolve("/tmp/benchmark-empty-project"), 1, {
    install: false,
    typecheck: false,
    test: false,
    build: false,
    lint: false,
  });

  assert.equal(result.install.enabled, false);
  assert.equal(result.typecheck.enabled, false);
  assert.equal(result.test.enabled, false);
  assert.equal(result.build.enabled, false);
  assert.equal(result.lint.enabled, false);
  assert.equal(result.installDurationSeconds, 0);
});

test("runHarnessProcess captures a harness process using one shared contract", async () => {
  const result = await runHarnessProcess(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd(), 1_000);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
  assert.equal(typeof result.durationSeconds, "number");
});

test("runHarnessProcess records timeouts explicitly", async () => {
  const result = await runHarnessProcess(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], process.cwd(), 100);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("getResultDir keeps different reasoning efforts isolated", async () => {
  const { getResultDir } = await import("./utils.js");
  const medium = getResultDir("bugfix", "codex", "gpt-5.6-luna", 1, "medium");
  const extraHigh = getResultDir("bugfix", "codex", "gpt-5.6-luna", 1, "xhigh");

  assert.notEqual(medium, extraHigh);
  assert.match(extraHigh, /effort-xhigh/);
});

test("detectHarnessError ignores reasoning_content mentioned in instructions", () => {
  assert.deepEqual(detectHarnessError("Do not return reasoning_content in the response"), { harnessError: false });
});

test("detectHarnessError detects an actual provider error payload", () => {
  assert.deepEqual(
    detectHarnessError('{"error":{"code":"deepseek_reasoning_content"}}'),
    { harnessError: true, harnessErrorType: "deepseek_reasoning_content" }
  );
});

test("detectHarnessError classifies exhausted monthly quota as provider credits", () => {
  assert.deepEqual(detectHarnessError("You have exceeded your monthly quota"), {
    harnessError: true,
    harnessErrorType: "provider_credits",
  });
});

test("classifyProcessFailure marks a non-zero harness exit as failed", () => {
  assert.deepEqual(classifyProcessFailure(1, { harnessError: false }), {
    harnessError: true,
    harnessErrorType: "process_exit_1",
  });
  assert.deepEqual(classifyProcessFailure(1, { harnessError: true, harnessErrorType: "authentication_expired" }), {
    harnessError: true,
    harnessErrorType: "authentication_expired",
  });
});

test("classifyProcessFailure preserves timeout as an explicit harness error", () => {
  assert.deepEqual(classifyProcessFailure(1, { harnessError: false }, { timedOut: true, signal: "SIGTERM" }), {
    harnessError: true,
    harnessErrorType: "agent_timeout",
  });
});

test("projectHasManifest distinguishes an initialized project from an empty workspace", () => {
  assert.equal(projectHasManifest("/tmp/benchmark-empty-project"), false);
});

test("scoreProject differentiates a complete deliverable from an empty project", async () => {
  const complete = await mkdtemp(resolve(tmpdir(), "benchmark-complete-"));
  await mkdir(resolve(complete, "src/lib"), { recursive: true });
  await mkdir(resolve(complete, "src/app/api/books"), { recursive: true });
  await mkdir(resolve(complete, "src/components"), { recursive: true });
  await mkdir(resolve(complete, "tests"), { recursive: true });
  await mkdir(resolve(complete, "prisma"), { recursive: true });
  await Promise.all([
    writeFile(resolve(complete, "package.json"), '{"dependencies":{"next":"15","@prisma/client":"6","zod":"3"},"scripts":{"test":"vitest run","build":"next build","lint":"eslint .","typecheck":"tsc --noEmit"}}'),
    writeFile(resolve(complete, "README.md"), "Setup and architecture"),
    writeFile(resolve(complete, "tailwind.config.js"), "module.exports = {}"),
    writeFile(resolve(complete, ".env.example"), "DATABASE_URL=file:./dev.db"),
    writeFile(resolve(complete, "prisma/schema.prisma"), "model Book { id String @id title String author String status String }"),
    writeFile(resolve(complete, "prisma/seed.ts"), "await prisma.book.create({ data })"),
    writeFile(resolve(complete, "src/lib/db.ts"), "const prisma = new PrismaClient()"),
    writeFile(resolve(complete, "src/lib/schema.ts"), "bookSchema = z.object({ title: z.string() })"),
    writeFile(resolve(complete, "src/lib/books.ts"), "searchBooks createBook updateBook deleteBook"),
    writeFile(resolve(complete, "src/app/page.tsx"), "BookList search form"),
    writeFile(resolve(complete, "src/app/api/books/route.ts"), "GET POST PUT DELETE"),
    writeFile(resolve(complete, "src/components/BookList.tsx"), "export function BookList() {}"),
    writeFile(resolve(complete, "tests/books.test.ts"), "describe it expect bookSchema import search"),
  ]);

  const validation = {
    install: { enabled: true, passed: true, output: "" },
    typecheck: { enabled: true, passed: true, output: "" },
    test: { enabled: true, passed: true, output: "" },
    build: { enabled: true, passed: true, output: "" },
    lint: { enabled: true, passed: true, output: "" },
    functional: { enabled: true, status: "passed" as const, passed: true, passedTests: 7, totalTests: 7, score: 35, maxScore: 35, output: "" },
    installDurationSeconds: 1,
    readmeExists: true,
    packageJsonExists: true,
  };
  const penalties = {
    testsRemoved: false, testsModified: false, validationScriptsModified: false, prismaRemoved: false, usedAny: false,
    usedTsIgnore: false, usedTsExpectError: false, usedEslintDisable: false, jsonImportNotFixed: false,
    appRewritten: false, penaltyPoints: 0,
  };

  const completeScore = await scoreProject(complete, validation, penalties, "greenfield");
  const emptyScore = await scoreProject("/tmp/benchmark-empty-project", validation, penalties, "greenfield");

  assert.ok(completeScore.total !== null && emptyScore.total !== null);
  assert.ok(completeScore.total > emptyScore.total);
  assert.ok(completeScore.total <= 100);
  assert.match(completeScore.tier, /^[ABCD]$/);
  assert.ok(completeScore.evidence.deliverableCompleteness.length > 0);
});
