// tests/activity.test.js — attention-state matrix for activityFor().
const test = require("node:test");
const assert = require("node:assert");
const sessions = require("../src/server/sessions");

const NOW = 1_000_000;

test("activity: web sessions mirror process status", () => {
  assert.equal(sessions.activityFor({ mode: "web", status: "running" }).activity, "running");
  assert.equal(sessions.activityFor({ mode: "web", status: "starting" }).activity, "starting");
  assert.equal(sessions.activityFor({ mode: "web", status: "error" }).activity, "error");
  assert.equal(sessions.activityFor({ mode: "web", status: "exited" }).activity, "finished");
});

test("activity: pty working while output is fresh", () => {
  const a = sessions.activityFor(
    { mode: "pty" }, { exited: false, lastOutputAt: NOW - 2000 }, NOW);
  assert.equal(a.activity, "working");
});

test("activity: pty waiting once quiet past the window", () => {
  const a = sessions.activityFor(
    { mode: "pty" }, { exited: false, lastOutputAt: NOW - 60_000 }, NOW);
  assert.equal(a.activity, "waiting");
  assert.equal(a.idleMs, 60_000);
});

test("activity: exited or missing PTY is finished", () => {
  assert.equal(sessions.activityFor({ mode: "pty" }, { exited: true }).activity, "finished");
  assert.equal(sessions.activityFor({ mode: "pty" }, null).activity, "finished");
});

test("activity: web snapshot active drain is working", () => {
  sessions._clearWebActivityForTest();
  const a = sessions.webActivityFromSnapshot(
    { isActive: true, hasMessages: true, latest: { type: "assistant", time: { created: NOW - 1000 } } }, NOW);
  assert.equal(a.activity, "working");
});

test("activity: web snapshot idle/completed turn is waiting with idleMs", () => {
  const idle = sessions.webActivityFromSnapshot(
    { isActive: false, hasMessages: true, latest: { type: "idle", time: { created: NOW - 5000 } } }, NOW);
  assert.equal(idle.activity, "waiting");
  assert.equal(idle.idleMs, 5000);
  const done = sessions.webActivityFromSnapshot(
    { isActive: false, hasMessages: true, latest: { type: "assistant", time: { created: NOW - 9000, completed: NOW - 8000 } } }, NOW);
  assert.equal(done.activity, "waiting");
  assert.equal(done.idleMs, 8000);
});

test("activity: web snapshot fresh chat is running, streaming stays working", () => {
  assert.equal(
    sessions.webActivityFromSnapshot({ isActive: false, hasMessages: false, latest: null }, NOW).activity,
    "running");
  assert.equal(
    sessions.webActivityFromSnapshot(
      { isActive: false, hasMessages: true, latest: { type: "assistant", time: { created: NOW - 1000 } } }, NOW).activity,
    "working");
  // Freshly prompted pickup race stays working; a long-unpicked prompt waits.
  assert.equal(
    sessions.webActivityFromSnapshot(
      { isActive: false, hasMessages: true, latest: { type: "user", time: { created: NOW - 2000 } } }, NOW).activity,
    "working");
  assert.equal(
    sessions.webActivityFromSnapshot(
      { isActive: false, hasMessages: true, latest: { type: "user", time: { created: NOW - 60000 } } }, NOW).activity,
    "waiting");
});

test("activity: web snapshot pending approval overrides working", () => {
  const a = sessions.webActivityFromSnapshot(
    { isActive: true, hasMessages: true, latest: { type: "assistant", time: { created: NOW - 1000 } }, pendingApproval: true }, NOW);
  assert.equal(a.activity, "waiting");
});

test("activity: getWebActivity polls active + messages against a stub backend", async () => {
  const http = require("http");
  const os = require("os");
  const path = require("path");
  const store = require("../src/server/store");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-webact-${Date.now()}.json`));
  sessions._clearWebActivityForTest();
  let mode = "working";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/session/active") {
        res.end(JSON.stringify(mode === "working"
          ? { data: { ses_hid1: { type: "running" } } }
          : { data: {} }));
      } else if (req.url.startsWith("/api/session/ses_hid1/message")) {
        res.end(JSON.stringify(mode === "working"
          ? { data: [{ id: "m1", type: "assistant", time: { created: 1000 } }] }
          : { data: [{ id: "m9", type: "idle", time: { created: 2000 }, outcome: "succeeded" }] }));
      } else if (req.url.endsWith("/permission")) {
        res.end(JSON.stringify({ data: [] }));
      } else if (req.url.endsWith("/form")) {
        res.end(JSON.stringify({ data: [] }));
      } else {
        res.end(JSON.stringify({ data: [] }));
      }
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_web1", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port, status: "running", harnessSessionId: "ses_hid1",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal((await sessions.getWebActivity("sess_web1", 2000)).activity, "working");
    mode = "idle";
    const done = await sessions.getWebActivity("sess_web1", 2000);
    assert.equal(done.activity, "waiting");
    assert.ok(done.idleMs > 0, "waiting carries idleMs");
    // Unreachable backend fails open to null (no false attention).
    const dead = await new Promise((resolve) => {
      const t = http.createServer(() => {});
      t.listen(0, "127.0.0.1", () => resolve(t));
    });
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));
    store.updateSession("sess_web1", { port: deadPort });
    assert.equal(await sessions.getWebActivity("sess_web1", 500), null);
  } finally {
    srv.close();
  }
});

test("activity: syncAllWebActivity fills the describeSession cache", async () => {
  const http = require("http");
  const os = require("os");
  const path = require("path");
  const store = require("../src/server/store");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-websync-${Date.now()}.json`));
  sessions._clearWebActivityForTest();
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/session/active") res.end(JSON.stringify({ data: {} }));
      else if (req.url.includes("/message")) {
        res.end(JSON.stringify({ data: [{ id: "m9", type: "assistant", time: { created: 1000, completed: 2000 } }] }));
      } else res.end(JSON.stringify({ data: [] }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_web2", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port, status: "running", harnessSessionId: "ses_hid2",
      createdAt: 1, lastActiveAt: 1,
    });
    // Before sync: process-status fallback.
    assert.equal(sessions.describeSession(sessions.sessionById("sess_web2")).activity, "running");
    await sessions.syncAllWebActivity(2000);
    assert.equal(sessions.describeSession(sessions.sessionById("sess_web2")).activity, "waiting");
  } finally {
    srv.close();
  }
});
