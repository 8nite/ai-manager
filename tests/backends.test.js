// tests/backends.test.js — harness registry shape.
const test = require("node:test");
const assert = require("node:assert");
const { harnessNames, getHarness } = require("../src/server/backends");

test("backends: opencode/droid/dsh registered with modes", () => {
  assert.deepEqual(harnessNames().sort(), ["agy", "droid", "dsh", "opencode"]);
  assert.equal(getHarness("opencode").mode, "web");
  assert.equal(getHarness("agy").mode, "pty");
  assert.equal(getHarness("dsh").mode, "pty");
  assert.equal(getHarness("droid").mode, "pty");
  assert.throws(() => getHarness("nope"), /unknown harness/);
});

test("backends: web args include the allocated port", () => {
  const a = getHarness("opencode").args(4199);
  assert.ok(a.includes("4199"), JSON.stringify(a));
});

test("backends: opencode env pins stable server password (auto-connect)", () => {
  const auth = require("../src/server/opencodeAuth");
  const env = getHarness("opencode").env();
  assert.equal(env.OPENCODE_SERVER_PASSWORD, auth.getPassword());
  assert.ok(env.OPENCODE_SERVER_PASSWORD.length >= 16);
});

test("backends: dsh runs one-shot headless CLI with goal as task", () => {
  const dsh = getHarness("dsh");
  assert.deepEqual(dsh.args(null, "run the tests"), ["-y", "@deepseek-ai/dsh", "headless", "run the tests"]);
  assert.deepEqual(dsh.args(null, null), ["-y", "@deepseek-ai/dsh", "headless"]);
  assert.deepEqual(dsh.args("session-1", "fix it"), ["-y", "@deepseek-ai/dsh", "headless", "--session-id", "session-1", "fix it"]);
});

test("backends: agy defaults to flash-low model, resumes via --conversation", () => {
  const agy = getHarness("agy");
  assert.deepEqual(agy.args(null), ["--model", "gemini-3.8-flash-low"]);
  assert.deepEqual(agy.args("conv-1"), ["--model", "gemini-3.8-flash-low", "--conversation", "conv-1"]);
});

test("backends: agy honors AGY_MODEL + AGY_ARGS overrides", () => {
  const agy = getHarness("agy");
  const prevModel = process.env.AGY_MODEL;
  const prevArgs = process.env.AGY_ARGS;
  try {
    process.env.AGY_MODEL = "gpt-oss-120b-medium";
    assert.deepEqual(agy.args(null), ["--model", "gpt-oss-120b-medium"]);
    process.env.AGY_ARGS = "--model foo --continue";
    assert.deepEqual(agy.args(null), ["--model", "foo", "--continue"]);
    assert.deepEqual(agy.args("conv-9"), ["--model", "foo", "--continue"]);
  } finally {
    if (prevModel === undefined) delete process.env.AGY_MODEL;
    else process.env.AGY_MODEL = prevModel;
    if (prevArgs === undefined) delete process.env.AGY_ARGS;
    else process.env.AGY_ARGS = prevArgs;
  }
});
