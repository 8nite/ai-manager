// tests/sessions.test.js — workspace validation + unknown-harness rejection.
// (Does NOT spawn real harness binaries.)
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const store = require("../src/server/store");
const sessions = require("../src/server/sessions");

test("sessions: createWorkspace validates directory", () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-test-${Date.now()}.json`));
  assert.throws(() => sessions.createWorkspace("/nonexistent-dir-xyz"), /not a directory/);
  const ws = sessions.createWorkspace(os.tmpdir());
  assert.ok(ws.id.startsWith("ws_"));
  assert.equal(sessions.listConsoles().length, 0);
});

test("sessions: createSession rejects unknown harness", async () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-test-${Date.now()}.json`));
  const ws = sessions.createWorkspace(os.tmpdir());
  await assert.rejects(sessions.createSession(ws.id, "nope"), /unknown harness/);
});

test("sessions: killSession on missing id is a no-op", () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-test-${Date.now()}.json`));
  sessions.killSession("sess_missing");
  sessions.killConsole("con_missing");
  assert.ok(true);
});
