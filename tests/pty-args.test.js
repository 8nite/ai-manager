// tests/pty-args.test.js — droid respawn resumes instead of starting blank.
const test = require("node:test");
const assert = require("node:assert");
const { getHarness } = require("../src/server/backends");
const sessions = require("../src/server/sessions");

test("ptyArgsFor: first droid run is plain interactive", () => {
  const h = getHarness("droid");
  assert.deepEqual(sessions.ptyArgsFor({ harness: "droid", everRan: false }, h), []);
});

test("ptyArgsFor: droid respawn uses resume --last", () => {
  const h = getHarness("droid");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "droid", everRan: true }, h),
    ["resume", "--last"]
  );
});

test("ptyArgsFor: explicit harness session id wins", () => {
  const h = getHarness("droid");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "droid", everRan: true, harnessSessionId: "abc" }, h),
    ["resume", "abc"]
  );
});

test("ptyArgsFor: first agy run is plain interactive with default model", () => {
  const h = getHarness("agy");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "agy", everRan: false }, h),
    ["--model", "gemini-3.8-flash-high"]
  );
});

test("ptyArgsFor: agy respawn uses --continue", () => {
  const h = getHarness("agy");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "agy", everRan: true }, h),
    ["--model", "gemini-3.8-flash-high", "--continue"]
  );
});

test("ptyArgsFor: explicit agy conversation id wins over --continue", () => {
  const h = getHarness("agy");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "agy", everRan: true, harnessSessionId: "conv-abc" }, h),
    ["--model", "gemini-3.8-flash-high", "--conversation", "conv-abc"]
  );
});
