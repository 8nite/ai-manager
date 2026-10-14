// tests/paths.test.js — directory autocomplete for the open-folder picker.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const sessions = require("../src/server/sessions");

test("paths: completePath lists children of a trailing-slash dir", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-paths-"));
  fs.mkdirSync(path.join(base, "alpha"));
  fs.mkdirSync(path.join(base, "beta"));
  fs.writeFileSync(path.join(base, "file.txt"), "x"); // files excluded
  const r = sessions.completePath(base + "/");
  assert.equal(r.dir, base + "/");
  assert.deepEqual(r.entries.map((e) => e.name), ["alpha", "beta"]);
});

test("paths: completePath filters by basename prefix", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-paths-"));
  fs.mkdirSync(path.join(base, "proj-a"));
  fs.mkdirSync(path.join(base, "proj-b"));
  fs.mkdirSync(path.join(base, "other"));
  const r = sessions.completePath(path.join(base, "proj"));
  assert.deepEqual(r.entries.map((e) => e.name), ["proj-a", "proj-b"]);
});

test("paths: completePath never throws on missing dirs", () => {
  const r = sessions.completePath("/nonexistent-xyz-123/nope");
  assert.deepEqual(r.entries, []);
});
