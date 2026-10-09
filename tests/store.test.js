// tests/store.test.js — store CRUD roundtrip against a temp file.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const store = require("../src/server/store");

test("store: workspace + session CRUD", () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-test-${Date.now()}.json`));
  const ws = store.addWorkspace({ id: "ws_1", path: "/tmp", name: "tmp", createdAt: 1 });
  assert.equal(ws.id, "ws_1");
  assert.equal(store.getWorkspaces().length, 1);
  store.addSession({ id: "sess_1", workspaceId: "ws_1", harness: "opencode" });
  assert.equal(store.getSessions().length, 1);
  const upd = store.updateSession("sess_1", { status: "running" });
  assert.equal(upd.status, "running");
  const dropped = store.removeWorkspace("ws_1");
  assert.deepEqual(dropped, ["sess_1"]);
  assert.equal(store.getSessions().length, 0);
});
