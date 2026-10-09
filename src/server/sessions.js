// sessions.js — session + console lifecycle.
//
// Session: { id, workspaceId, harness, title, mode, port?, status,
//            harnessSessionId?, createdAt, lastActiveAt }
//   web sessions own a child process (opencode serve / dsh web) on a port.
//   pty sessions (droid) own a node-pty keyed `session:<id>`.
// Console: { id, workspaceId, title, createdAt } — ephemeral node-pty
//   keyed `console:<id>` running the user shell.

const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");
const store = require("./store");
const { getHarness, BASE_PORT } = require("./backends");
const pty = require("./pty");

const _procs = new Map(); // sessionId -> ChildProcess (web backends)

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function workspaceById(id) {
  return store.getWorkspaces().find((w) => w.id === id) || null;
}

function sessionById(id) {
  return store.getSessions().find((s) => s.id === id) || null;
}

function usedPorts() {
  const s = new Set();
  for (const sess of store.getSessions()) {
    if (sess.port) s.add(sess.port);
  }
  return s;
}

function allocPort() {
  const used = usedPorts();
  let p = BASE_PORT;
  while (used.has(p)) p++;
  return p;
}

function waitForPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const sock = net.createConnection({ host, port });
      let done = false;
      const fin = (err) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (err) reject(err); else resolve();
      };
      sock.once("connect", () => fin(null));
      sock.once("error", () => {
        if (Date.now() - start > timeoutMs) fin(new Error(`timeout waiting for ${host}:${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

// ---- workspaces ----

function createWorkspace(dirPath) {
  const abs = path.resolve(dirPath);
  const fs = require("fs");
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`not a directory: ${abs}`);
  const ws = {
    id: uid("ws"),
    path: abs,
    name: path.basename(abs) || abs,
    createdAt: Date.now(),
  };
  return store.addWorkspace(ws);
}

function removeWorkspace(id) {
  const dropped = store.removeWorkspace(id);
  for (const sid of dropped) killSession(sid);
  // Drop consoles belonging to the workspace too.
  for (const c of listConsoles().filter((c) => c.workspaceId === id)) killConsole(c.id);
  return dropped;
}

// ---- sessions ----

async function createSession(workspaceId, harness, title) {
  const ws = workspaceById(workspaceId);
  if (!ws) throw new Error(`unknown workspace: ${workspaceId}`);
  const h = getHarness(harness); // throws on unknown
  const sess = {
    id: uid("sess"),
    workspaceId,
    harness,
    title: title || `${h.label} · ${ws.name}`,
    mode: h.mode,
    port: h.mode === "web" ? allocPort() : null,
    status: "starting",
    harnessSessionId: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  store.addSession(sess);
  try {
    await startSession(sess.id);
  } catch (e) {
    store.updateSession(sess.id, { status: "error", error: String(e.message || e) });
  }
  return sessionById(sess.id);
}

async function startSession(id) {
  const sess = sessionById(id);
  if (!sess) throw new Error(`unknown session: ${id}`);
  const ws = workspaceById(sess.workspaceId);
  if (!ws) throw new Error(`workspace gone for session ${id}`);
  const h = getHarness(sess.harness);

  if (h.mode === "web") {
    await startWeb(sess, ws, h);
  } else {
    startPty(sess, ws, h);
  }
  store.updateSession(id, { status: "running", error: null });
  return sessionById(id);
}

async function startWeb(sess, ws, h) {
  killSessionProc(sess.id);
  const bin = h.bin();
  const args = h.args(sess.port);
  const proc = spawn(bin, args, { cwd: ws.path, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...h.env() } });
  _procs.set(sess.id, proc);
  proc.stdout.on("data", (c) => process.stdout.write(`[${sess.id}] ${c}`));
  proc.stderr.on("data", (c) => process.stderr.write(`[${sess.id}] ${c}`));
  proc.on("exit", (code) => {
    if (_procs.get(sess.id) === proc) _procs.delete(sess.id);
    const cur = sessionById(sess.id);
    if (cur && cur.status === "running") {
      store.updateSession(sess.id, { status: "exited", error: `backend exited (code ${code})` });
    }
  });
  // Adopt-or-wait: if something already answers on the port, adopt it.
  try {
    await waitForPort("127.0.0.1", sess.port, 20000);
  } catch (e) {
    killSessionProc(sess.id);
    throw e;
  }
}

function startPty(sess, ws, h) {
  const key = `session:${sess.id}`;
  const existing = pty.get(key);
  if (existing && !existing.exited) return;
  const bin = h.bin();
  const args = ptyArgsFor(sess, h);
  pty.spawn(key, bin, args, { cwd: ws.path, env: h.env(), cols: 100, rows: 30 });
  if (!sess.everRan) store.updateSession(sess.id, { everRan: true });
}

// PTY respawn policy: first run is plain interactive; respawns after an
// exit use `resume --last` so a droid conversation continues where it left
// off instead of starting blank. (--last = most recent session in the
// folder, which is ours unless the user ran another droid there meanwhile.)
function ptyArgsFor(sess, h) {
  if (sess.harnessSessionId) return h.args(sess.harnessSessionId);
  if (sess.everRan && sess.harness === "droid") return ["resume", "--last"];
  return h.args(null);
}

// Attention/activity model (pure — tested in tests/activity.test.js).
//
//   web sessions: process status only (we can't see inside the iframe).
//   pty sessions: working  = output within the last 8s (likely generating)
//                 waiting  = quiet longer (likely needs your input)
//                 finished = PTY exited / no PTY ever spawned
const WORKING_WINDOW_MS = 8000;

function activityFor(sess, ptyInfo, now = Date.now()) {
  if (sess.mode === "web") {
    if (sess.status === "running") return { activity: "running", idleMs: 0 };
    if (sess.status === "starting") return { activity: "starting", idleMs: 0 };
    if (sess.status === "error") return { activity: "error", idleMs: 0 };
    return { activity: "finished", idleMs: 0 };
  }
  if (!ptyInfo || ptyInfo.exited) return { activity: "finished", idleMs: 0 };
  const idleMs = Math.max(0, now - (ptyInfo.lastOutputAt || now));
  if (idleMs < WORKING_WINDOW_MS) return { activity: "working", idleMs };
  return { activity: "waiting", idleMs };
}

// Enriched session for /api/state (store record + live activity).
function describeSession(sess) {
  const info = sess.mode === "pty" ? pty.info(`session:${sess.id}`) : null;
  return { ...sess, ...activityFor(sess, info) };
}
// ensure = resume path: restart only if dead, else no-op.
async function ensureSession(id) {
  const sess = sessionById(id);
  if (!sess) throw new Error(`unknown session: ${id}`);
  if (sess.mode === "web") {
    const proc = _procs.get(id);
    if (proc && !proc.killed && !proc.exitCode) {
      try {
        await waitForPort("127.0.0.1", sess.port, 2000);
        store.updateSession(id, { status: "running", error: null });
        return sessionById(id);
      } catch { /* fall through to restart */ }
    }
    await startSession(id);
    return sessionById(id);
  }
  const e = pty.get(`session:${id}`);
  if (e && !e.exited) {
    store.updateSession(id, { status: "running", error: null });
    return sessionById(id);
  }
  await startSession(id);
  return sessionById(id);
}

function killSessionProc(id) {
  const proc = _procs.get(id);
  if (!proc) return;
  _procs.delete(id);
  try { proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 3000);
}

function killSession(id) {
  killSessionProc(id);
  pty.kill(`session:${id}`);
  store.removeSession(id);
}

function touchSession(id) {
  return store.updateSession(id, { lastActiveAt: Date.now() });
}

// Reboot existing definitions on server start (best-effort, sequential).
async function restoreAll() {
  const all = store.getSessions();
  for (const s of all) {
    try {
      store.updateSession(s.id, { status: "starting", error: null });
      await startSession(s.id);
    } catch (e) {
      store.updateSession(s.id, { status: "error", error: String(e.message || e) });
    }
  }
}

function shutdownAll() {
  for (const s of store.getSessions()) {
    killSessionProc(s.id);
    pty.kill(`session:${s.id}`);
  }
  for (const c of listConsoles()) pty.kill(`console:${c.id}`);
}

// ---- consoles (ephemeral) ----

const _consoles = new Map(); // id -> {id, workspaceId, title, createdAt}

function listConsoles() {
  return [..._consoles.values()];
}

function createConsole(workspaceId) {
  const ws = workspaceById(workspaceId);
  if (!ws) throw new Error(`unknown workspace: ${workspaceId}`);
  const c = {
    id: uid("con"),
    workspaceId,
    title: `console · ${ws.name}`,
    createdAt: Date.now(),
  };
  const sh = pty.shellForPlatform();
  pty.spawn(`console:${c.id}`, sh.file, sh.args, { cwd: ws.path, cols: 100, rows: 20 });
  _consoles.set(c.id, c);
  return c;
}

function killConsole(id) {
  pty.kill(`console:${id}`);
  _consoles.delete(id);
}

module.exports = {
  createWorkspace,
  removeWorkspace,
  workspaceById,
  sessionById,
  createSession,
  startSession,
  ensureSession,
  killSession,
  touchSession,
  restoreAll,
  shutdownAll,
  listConsoles,
  createConsole,
  killConsole,
  ptyArgsFor,
  activityFor,
  describeSession,
  WORKING_WINDOW_MS,
};
