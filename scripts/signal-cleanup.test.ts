import test from "node:test";
import assert from "node:assert/strict";
import { registerProcessCleanup } from "./utils.js";

test("registerProcessCleanup registers and releases a child cleanup", () => {
  let calls = 0;
  const unregister = registerProcessCleanup(() => { calls += 1; });
  unregister();
  assert.equal(calls, 0);
});
