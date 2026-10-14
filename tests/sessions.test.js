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
  assert.equal(sessions.webProcCount(), 0);
});

test("sessions: ensureHarnessSession pre-creates + verifies opencode chat", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-harness-${Date.now()}.json`));
  const seen = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        if (req.method === "POST" && req.url === "/api/session") {
          const p = JSON.parse(body);
          assert.equal(p.location.directory, os.tmpdir());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_precreated999" } }));
        } else if (req.method === "GET" && req.url === "/api/session/ses_precreated999") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_precreated999" } }));
        } else if (req.url === "/api/session/ses_gone") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const ws = sessions.createWorkspace(os.tmpdir());
  // Fake an opencode web session record pointed at the stub.
  store.addSession({
    id: "sess_mgr1", workspaceId: ws.id, harness: "opencode", title: "t",
    mode: "web", port, status: "running", harnessSessionId: null,
    createdAt: 1, lastActiveAt: 1,
  });
  const hid = await sessions.ensureHarnessSession("sess_mgr1");
  assert.equal(hid, "ses_precreated999");
  assert.equal(sessions.sessionById("sess_mgr1").harnessSessionId, "ses_precreated999");
  // Second call verifies via GET, no re-create.
  const n = seen.length;
  assert.equal(await sessions.ensureHarnessSession("sess_mgr1"), "ses_precreated999");
  assert.ok(seen.slice(n).some((l) => l.startsWith("GET /api/session/ses_precreated999")));
  assert.ok(!seen.slice(n).some((l) => l.startsWith("POST")), "no recreate on verify");
  // Dangling id → 404 → recreated.
  store.updateSession("sess_mgr1", { harnessSessionId: "ses_gone" });
  assert.equal(await sessions.ensureHarnessSession("sess_mgr1"), "ses_precreated999");
  srv.close();
});

test("sessions: droid resume with no history falls back to interactive", async () => {
  const pty = require("../src/server/pty");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-droid-${Date.now()}.json`));
  const ws = sessions.createWorkspace(os.tmpdir());
  // Self-contained fake: resume path dies like real droid with no history;
  // plain launch stays alive.
  const fakeBin = path.join(os.tmpdir(), `fake-droid-${Date.now()}.sh`);
  fs.writeFileSync(fakeBin, '#!/bin/bash\nif [ "$1" = "resume" ]; then\n  echo "Error: No sessions found in current directory."\n  exit 1\nfi\nsleep 30\n');
  fs.chmodSync(fakeBin, 0o755);
  const prevBin = process.env.DROID_BIN;
  process.env.DROID_BIN = fakeBin;
  try {
    store.addSession({
      id: "sess_droid1", workspaceId: ws.id, harness: "droid", title: "t",
      mode: "pty", port: null, status: "starting", harnessSessionId: null,
      createdAt: 1, lastActiveAt: 1, everRan: true, // forces `resume --last`
    });
    await sessions.startSession("sess_droid1");
    // Resume path exits fast; fallback should respawn plain (sleep 30).
    const deadline = Date.now() + 10000;
    let alive = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      alive = pty.get("session:sess_droid1");
      if (alive && !alive.exited) break;
    }
    assert.ok(alive && !alive.exited, "fallback PTY alive");
    assert.ok(!/No sessions found/i.test(alive.backlog || ""), "fresh backlog, not the resume error");
  } finally {
    if (prevBin === undefined) delete process.env.DROID_BIN;
    else process.env.DROID_BIN = prevBin;
    sessions.killSession("sess_droid1");
  }
});

test("sessions: renameSession trims, collapses whitespace, persists", () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-rename-${Date.now()}.json`));
  const ws = sessions.createWorkspace(os.tmpdir());
  store.addSession({
    id: "sess_rename1", workspaceId: ws.id, harness: "droid", title: "old",
    mode: "pty", port: null, status: "running",
    createdAt: 1, lastActiveAt: 1,
  });
  const updated = sessions.renameSession("sess_rename1", "  new   name\t");
  assert.equal(updated.title, "new name");
  assert.equal(sessions.sessionById("sess_rename1").title, "new name");
  // Same title is a no-op returning the record.
  assert.equal(sessions.renameSession("sess_rename1", "new name").title, "new name");
});

test("sessions: renameSession rejects unknown session / empty / overlong", () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-rename-${Date.now()}.json`));
  assert.throws(() => sessions.renameSession("sess_missing", "x"), /unknown session/);
  const ws = sessions.createWorkspace(os.tmpdir());
  store.addSession({
    id: "sess_rename2", workspaceId: ws.id, harness: "droid", title: "old",
    mode: "pty", port: null, status: "running",
    createdAt: 1, lastActiveAt: 1,
  });
  assert.throws(() => sessions.renameSession("sess_rename2", "   "), /title required/);
  assert.throws(() => sessions.renameSession("sess_rename2", "x".repeat(121)), /too long/);
  assert.equal(sessions.sessionById("sess_rename2").title, "old");
});

test("sessions: syncSessionTitle adopts the backend auto-title", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-synctitle-${Date.now()}.json`));
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.method === "GET" && req.url === "/api/session/ses_backend1") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_backend1", title: "  auto   title from prompt\t" } }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_sync1", workspaceId: ws.id, harness: "opencode", title: "opencode · tmp",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend1",
      createdAt: 1, lastActiveAt: 1,
    });
    const updated = await sessions.syncSessionTitle("sess_sync1");
    assert.equal(updated.title, "auto title from prompt");
    assert.equal(sessions.sessionById("sess_sync1").title, "auto title from prompt");
  } finally {
    srv.close();
  }
});

test("sessions: syncSessionTitle no-ops on match and skips pty/unbound", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-synctitle-${Date.now()}.json`));
  let hits = 0;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { id: "ses_backend2", title: "same" } }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_sync2", workspaceId: ws.id, harness: "opencode", title: "same",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend2",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal((await sessions.syncSessionTitle("sess_sync2")).title, "same");
    assert.equal(hits, 1);
    // pty sessions never hit the backend.
    store.addSession({
      id: "sess_syncpty", workspaceId: ws.id, harness: "droid", title: "t",
      mode: "pty", port: null, status: "running",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.ok(await sessions.syncSessionTitle("sess_syncpty"));
    // Unbound web sessions (no pre-created chat) are skipped.
    store.addSession({
      id: "sess_syncunbound", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port, status: "running", harnessSessionId: null,
      createdAt: 1, lastActiveAt: 1,
    });
    assert.ok(await sessions.syncSessionTitle("sess_syncunbound"));
    assert.equal(hits, 1, "no backend calls for pty/unbound sessions");
  } finally {
    srv.close();
  }
});

test("sessions: syncSessionTitle never throws when the backend is unreachable", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-synctitle-${Date.now()}.json`));
  // Bind-then-close to get a port nothing answers on.
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((resolve) => tmp.close(resolve));
  const ws = sessions.createWorkspace(os.tmpdir());
  store.addSession({
    id: "sess_syncdead", workspaceId: ws.id, harness: "opencode", title: "keep me",
    mode: "web", port: deadPort, status: "running", harnessSessionId: "ses_gone",
    createdAt: 1, lastActiveAt: 1,
  });
  assert.equal(await sessions.syncSessionTitle("sess_syncdead", 1000), null);
  assert.equal(sessions.sessionById("sess_syncdead").title, "keep me");
  assert.equal(await sessions.syncSessionTitle("sess_missing", 1000), null);
});

test("sessions: pushTitleToHarness PATCHes the backend chat title", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-pushtitle-${Date.now()}.json`));
  const seen = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        // Real backend answers PATCH with 204 + empty body.
        res.writeHead(204);
        res.end();
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_push1", workspaceId: ws.id, harness: "opencode", title: "user rename",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend3",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal(await sessions.pushTitleToHarness("sess_push1"), true);
    assert.ok(seen.some((l) => l.startsWith("PATCH /api/session/ses_backend3")), `no PATCH seen: ${seen}`);
    assert.ok(seen.some((l) => l.includes('"user rename"')), `title not pushed: ${seen}`);
    // Skips pty sessions (nothing to push to).
    store.addSession({
      id: "sess_pushpty", workspaceId: ws.id, harness: "droid", title: "t",
      mode: "pty", port: null, status: "running",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal(await sessions.pushTitleToHarness("sess_pushpty"), false);
  } finally {
    srv.close();
  }
});

test("sessions: syncAllSessionTitles syncs bound chats concurrently", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-syncall-${Date.now()}.json`));
  const titles = { ses_a: "first auto", ses_b: "second auto" };
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const m = /^GET \/api\/session\/([^/?]+)$/.exec(`${req.method} ${req.url.split("?")[0]}`);
      if (m && titles[m[1]]) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { id: m[1], title: titles[m[1]] } }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    for (const [hid, want] of [["ses_a", "stale a"], ["ses_b", "stale b"]]) {
      store.addSession({
        id: `sess_all_${hid}`, workspaceId: ws.id, harness: "opencode", title: want,
        mode: "web", port, status: "running", harnessSessionId: hid,
        createdAt: 1, lastActiveAt: 1,
      });
    }
    await sessions.syncAllSessionTitles();
    assert.equal(sessions.sessionById("sess_all_ses_a").title, "first auto");
    assert.equal(sessions.sessionById("sess_all_ses_b").title, "second auto");
  } finally {
    srv.close();
  }
});

test("sessions: syncSessionTitle derives from first user message when backend stays default", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-syncderive-${Date.now()}.json`));
  const seen = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        if (req.method === "GET" && req.url === "/api/session/ses_backend4") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_backend4", title: "opencode · tmp" } }));
        } else if (req.method === "GET" && req.url === "/api/session/ses_backend4/message") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [
            { id: "m2", type: "assistant", time: { created: 20 } },
            { id: "m1", type: "user", text: "  hi ", time: { created: 10 } },
            { id: "m3", type: "user", text: "later message", time: { created: 30 } },
          ] }));
        } else if (req.method === "PATCH" && req.url === "/api/session/ses_backend4") {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_derive1", workspaceId: ws.id, harness: "opencode", title: "opencode · tmp",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend4",
      createdAt: 1, lastActiveAt: 1,
    });
    const updated = await sessions.syncSessionTitle("sess_derive1");
    assert.equal(updated.title, "hi");
    assert.equal(sessions.sessionById("sess_derive1").title, "hi");
    // Local display only: the derivation must NOT be pushed back, otherwise
    // it would plant a non-default title on the backend and pre-empt
    // opencode's own title agent.
    assert.ok(!seen.some((l) => l.startsWith("PATCH /api/session/ses_backend4")),
      `derived title must not be pushed back: ${seen}`);
  } finally {
    srv.close();
  }
});

test("sessions: syncSessionTitle never derives over a converged custom title", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-syncguard-${Date.now()}.json`));
  let hits = 0;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.endsWith("/message")) res.end(JSON.stringify({ data: [{ id: "m1", type: "user", text: "hi", time: { created: 1 } }] }));
      else res.end(JSON.stringify({ data: { id: "ses_backend5", title: "my custom name" } }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_guard1", workspaceId: ws.id, harness: "opencode", title: "my custom name",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend5",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal((await sessions.syncSessionTitle("sess_guard1")).title, "my custom name");
    assert.equal(hits, 1, "message history must not be fetched for custom titles");
  } finally {
    srv.close();
  }
});

test("sessions: syncSessionTitle keeps the default title when no user messages exist", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-syncempty-${Date.now()}.json`));
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.endsWith("/message")) res.end(JSON.stringify({ data: [] }));
      else res.end(JSON.stringify({ data: { id: "ses_backend6", title: "opencode · tmp" } }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_empty1", workspaceId: ws.id, harness: "opencode", title: "opencode · tmp",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend6",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal((await sessions.syncSessionTitle("sess_empty1")).title, "opencode · tmp");
  } finally {
    srv.close();
  }
});

test("sessions: tryAdoptBackend refuses closed ports and reclaims stale occupants", async () => {
  const http = require("http");
  const { spawn } = require("child_process");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-adoptrej-${Date.now()}.json`));
  // Closed port → false.
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  assert.equal(await sessions.tryAdoptBackend({ id: "x", port: deadPort, harnessSessionId: "ses_nope" }, 500), false);
  // Stale occupant (hid 404): its pid is SIGTERMed, adopt returns false.
  const sleeper = spawn("sleep", ["30"]);
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(req.url === "/api/info" ? 200 : 404, { "Content-Type": "application/json" });
      if (req.url === "/api/info") res.end(JSON.stringify({ pid: sleeper.pid }));
      else res.end("{}");
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_adopt2", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port: srv.address().port, status: "running", harnessSessionId: "ses_gone",
      createdAt: 1, lastActiveAt: 1,
    });
    // Port stays held by the stub, so reclaim can't free it — still false, but
    // the stale occupant must be dead.
    assert.equal(await sessions.tryAdoptBackend(sessions.sessionById("sess_adopt2"), 1500), false);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(sleeper.exitCode !== null || sleeper.signalCode !== null || sleeper.killed, "stale occupant killed");
  } finally {
    try { sleeper.kill("SIGKILL"); } catch {}
    srv.close();
  }
});

test("sessions: syncAllWebActivity marks refused backends exited", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-adoptdead-${Date.now()}.json`));
  sessions._clearWebActivityForTest();
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const ws = sessions.createWorkspace(os.tmpdir());
  store.addSession({
    id: "sess_adoptdead", workspaceId: ws.id, harness: "opencode", title: "t",
    mode: "web", port: deadPort, status: "running", harnessSessionId: "ses_gone",
    createdAt: 1, lastActiveAt: 1,
  });
  await sessions.syncAllWebActivity(800);
  assert.equal(sessions.sessionById("sess_adoptdead").status, "exited");
});

test("sessions: killSessionProc stops the recorded backend pid", async () => {
  const http = require("http");
  const { spawn } = require("child_process");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-adoptkill-${Date.now()}.json`));
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const ws = sessions.createWorkspace(os.tmpdir());
  const sleeper = spawn("sleep", ["30"]);
  store.addSession({
    // Non-opencode harness: opencode records route to the shared backend,
    // whose process outlives any one session (see the shared-kill test).
    id: "sess_adoptkill", workspaceId: ws.id, harness: "dsh", title: "t",
    mode: "pty", port: deadPort, status: "running", harnessSessionId: "ses_x",
    backendPid: sleeper.pid, createdAt: 1, lastActiveAt: 1,
  });
  sessions.killSessionProc("sess_adoptkill");
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(sleeper.exitCode !== null || sleeper.signalCode !== null || sleeper.killed, "recorded pid killed");
  assert.equal(sessions.sessionById("sess_adoptkill").backendPid, null);
  try { sleeper.kill("SIGKILL"); } catch {}
});

test("sessions: syncSessionTitle never reverts a derived title to the backend default", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-syntnorevert-${Date.now()}.json`));
  let msgHits = 0;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.endsWith("/message")) {
        msgHits++;
        res.end(JSON.stringify({ data: [{ id: "m1", type: "user", text: "hi", time: { created: 1 } }] }));
      } else {
        res.end(JSON.stringify({ data: { id: "ses_backend7", title: "opencode · tmp" } }));
      }
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_norevert1", workspaceId: ws.id, harness: "opencode", title: "hi",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend7",
      createdAt: 1, lastActiveAt: 1,
    });
    const out = await sessions.syncSessionTitle("sess_norevert1");
    assert.equal(out.title, "hi");
    assert.equal(sessions.sessionById("sess_norevert1").title, "hi");
    assert.equal(msgHits, 0, "stale backend default must not trigger a message fetch for derived titles");
  } finally {
    srv.close();
  }
});

test("sessions: syncSessionTitle adopts a later backend smart title over a local derivation", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-syncsmart-${Date.now()}.json`));
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { id: "ses_backend8", title: "Split screen support" } }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_smart1", workspaceId: ws.id, harness: "opencode", title: "in the main window I want split screen",
      mode: "web", port, status: "running", harnessSessionId: "ses_backend8",
      createdAt: 1, lastActiveAt: 1,
    });
    const out = await sessions.syncSessionTitle("sess_smart1");
    assert.equal(out.title, "Split screen support");
  } finally {
    srv.close();
  }
});

test("sessions: ensureSession fast path skips probing when recently alive", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-fastensure-${Date.now()}.json`));
  sessions._clearAliveForTest();
  // Bind-then-close to get a port nothing answers on: without the liveness
  // cache ensure would try to adopt/respawn and fail slowly.
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const ws = sessions.createWorkspace(os.tmpdir());
  store.addSession({
    id: "sess_fast1", workspaceId: ws.id, harness: "opencode", title: "t",
    mode: "web", port: deadPort, status: "running", harnessSessionId: "ses_hid1",
    createdAt: 1, lastActiveAt: 1,
  });
  // Pretend a poll just verified the backend: must return instantly with
  // zero I/O (no throw even though nothing listens on the port — a probe
  // would fail/spawn instead).
  sessions.markAlive("sess_fast1");
  assert.ok(sessions.isRecentlyAlive("sess_fast1"), "just marked session must read alive");
  const t0 = Date.now();
  const out = await sessions.ensureSession("sess_fast1");
  assert.equal(out.id, "sess_fast1");
  assert.ok(Date.now() - t0 < 2000, "fast path must not probe (took too long)");
  // Clearing the cache re-arms the probe: dead port throws again.
  sessions._clearAliveForTest();
  assert.ok(!sessions.isRecentlyAlive("sess_fast1"), "cleared cache must read stale");
});

test("sessions: concurrent ensures for one session share a single probe", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-inflight-${Date.now()}.json`));
  sessions._clearAliveForTest();
  let hits = 0;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/info") res.end(JSON.stringify({ pid: 99999 }));
      else if (req.url === "/api/session/ses_shared1") res.end(JSON.stringify({ data: { id: "ses_shared1" } }));
      else res.end(JSON.stringify({ data: [] }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_shared", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port: srv.address().port, status: "starting", harnessSessionId: "ses_shared1",
      createdAt: 1, lastActiveAt: 1,
    });
    // Pin the shared backend at this stub: unpinned, ensure would adopt-
    // fail the real shared port and spawn a live `opencode serve` mid-test.
    const prevShared = process.env.AI_MGR_SHARED_PORT;
    process.env.AI_MGR_SHARED_PORT = String(srv.address().port);
    sessions._resetSharedForTest();
    try {
      const [a, b] = await Promise.all([sessions.ensureSession("sess_shared"), sessions.ensureSession("sess_shared")]);
      assert.equal(a.id, "sess_shared");
      assert.equal(b.id, "sess_shared");
      assert.ok(sessions.isRecentlyAlive("sess_shared"), "successful ensure must mark alive");
    } finally {
      if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
      else process.env.AI_MGR_SHARED_PORT = prevShared;
      sessions._resetSharedForTest();
    }
  } finally {
    srv.close();
  }
});

test("sessions: killSession drops the liveness entry", async () => {
  store._resetForTest(path.join(os.tmpdir(), `aimgr-alivekill-${Date.now()}.json`));
  sessions._clearAliveForTest();
  const ws = sessions.createWorkspace(os.tmpdir());
  store.addSession({
    id: "sess_alivekill", workspaceId: ws.id, harness: "droid", title: "t",
    mode: "pty", port: null, status: "running",
    createdAt: 1, lastActiveAt: 1,
  });
  sessions.markAlive("sess_alivekill");
  assert.ok(sessions.isRecentlyAlive("sess_alivekill"));
  sessions.killSession("sess_alivekill");
  assert.ok(!sessions.isRecentlyAlive("sess_alivekill"), "killed session must not read alive");
});

test("sessions: agy spawns via AGY_BIN with model + resume argv", async () => {
  const pty = require("../src/server/pty");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-agy-${Date.now()}.json`));
  const ws = sessions.createWorkspace(os.tmpdir());
  // Fake agy: records argv, stays alive.
  const fakeBin = path.join(os.tmpdir(), `fake-agy-${Date.now()}.sh`);
  const argvFile = `${fakeBin}.argv`;
  fs.writeFileSync(fakeBin, `#!/bin/bash\necho "$@" > "${argvFile}"\nsleep 30\n`);
  fs.chmodSync(fakeBin, 0o755);
  const prevBin = process.env.AGY_BIN;
  process.env.AGY_BIN = fakeBin;
  async function argvSeen(want) {
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        if (fs.readFileSync(argvFile, "utf8").trim() === want) return;
      } catch {}
      if (Date.now() > deadline) {
        assert.fail(`fake agy never saw argv: ${want}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    // Fresh session: plain interactive + default model.
    store.addSession({
      id: "sess_agy1", workspaceId: ws.id, harness: "agy", title: "t",
      mode: "pty", port: null, status: "starting", harnessSessionId: null,
      createdAt: 1, lastActiveAt: 1,
    });
    await sessions.startSession("sess_agy1");
    let alive = pty.get("session:sess_agy1");
    assert.ok(alive && !alive.exited, "agy PTY alive");
    await argvSeen("--model gemini-3.8-flash-low");
    sessions.killSession("sess_agy1");
    try { fs.unlinkSync(argvFile); } catch {}
    // Respawns continue; explicit conversation ids win.
    store.addSession({
      id: "sess_agy2", workspaceId: ws.id, harness: "agy", title: "t",
      mode: "pty", port: null, status: "starting", harnessSessionId: null,
      createdAt: 1, lastActiveAt: 1, everRan: true,
    });
    await sessions.startSession("sess_agy2");
    alive = pty.get("session:sess_agy2");
    assert.ok(alive && !alive.exited, "agy respawn PTY alive");
    await argvSeen("--model gemini-3.8-flash-low --continue");
    sessions.killSession("sess_agy2");
    try { fs.unlinkSync(argvFile); } catch {}
    store.addSession({
      id: "sess_agy3", workspaceId: ws.id, harness: "agy", title: "t",
      mode: "pty", port: null, status: "starting", harnessSessionId: "conv-xyz",
      createdAt: 1, lastActiveAt: 1, everRan: true,
    });
    await sessions.startSession("sess_agy3");
    alive = pty.get("session:sess_agy3");
    assert.ok(alive && !alive.exited, "agy explicit-resume PTY alive");
    await argvSeen("--model gemini-3.8-flash-low --conversation conv-xyz");
    sessions.killSession("sess_agy3");
  } finally {
    if (prevBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevBin;
    try { fs.unlinkSync(fakeBin); } catch {}
    try { fs.unlinkSync(argvFile); } catch {}
  }
});

test("sessions: tryAdoptBackend on a closed port fails fast (no pre-spawn retry tax)", async () => {
  // Regression: the adopt probe retried a refused port for the full ~2s
  // timeout on EVERY fresh create (spawn hadn't happened yet, so nothing
  // could ever answer) — ~2/3 of measured POST /api/sessions latency.
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-adoptfast-${Date.now()}.json`));
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const t0 = Date.now();
  assert.equal(await sessions.tryAdoptBackend({ id: "x", port: deadPort }, 2000), false);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `closed-port adopt took ${ms}ms (want <1000, was ~2000)`);
});

test("sessions: probePortOnce is true for a live port, false for a closed one", async () => {
  const http = require("http");
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    assert.equal(await sessions.probePortOnce("127.0.0.1", srv.address().port, 1000), true);
  } finally {
    srv.close();
  }
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  assert.equal(await sessions.probePortOnce("127.0.0.1", deadPort, 1000), false);
});

test("sessions: sharedPort defaults to HARNESS_BASE-10, honors override", () => {
  const prevShared = process.env.AI_MGR_SHARED_PORT;
  const prevBase = process.env.AI_MGR_HARNESS_BASE_PORT;
  try {
    delete process.env.AI_MGR_SHARED_PORT;
    delete process.env.AI_MGR_HARNESS_BASE_PORT;
    assert.equal(sessions.sharedPort(), 4090);
    process.env.AI_MGR_HARNESS_BASE_PORT = "4450";
    assert.equal(sessions.sharedPort(), 4440);
    process.env.AI_MGR_SHARED_PORT = "4999";
    assert.equal(sessions.sharedPort(), 4999);
  } finally {
    if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
    else process.env.AI_MGR_SHARED_PORT = prevShared;
    if (prevBase === undefined) delete process.env.AI_MGR_HARNESS_BASE_PORT;
    else process.env.AI_MGR_HARNESS_BASE_PORT = prevBase;
  }
});

test("sessions: opencode creates share one backend port with zero child spawn", async () => {
  // Header is historical (shared-serve era): opencode now spawns one TUI
  // per session (pty mode). Same creation path, new contract below.
  const pty = require("../src/server/pty");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-ocpty-${Date.now()}.json`));
  sessions._resetSharedForTest();
  const prevBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = "true"; // exits immediately; spawn path only
  const prevShared = process.env.AI_MGR_SHARED_PORT;
  process.env.AI_MGR_SHARED_PORT = "49999";
  let a = null, b = null;
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    a = await sessions.createSession(ws.id, "opencode", "first");
    b = await sessions.createSession(ws.id, "opencode", "second");
    assert.equal(a.mode, "pty");
    assert.equal(a.port, null);
    assert.equal(b.port, null);
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    assert.equal(a.harnessSessionId, null, "fresh TUI owns no server chat yet");
    assert.ok(pty.get(`session:${a.id}`), "pty spawned for first");
    assert.ok(pty.get(`session:${b.id}`), "pty spawned for second");
  } finally {
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
    if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
    else process.env.AI_MGR_SHARED_PORT = prevShared;
    sessions._resetSharedForTest();
    try { if (a) pty.kill(`session:${a.id}`); } catch {}
    try { if (b) pty.kill(`session:${b.id}`); } catch {}
  }
});

test("sessions: syncAllWebActivity fetches /active once per port", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-batchact-${Date.now()}.json`));
  sessions._clearWebActivityForTest();
  let activeHits = 0;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/session/active") {
        activeHits++;
        res.end(JSON.stringify({ data: {} }));
      } else if (/\/message/.test(req.url)) {
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
    for (const [id, hid] of [["sess_b1", "ses_h1"], ["sess_b2", "ses_h2"], ["sess_b3", "ses_h3"]]) {
      store.addSession({
        id, workspaceId: ws.id, harness: "opencode", title: "t",
        mode: "web", port, status: "running", harnessSessionId: hid,
        createdAt: 1, lastActiveAt: 1,
      });
    }
    await sessions.syncAllWebActivity(2000);
    assert.equal(activeHits, 1, `three co-port sessions must cost one /active (got ${activeHits})`);
  } finally {
    srv.close();
  }
});

test("sessions: migrateToShared repoints idle legacy sessions, keeps working ones", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-migrate-${Date.now()}.json`));
  sessions._resetSharedForTest();
  sessions._clearAliveForTest();
  let mode = "idle";
  const old = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/session/active") {
        res.end(JSON.stringify(mode === "working" ? { data: { ses_workhid: { type: "running" } } } : { data: {} }));
      } else if (req.method === "GET" && req.url === "/api/session/ses_workhid") {
        res.end(JSON.stringify({ data: { id: "ses_workhid" } }));
      } else res.end(JSON.stringify({ data: [] }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const shared = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/info") res.end(JSON.stringify({ pid: 434343 }));
      else if (req.url === "/api/session/active") res.end(JSON.stringify({ data: {} }));
      else if (req.method === "POST" && req.url === "/api/session") res.end(JSON.stringify({ data: { id: "ses_newshared" } }));
      else res.end(JSON.stringify({ data: { id: "ses_workhid" } }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const prevShared = process.env.AI_MGR_SHARED_PORT;
  process.env.AI_MGR_SHARED_PORT = String(shared.address().port);
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_work", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port: old.address().port, status: "running", harnessSessionId: "ses_workhid",
      createdAt: 1, lastActiveAt: 1,
    });
    // Working turn on the old backend: stays put.
    mode = "working";
    await sessions.migrateToShared("sess_work");
    assert.equal(sessions.sessionById("sess_work").port, old.address().port, "working session must not repoint mid-turn");
    // Idle: repoints to shared.
    mode = "idle";
    await sessions.migrateToShared("sess_work");
    assert.equal(sessions.sessionById("sess_work").port, shared.address().port, "idle session must move to shared");
  } finally {
    if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
    else process.env.AI_MGR_SHARED_PORT = prevShared;
    sessions._resetSharedForTest();
    old.close();
    shared.close();
  }
});

test("sessions: killSession on a shared session drops the chat, never the backend", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-sharedkill-${Date.now()}.json`));
  sessions._resetSharedForTest();
  const seen = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: {} }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const prevShared = process.env.AI_MGR_SHARED_PORT;
  process.env.AI_MGR_SHARED_PORT = String(srv.address().port);
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_sk1", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port: srv.address().port, status: "running", harnessSessionId: "ses_gone1",
      createdAt: 1, lastActiveAt: 1,
    });
    sessions.killSession("sess_sk1");
    assert.equal(sessions.sessionById("sess_sk1"), undefined, "record removed");
    assert.equal(sessions.webProcCount(), 0, "no backend process touched");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(seen.some((l) => l === "DELETE /api/session/ses_gone1"), `chat DELETE missing: ${seen}`);
  } finally {
    if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
    else process.env.AI_MGR_SHARED_PORT = prevShared;
    sessions._resetSharedForTest();
    srv.close();
  }
});

test("sessions: shared ensure fast path returns with zero I/O when recently alive", async () => {
  const http = require("http");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-sharefast-${Date.now()}.json`));
  sessions._resetSharedForTest();
  sessions._clearAliveForTest();
  const tmp = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const prevShared = process.env.AI_MGR_SHARED_PORT;
  process.env.AI_MGR_SHARED_PORT = String(deadPort);
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_sfast", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port: deadPort, status: "running", harnessSessionId: "ses_hidx",
      createdAt: 1, lastActiveAt: 1,
    });
    sessions.markAlive("sess_sfast");
    const t0 = Date.now();
    const out = await sessions.ensureSession("sess_sfast");
    assert.equal(out.id, "sess_sfast");
    assert.ok(Date.now() - t0 < 2000, "shared fast path must not probe");
  } finally {
    if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
    else process.env.AI_MGR_SHARED_PORT = prevShared;
    sessions._resetSharedForTest();
  }
});

test("sessions: prewarmSessionConfig fills the proxy config cache over loopback", async () => {
  const http = require("http");
  const { EventEmitter } = require("events");
  const proxy = require("../src/server/proxy");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-prewarm-${Date.now()}.json`));
  proxy._clearConfigCacheForTest();
  const hits = {};
  const fullUrls = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      hits[p] = (hits[p] || 0) + 1;
      fullUrls.push(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: p }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_pw1", workspaceId: ws.id, harness: "opencode", title: "t",
      mode: "web", port, status: "running", harnessSessionId: "ses_hidx",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal(await sessions.prewarmSessionConfig("sess_pw1"), true);
    // Bare + ?location[directory]= variants for each path (16 loopback GETs).
    assert.equal(new Set(fullUrls).size, 16, `16 distinct prewarm fetches, got ${fullUrls.length}`);
    for (const p of ["project", "model", "provider", "integration", "config", "location", "vcs", "shell"]) {
      assert.equal(hits[`/api/${p}`], 2, `bare + dir fetch for /api/${p}`);
    }
    // A config GET through the proxy must now HIT with zero upstream I/O.
    const before = hits["/api/model"];
    const req = new EventEmitter();
    req.method = "GET";
    req.url = `/s/sess_pw1/api/model?location%5Bdirectory%5D=${encodeURIComponent(os.tmpdir())}`;
    req.headers = {};
    process.nextTick(() => req.emit("end"));
    const res = new EventEmitter();
    let head = null;
    const chunks = [];
    const done = new Promise((resolve) => res.on("done", resolve));
    res.writeHead = (s, h) => { head = h; };
    res.end = (c) => { if (c) chunks.push(Buffer.from(c)); res.emit("done", Buffer.concat(chunks).toString("utf8")); };
    proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/api/model");
    const raw = await done;
    assert.equal(head["x-aimgr-cache"], "HIT");
    assert.equal(hits["/api/model"], before, "HIT must not touch upstream");
    assert.ok(JSON.parse(raw).ok, "stored body served");
    // Unknown + non-opencode sessions are safe no-ops.
    assert.equal(await sessions.prewarmSessionConfig("sess_missing"), false);
    store.addSession({
      id: "sess_pwpty", workspaceId: ws.id, harness: "droid", title: "t",
      mode: "pty", port: null, status: "running",
      createdAt: 1, lastActiveAt: 1,
    });
    assert.equal(await sessions.prewarmSessionConfig("sess_pwpty"), false);
  } finally {
    proxy._clearConfigCacheForTest();
    srv.close();
  }
});

test("sessions: legacy web opencode migrates to pty keeping its chat id", async () => {
  const pty = require("../src/server/pty");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-ocmigrate-${Date.now()}.json`));
  sessions._resetSharedForTest();
  const fakeBin = path.join(os.tmpdir(), `fake-opencode-${Date.now()}.sh`);
  fs.writeFileSync(fakeBin, "#!/bin/bash\nsleep 30\n");
  fs.chmodSync(fakeBin, 0o755);
  const prevBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = fakeBin;
  const prevShared = process.env.AI_MGR_SHARED_PORT;
  process.env.AI_MGR_SHARED_PORT = "49998";
  try {
    const ws = sessions.createWorkspace(os.tmpdir());
    store.addSession({
      id: "sess_legacyweb", workspaceId: ws.id, harness: "opencode",
      title: "opencode · legacy", mode: "web", port: 49998, status: "running",
      harnessSessionId: "ses_carryover", createdAt: Date.now(), lastActiveAt: Date.now(),
    });
    const s = await sessions.startSession("sess_legacyweb");
    assert.equal(s.mode, "pty");
    assert.equal(s.port, null);
    assert.equal(s.harnessSessionId, "ses_carryover", "TUI --session continues the old chat");
    assert.equal(s.status, "running");
    const entry = pty.get("session:sess_legacyweb");
    assert.ok(entry && !entry.exited, "pty spawned for migrated session");
  } finally {
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
    if (prevShared === undefined) delete process.env.AI_MGR_SHARED_PORT;
    else process.env.AI_MGR_SHARED_PORT = prevShared;
    sessions._resetSharedForTest();
    try { pty.kill("session:sess_legacyweb"); } catch {}
    try { fs.unlinkSync(fakeBin); } catch {}
  }
});

test("sessions: backfill adopts the workspace chat id + real title", async () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-ocfill-${Date.now()}.json`));
  const ws = sessions.createWorkspace(os.tmpdir());
  const list = [{ id: "ses_claim1", title: "real backend title", created: 9999999999999, directory: ws.path }];
  const fakeBin = path.join(os.tmpdir(), `fake-oclist-${Date.now()}.sh`);
  fs.writeFileSync(fakeBin, `#!/bin/bash\necho '${JSON.stringify(list)}'\n`);
  fs.chmodSync(fakeBin, 0o755);
  const prevBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = fakeBin;
  try {
    store.addSession({
      id: "sess_fillme", workspaceId: ws.id, harness: "opencode",
      title: `opencode · ${ws.name}`, mode: "pty", port: null, status: "running",
      harnessSessionId: null, createdAt: Date.now(), lastActiveAt: Date.now(),
    });
    const got = await sessions.backfillOpencodeHarnessId("sess_fillme");
    assert.ok(got, "backfill must claim the chat");
    assert.equal(sessions.sessionById("sess_fillme").harnessSessionId, "ses_claim1");
    assert.equal(sessions.sessionById("sess_fillme").title, "real backend title");
  } finally {
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
    try { fs.unlinkSync(fakeBin); } catch {}
  }
});

test("sessions: backfill leaves sessions alone when no chat matches", async () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-ocfillnone-${Date.now()}.json`));
  const ws = sessions.createWorkspace(os.tmpdir());
  const fakeBin = path.join(os.tmpdir(), `fake-oclistnone-${Date.now()}.sh`);
  fs.writeFileSync(fakeBin, "#!/bin/bash\necho '[]'\n");
  fs.chmodSync(fakeBin, 0o755);
  const prevBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = fakeBin;
  try {
    store.addSession({
      id: "sess_fillnone", workspaceId: ws.id, harness: "opencode",
      title: `opencode · ${ws.name}`, mode: "pty", port: null, status: "running",
      harnessSessionId: null, createdAt: Date.now(), lastActiveAt: Date.now(),
    });
    const got = await sessions.backfillOpencodeHarnessId("sess_fillnone");
    assert.equal(got, null);
    assert.equal(sessions.sessionById("sess_fillnone").harnessSessionId, null);
    assert.equal(sessions.sessionById("sess_fillnone").title, `opencode · ${ws.name}`);
  } finally {
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
    try { fs.unlinkSync(fakeBin); } catch {}
  }
});
