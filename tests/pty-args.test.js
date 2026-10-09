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
