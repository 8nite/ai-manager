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

test("ptyArgsFor: dsh passes goal title as headless task", () => {
  const h = getHarness("dsh");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "dsh", title: "run the tests" }, h),
    ["-y", "@deepseek-ai/dsh", "headless", "run the tests"]
  );
});

test("ptyArgsFor: dsh without goal spawns bare headless (usage error, no crash)", () => {
  const h = getHarness("dsh");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "dsh", title: "  " }, h),
    ["-y", "@deepseek-ai/dsh", "headless"]
  );
});

test("ptyArgsFor: first agy run is plain interactive with default model", () => {
  const h = getHarness("agy");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "agy", everRan: false }, h),
    ["--model", "gemini-3.8-flash-low"]
  );
});

test("ptyArgsFor: agy respawn uses --continue", () => {
  const h = getHarness("agy");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "agy", everRan: true }, h),
    ["--model", "gemini-3.8-flash-low", "--continue"]
  );
});

test("ptyArgsFor: explicit agy conversation id wins over --continue", () => {
  const h = getHarness("agy");
  assert.deepEqual(
    sessions.ptyArgsFor({ harness: "agy", everRan: true, harnessSessionId: "conv-abc" }, h),
    ["--model", "gemini-3.8-flash-low", "--conversation", "conv-abc"]
  );
});
