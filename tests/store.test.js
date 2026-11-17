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

test("store: legacy lumina records migrate to chassis on load", () => {
  const fs = require("fs");
  const file = path.join(os.tmpdir(), `aimgr-mig-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    workspaces: [{ id: "ws_1", path: "/tmp", name: "tmp", createdAt: 1 }],
    sessions: [
      { id: "sess_old", workspaceId: "ws_1", harness: "lumina", title: "old", mode: "web", port: 4089, status: "exited", harnessSessionId: "06b7f976", backendPid: 123 },
      { id: "sess_oc", workspaceId: "ws_1", harness: "opencode", title: "keep", mode: "web", port: 4090, status: "running", harnessSessionId: "abc" },
    ],
  }));
  store._resetForTest(file);
  const all = store.getSessions();
  const mig = all.find((s) => s.id === "sess_old");
  assert.equal(mig.harness, "chassis");
  assert.equal(mig.mode, "web");
  assert.equal(mig.port, null, "stale port dropped — next ensure repoints");
  assert.equal(mig.harnessSessionId, null, "stale lumina hid dropped — next ensure backfills");
  assert.equal(mig.status, "starting");
  const kept = all.find((s) => s.id === "sess_oc");
  assert.equal(kept.harness, "opencode");
  assert.equal(kept.harnessSessionId, "abc", "opencode records untouched");
});
