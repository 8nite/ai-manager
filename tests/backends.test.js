// tests/backends.test.js — harness registry shape.
const test = require("node:test");
const assert = require("node:assert");
const { harnessNames, getHarness } = require("../src/server/backends");

test("backends: opencode/droid/dsh registered with modes", () => {
  assert.deepEqual(harnessNames().sort(), ["droid", "dsh", "opencode"]);
  assert.equal(getHarness("opencode").mode, "web");
  assert.equal(getHarness("dsh").mode, "web");
  assert.equal(getHarness("droid").mode, "pty");
  assert.throws(() => getHarness("nope"), /unknown harness/);
});

test("backends: web args include the allocated port", () => {
  const a = getHarness("opencode").args(4199);
  assert.ok(a.includes("4199"), JSON.stringify(a));
});
