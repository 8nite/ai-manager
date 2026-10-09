// pty.js — node-pty pool with backlog replay + SSE fanout.
//
// Keys: arbitrary string (we use `session:<id>` / `console:<id>`).
// Each entry: { proc, backlog (string, capped), subs: Set<res>, exited }.
// Streaming is SSE+POST (not raw WebSocket) so it works through the
// HTTP-over-WebSocket tunnel gateway.

const CAP = 200 * 1024; // keep last 200KB per pty

let _ptyCtor = null;
function ptyCtor() {
  if (!_ptyCtor) {
    try {
      _ptyCtor = require("@lydell/node-pty");
    } catch (e) {
      throw new Error("@lydell/node-pty not installed (run npm install): " + e.message);
    }
  }
  return _ptyCtor;
}

const pool = new Map(); // key -> entry

function shellForPlatform() {
  if (process.env.AI_MGR_SHELL) return { file: process.env.AI_MGR_SHELL, args: [] };
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.SHELL || "bash", args: ["--login"] };
}

function spawn(key, file, args, opts = {}) {
  kill(key);
  const pty = ptyCtor();
  const proc = pty.spawn(file, args || [], {
    name: "xterm-256color",
    cols: opts.cols || 100,
    rows: opts.rows || 30,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}), TERM: "xterm-256color" },
  });
  const entry = { proc, backlog: "", subs: new Set(), exited: false, exitCode: null, key };
  pool.set(key, entry);
  proc.onData((data) => {
    entry.backlog += data;
    if (entry.backlog.length > CAP) entry.backlog = entry.backlog.slice(-CAP);
    for (const res of [...entry.subs]) {
      try {
        res.write(`data: ${JSON.stringify({ type: "data", data }).slice(0, 65536)}\n\n`);
      } catch {
        entry.subs.delete(res);
      }
    }
  });
  proc.onExit(({ exitCode }) => {
    entry.exited = true;
    entry.exitCode = exitCode;
    for (const res of [...entry.subs]) {
      try { res.write(`event: exit\ndata: ${JSON.stringify({ exitCode })}\n\n`); } catch {}
    }
  });
  return entry;
}

function get(key) {
  return pool.get(key) || null;
}

function ensure(key, file, args, opts) {
  const e = pool.get(key);
  if (e && !e.exited) return e;
  return spawn(key, file, args, opts);
}

function write(key, data) {
  const e = pool.get(key);
  if (!e || e.exited) return false;
  try { e.proc.write(data); return true; } catch { return false; }
}

function resize(key, cols, rows) {
  const e = pool.get(key);
  if (!e || e.exited) return false;
  try { e.proc.resize(Math.min(cols || 100, 500), Math.min(rows || 30, 200)); return true; } catch { return false; }
}

function kill(key) {
  const e = pool.get(key);
  if (!e) return;
  pool.delete(key);
  for (const res of [...e.subs]) { try { res.end(); } catch {} }
  e.subs.clear();
  try { e.proc.kill(); } catch {}
}

// Attach an SSE response: replay backlog, then stream live.
// Heartbeat comment every 15s keeps middleboxes warm (mirrors gateway).
function attachSse(key, res) {
  const e = pool.get(key);
  if (!e) return false;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (e.backlog) {
    // Replay in chunks so a single SSE frame stays small.
    for (let i = 0; i < e.backlog.length; i += 16000) {
      res.write(`data: ${JSON.stringify({ type: "data", data: e.backlog.slice(i, i + 16000), replay: true })}\n\n`);
    }
  }
  if (e.exited) {
    res.write(`event: exit\ndata: ${JSON.stringify({ exitCode: e.exitCode })}\n\n`);
    return true; // ended already; caller should end res
  }
  e.subs.add(res);
  const hb = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); e.subs.delete(res); }
  }, 15000);
  hb.unref();
  res.on("close", () => { clearInterval(hb); e.subs.delete(res); });
  return true;
}

module.exports = { spawn, get, ensure, write, resize, kill, attachSse, shellForPlatform };
