// workspace-isolation fence: harness2 launch sites must deny cross-workspace
// by default while keeping /tmp scratch allowed (cleaned per-run), so
// non-interactive rollouts stay fenced without anyone to approve prompts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const localPy = fs.readFileSync(path.join(__dirname, "..", "scripts", "harness2_local.py"), "utf8");
const goPatch = fs.readFileSync(path.join(__dirname, "..", "scripts", "harness2-opencode-go.patch"), "utf8");

test("workspace-isolation: adapter permission denies external but allows ws + /tmp", () => {
  assert.match(localPy, /"external_directory": \{"\*": "deny"/);
  assert.match(localPy, /"\/tmp": "allow"/);
  assert.match(localPy, /str\(ws\): "allow"/);
});

test("workspace-isolation: adapter sets per-run TMPDIR and removes it in finally", () => {
  assert.match(localPy, /env\["TMPDIR"\] = str\(tmpdir\)/);
  assert.match(localPy, /shutil\.rmtree\(tmpdir, ignore_errors=True\)/);
});

test("workspace-isolation: adapter prompt requires /tmp scratch cleanup", () => {
  assert.match(localPy, /Delete every scratch file you create under \/tmp before/);
});

test("workspace-isolation: patched proposer keeps the same /tmp allows", () => {
  assert.match(goPatch, /"\/tmp": "allow", "\/tmp\/\*\*": "allow"/);
});
