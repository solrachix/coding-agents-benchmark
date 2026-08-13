import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashProject, snapshotProject, reevaluationPolicy } from "./reevaluate.js";

test("reevaluation restores an official score only for a run that exited cleanly", () => {
  assert.deepEqual(reevaluationPolicy({ exitCode: 0, scoreStatus: "harness_failed" }), {
    preserveOfficialScore: true,
    harnessError: false,
  });
  assert.deepEqual(reevaluationPolicy({ exitCode: 1, scoreStatus: "harness_failed" }), {
    preserveOfficialScore: false,
    harnessError: true,
  });
});

test("project hash ignores technical evaluator directories but detects source changes", async () => {
  const project = await mkdtemp(join(tmpdir(), "benchmark-reevaluate-"));
  await mkdir(join(project, "node_modules"), { recursive: true });
  await mkdir(join(project, ".benchmark-evaluator"), { recursive: true });
  await writeFile(join(project, "src.ts"), "one");
  await writeFile(join(project, "node_modules", "ignored.txt"), "one");
  const before = await hashProject(project);
  await writeFile(join(project, "node_modules", "ignored.txt"), "two");
  assert.equal(await hashProject(project), before);
  await writeFile(join(project, "src.ts"), "two");
  assert.notEqual(await hashProject(project), before);
});

test("project snapshot reports the exact files changed during reevaluation", async () => {
  const project = await mkdtemp(join(tmpdir(), "benchmark-reevaluate-diff-"));
  await writeFile(join(project, "src.ts"), "one");
  const before = await snapshotProject(project);
  await writeFile(join(project, "src.ts"), "two");
  await writeFile(join(project, "generated.json"), "ignored by no rule");
  const after = await snapshotProject(project);

  assert.deepEqual(after.changedFilesComparedTo(before), ["generated.json", "src.ts"]);
});
