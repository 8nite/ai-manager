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
const _dshOut = new Map(); // sessionId -> recent stdout (for token capture)

// Fast session-switch liveness cache: sessionId -> timestamp of the last
// verified backend contact. Rapid switches (sidebar/palette clicks) hit this
// instead of re-probing TCP + /api/info + /api/session on every click.
// TTL is short so a backend that died since the last check is re-probed
// (and healed) within seconds; the 8s sidebar poll refreshes it anyway.
const ALIVE_TTL_MS = 30000;
const _aliveAt = new Map(); // sessionId -> Date.now() of last success
function markAlive(id) {
  if (id) _aliveAt.set(id, Date.now());
}
function isRecentlyAlive(id, ttlMs) {
  const at = _aliveAt.get(id);
  return !!at && Date.now() - at < (ttlMs || ALIVE_TTL_MS);
}
function _clearAliveForTest() {
  _aliveAt.clear();
}
// Dedupe concurrent ensures for the same session (rapid A->B->A clicks
// share one probe instead of spawning parallel adopts).
const _ensureInflight = new Map(); // sessionId -> Promise

function dshTokenFrom(text) {
  const m = /[?&]token=([A-Za-z0-9_-]{8,})/.exec(text || "");
  return m ? m[1] : null;
}

function waitForDshToken(id, timeoutMs) {
  return new Promise((resolve) => {
    const hit = dshTokenFrom(_dshOut.get(id) || "");
    if (hit) return resolve(hit);
    const start = Date.now();
    const iv = setInterval(() => {
      const tok = dshTokenFrom(_dshOut.get(id) || "");
      if (tok || Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(tok || null);
      }
    }, 250);
  });
}

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

// ---- shared opencode backend ----
//
// One `opencode serve` hosts EVERY manager opencode session as a chat
// (POST /api/session per manager session). Per-session serve processes
// (~200-600MB RSS each; 8 live + orphans ≈ 6GB) were the perf problem:
// slow creates (full boot per session), N× /active polls, heavy browser
// load. Chats are backend-agnostic (global DB: a chat created on port A is
// GET-able AND prompt-able from port B — verified live 2026-10-13), while
// execution (/active drain) is backend-local, so legacy sessions repoint
// only when idle (see migrateToShared).
// ponytail: one fixed port, not a pool — a pool is just per-session again.
function sharedPort() {
  const fixed = parseInt(process.env.AI_MGR_SHARED_PORT || "", 10);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  const base = parseInt(process.env.AI_MGR_HARNESS_BASE_PORT || String(BASE_PORT), 10);
  const b = Number.isFinite(base) && base > 0 ? base : BASE_PORT;
  return b - 10;
}

function isSharedOpencode(sess) {
  return !!sess && sess.harness === "opencode" && sess.mode === "web";
}

let _sharedProc = null; // ChildProcess for the shared backend (null when adopted)
let _sharedPid = null; // backend pid (spawned or adopted) — stamped on sessions
let _sharedStarting = null; // dedupe concurrent boots
function _sharedProcAlive() {
  try {
    return !!_sharedProc && !_sharedProc.killed &&
      (_sharedProc.exitCode === null || _sharedProc.exitCode === undefined);
  } catch {
    return false;
  }
}
function _resetSharedForTest() {
  _sharedProc = null;
  _sharedPid = null;
  _sharedStarting = null;
}

// Backend log file for the shared backend (survives restarts like per-
// session logs; rotated when oversized on fresh spawn).
function sharedLogFd() {
  const fs = require("fs");
  const os = require("os");
  const dir = path.join(os.homedir(), ".ai-manager", "backend-logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "shared-opencode.log");
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > 5 * 1024 * 1024) fs.unlinkSync(file);
  } catch {}
  return fs.openSync(file, "a");
}

// Ensure the one shared backend is up; returns its port. Adopt-or-spawn:
// a survivor (manager restart leaves web backends running) is adopted,
// else a single process is spawned. Concurrent callers share one boot.
async function ensureSharedBackend(cwdHint) {
  if (_sharedProcAlive()) return sharedPort();
  if (_sharedStarting) return _sharedStarting;
  _sharedStarting = _ensureSharedInner(cwdHint).finally(() => { _sharedStarting = null; });
  return _sharedStarting;
}

async function _ensureSharedInner(cwdHint) {
  const port = sharedPort();
  try {
    if (await tryAdoptBackend({ id: "shared", port, harnessSessionId: null })) {
      try {
        const info = await backendApi(port, "GET", "/api/info", null, 2000);
        if (info && info.pid) {
          _sharedPid = info.pid;
          for (const s of store.getSessions()) {
            if (s.port === port) store.updateSession(s.id, { backendPid: info.pid });
          }
        }
      } catch {}
      return port;
    }
  } catch (e) {
    process.stderr.write(`[shared] backend adopt failed, spawning fresh: ${e && e.message}\n`);
  }
  const h = getHarness("opencode");
  const bin = h.bin();
  const args = h.args(port);
  const os = require("os");
  let logFd = null;
  try { logFd = sharedLogFd(); } catch { logFd = null; }
  const stdio = logFd === null ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd];
  const proc = spawn(bin, args, { cwd: cwdHint || os.homedir(), stdio, env: { ...process.env, ...h.env() } });
  if (logFd !== null) { try { require("fs").closeSync(logFd); } catch {} }
  try { proc.unref(); } catch {}
  _sharedProc = proc;
  if (proc.pid) {
    _sharedPid = proc.pid;
    for (const s of store.getSessions()) {
      if (s.port === port) store.updateSession(s.id, { backendPid: proc.pid });
    }
  }
  proc.on("exit", () => {
    if (_sharedProc === proc) _sharedProc = null;
    // No session status flips here: chats persist in the backend DB and the
    // next ensure/activity poll revives them (unreachable → exited → ensure
    // respawns shared + backfills).
  });
  try {
    await waitForPort("127.0.0.1", port, 20000);
  } catch (e) {
    try { proc.kill("SIGTERM"); } catch {}
    if (_sharedProc === proc) _sharedProc = null;
    throw e;
  }
  return port;
}

// Move a legacy per-session opencode backend onto the shared one. Only
// repoints when idle: a working turn's /active drain lives on the old
// backend, and moving mid-turn would blind the attention poll. Working
// sessions stay put and retry on the next ensure. Never throws: failures
// keep the session on its old port for a later round.
async function migrateToShared(id) {
  const sess = sessionById(id);
  if (!sess || !isSharedOpencode(sess) || sess.port === sharedPort()) return sess;
  const oldPort = sess.port;
  const oldPid = sess.backendPid;
  const hid = sess.harnessSessionId;
  if (hid) {
    let active = null;
    try {
      active = await backendApi(oldPort, "GET", "/api/session/active", null, 2000);
    } catch (e) {
      if (!isConnRefused(e)) return sess; // transient/slow — retry next ensure
      active = null; // refused: old backend gone — safe to repoint
    }
    if (active && active.data && active.data[hid]) return sess; // working — stay
  }
  store.updateSession(id, { port: sharedPort(), backendPid: _sharedPid || null });
  // Reclaim the old backend when nothing references it anymore. Only our
  // own handles/pids — never a port-probe kill (a scratch manager's store
  // must never SIGTERM another manager's backends).
  try {
    const stillRefs = store.getSessions().some((s) => s.id !== id && s.port === oldPort);
    if (!stillRefs) {
      const proc = _procs.get(id);
      if (proc) {
        _procs.delete(id);
        try { proc.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 3000);
      } else if (oldPid && oldPid !== _sharedPid) {
        let infoPid = null;
        try {
          const info = await backendApi(oldPort, "GET", "/api/info", null, 2000);
          infoPid = info && info.pid;
        } catch {}
        if (infoPid === oldPid) {
          try { process.kill(oldPid, "SIGTERM"); } catch {}
        }
      }
    }
  } catch {}
  try {
    await ensureHarnessSession(id);
  } catch (e) {
    process.stderr.write(`[${id}] shared backfill after migrate failed: ${e && e.message}\n`);
  }
  markAlive(id);
  return sessionById(id);
}

// Retire the shared `opencode serve` once nothing uses it anymore (all
// opencode sessions migrated web→pty). Only our own child handle is ever
// signaled — an adopted backend (no handle) is left alone; it holds no
// unique data (chats live in the global store the TUI shares) and can be
// reaped by hand.
function maybeRetireSharedBackend() {
  if (!_sharedProcAlive()) return;
  const anyWeb = store.getSessions().some(
    (s) => s && s.harness === "opencode" && s.mode === "web"
  );
  if (anyWeb) return;
  const proc = _sharedProc;
  _sharedProc = null;
  try { proc.kill("SIGTERM"); } catch {}
}

// Opencode PTY sessions: adopt the backend chat id for `--session` resume.
//
// A fresh TUI owns no server chat until its first prompt (drafts are
// client-side), so there is nothing to capture at spawn. Poll
// `opencode session list` (newest-first, current project) and claim the
// newest chat in this workspace that appeared after the manager session was
// created and isn't claimed by another session. Best-effort, never throws;
// converges to zero work (only hid-less sessions are listed). The callers
// fire-and-forget it so polls never wait on CLI spawns.
function backfillOpencodeHarnessId(id) {
  const sess = sessionById(id);
  if (!sess || sess.harness !== "opencode" || sess.mode !== "pty" || sess.harnessSessionId) {
    return Promise.resolve(null);
  }
  const ws = workspaceById(sess.workspaceId);
  if (!ws) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let proc = null;
    try {
      proc = spawn(getHarness("opencode").bin(),
        ["session", "list", "--format", "json", "-n", "10"], { cwd: ws.path });
    } catch {
      return fin(null);
    }
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} fin(null); }, 10000);
    if (timer.unref) timer.unref();
    let out = "";
    proc.stdout.on("data", (c) => { out += String(c).slice(0, 20000); });
    proc.on("error", () => { clearTimeout(timer); fin(null); });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const d = JSON.parse(out || "{}");
        const items = Array.isArray(d) ? d : d.data || [];
        const claimed = new Set(
          store.getSessions().filter((s) => s.id !== id).map((s) => s.harnessSessionId).filter(Boolean)
        );
        const hit = (items || []).find((c) =>
          c && c.id && !claimed.has(c.id) &&
          (!c.directory || c.directory === ws.path) &&
          (Number(c.created) || 0) >= (sess.createdAt || 0) - 5000
        );
        if (!hit) return fin(null);
        const upd = { harnessSessionId: hit.id };
        // Adopt a real backend title while the local one is still the
        // creation default (mirrors syncSessionTitle's one-way rule: never
        // revert a local derived/custom title).
        const t = String(hit.title || "").trim().replace(/\s+/g, " ");
        try {
          if (t && t !== defaultTitleFor(sess) &&
            !t.startsWith(`${getHarness("opencode").label} · `) &&
            isDefaultLikeTitle(sessionById(id))) {
            upd.title = t.length > RENAME_TITLE_MAX ? t.slice(0, RENAME_TITLE_MAX) : t;
          }
        } catch {}
        store.updateSession(id, upd);
        fin(sessionById(id));
      } catch {
        fin(null);
      }
    });
  });
}

async function backfillOpencodeIds() {
  const targets = store.getSessions().filter(
    (s) => s && s.harness === "opencode" && s.mode === "pty" && !s.harnessSessionId
  );
  if (!targets.length) return [];
  const out = await Promise.allSettled(targets.map((s) => backfillOpencodeHarnessId(s.id)));
  return out.map((r) => (r.status === "fulfilled" ? r.value : null));
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

// Single-shot TCP probe (no retry loop): true when something answers,
// false on refused/timeout. Adoption is only valid when a backend is
// ALREADY listening, so a refused port settles it — the pre-spawn retry
// loop above burned ~2s on every fresh session create and every
// adopted-backend respawn for a port nothing would ever answer.
// Post-spawn boot waits keep waitForPort (something IS coming there).
function probePortOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const to = Math.max(50, timeoutMs || 750);
    const sock = net.createConnection({ host, port });
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => fin(false), to);
    if (timer.unref) timer.unref();
    sock.once("connect", () => { clearTimeout(timer); fin(true); });
    sock.once("error", () => { clearTimeout(timer); fin(false); });
  });
}

// ---- workspaces ----

function createWorkspace(dirPath) {
  const abs = path.resolve(dirPath);
  const fs = require("fs");
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`not a directory: ${abs}`);
  // Dedupe: opening the same folder twice returns the existing workspace
  // instead of a confusing duplicate group.
  const existing = store.getWorkspaces().find((w) => w.path === abs);
  if (existing) return existing;
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

// ---- path autocomplete (open-folder picker) ----

// List child directories matching a partial path so the UI can offer a
// pick-list instead of requiring exact typed paths.
//   query "" | "/home/u/"  -> children of that dir (prefix "")
//   query "/home/u/pro"    -> siblings in /home/u starting with "pro"
//   query "pro" (no slash) -> children of $HOME starting with "pro"
//   query "~" | "~/pro"    -> expanded against $HOME
// Returns { query, dir, home, entries: [{ name, path }] }.
// Never throws: unreadable/missing dirs yield an empty list.
function completePath(query, limit = 30) {
  const fs = require("fs");
  const os = require("os");
  const orig = query == null ? "" : String(query);
  const home = os.homedir() || "/";
  let q = orig.trim();
  if (!q) q = home + "/";
  else if (q === "~") q = home + "/";
  else if (q.startsWith("~/")) q = home + q.slice(1);
  else if (q.startsWith("~")) q = home + q.slice(1);

  let dirPart;
  let prefix = "";
  if (q.endsWith("/")) {
    dirPart = q;
  } else if (q.includes("/")) {
    dirPart = path.dirname(q);
    prefix = path.basename(q);
  } else {
    dirPart = home;
    prefix = q;
  }
  if (!dirPart) dirPart = home;

  let absDir;
  try {
    absDir = path.isAbsolute(dirPart) ? path.normalize(dirPart) : path.resolve(home, dirPart);
  } catch {
    return { query: orig, dir: null, home, entries: [] };
  }

  let names;
  try {
    names = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { query: orig, dir: absDir, home, entries: [] };
  }

  const low = prefix.toLowerCase();
  const out = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith(".")) {
      // Show dot-dirs only when the user explicitly typed a dot prefix.
      if (!low.startsWith(".")) continue;
    }
    if (low && !d.name.toLowerCase().startsWith(low)) continue;
    out.push(d.name);
  }
  out.sort((a, b) => a.localeCompare(b));
  const n = Math.max(1, Math.min(limit || 30, 100));
  const entries = out.slice(0, n).map((name) => ({ name, path: path.join(absDir, name) }));
  return { query: orig, dir: absDir, home, entries };
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
    // Opencode sessions share the one background backend (chats via API);
    // only other web harnesses allocate a private port.
    port: h.mode === "web" ? (harness === "opencode" ? sharedPort() : allocPort()) : null,
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
  let sess = sessionById(id);
  if (!sess) throw new Error(`unknown session: ${id}`);
  const ws = workspaceById(sess.workspaceId);
  if (!ws) throw new Error(`workspace gone for session ${id}`);
  const h = getHarness(sess.harness);
  if (sess.mode !== h.mode) {
    // Harness changed modes across versions (dsh web→pty, opencode web→pty):
    // adopt the current mode instead of booting stale web state with CLI
    // args. harnessSessionId carries over: the TUI shares the old serve
    // backend's session store, so `--session <hid>` continues the chat.
    killSessionProc(sess.id);
    store.updateSession(id, {
      mode: h.mode,
      port: h.mode === "web" ? allocPort() : null,
      harnessToken: null,
      error: null,
    });
    sess = sessionById(id);
    maybeRetireSharedBackend();
  }

  if (h.mode === "web") {
    if (sess.harness === "opencode") {
      // Shared backend: one process for all opencode sessions (see
      // ensureSharedBackend). Legacy per-session ports migrate when idle so
      // in-flight turns on surviving backends are never interrupted.
      await ensureSharedBackend(ws.path);
      let cur = sessionById(id);
      if (cur && cur.port !== sharedPort()) {
        await migrateToShared(id);
        cur = sessionById(id);
      }
      try {
        await ensureHarnessSession(id);
      } catch (e) {
        process.stderr.write(`[${id}] harness session pre-create failed: ${e.message}\n`);
      }
      store.updateSession(id, { status: "running", error: null, backendPid: _sharedPid || (cur && cur.backendPid) });
      markAlive(id);
      return sessionById(id);
    }
    await startWeb(sess, ws, h);
  } else {
    startPty(sess, ws, h);
  }
  store.updateSession(id, { status: "running", error: null });
  return sessionById(id);
}

// Backend log file for a web session (survives manager restarts; rotated
// when oversized on fresh spawn). Returns an open fd or throws.
function backendLogFd(sess) {
  const fs = require("fs");
  const os = require("os");
  const dir = path.join(os.homedir(), ".ai-manager", "backend-logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sess.id}.log`);
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > 5 * 1024 * 1024) fs.unlinkSync(file);
  } catch {}
  return fs.openSync(file, "a");
}

function waitForPortFree(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const sock = net.createConnection({ host, port });
      let done = false;
      const fin = (free) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (free) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for ${host}:${port} to free`));
        else setTimeout(attempt, 250);
      };
      sock.once("connect", () => fin(false));
      sock.once("error", () => fin(true));
    };
    attempt();
  });
}

async function killPidAndWaitFree(port, pid, timeoutMs) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if (!e || e.code !== "ESRCH") throw e;
    return; // already gone
  }
  await waitForPortFree("127.0.0.1", port, timeoutMs);
}

// Surviving-backend adoption across manager restarts (see startWeb).
// True = adopted (bound chat verified, backendPid recorded). False = caller
// should spawn fresh. Best-effort, never throws. Exported for tests.
async function tryAdoptBackend(sess, timeoutMs) {
  if (!sess || !sess.port) return false;
  const to = timeoutMs || 2000;
  // Single attempt: a survivor is already listening when this runs (adopt
  // happens before any spawn), so a refused port means "nothing there" —
  // no 2s retry loop (see probePortOnce).
  if (!(await probePortOnce("127.0.0.1", sess.port, to))) return false; // nothing there — spawn fresh
  let pid = null;
  try {
    const info = await backendApi(sess.port, "GET", "/api/info", null, to);
    pid = info && info.pid;
  } catch {
    return false; // TCP answers but not our backend API — don't touch it
  }
  if (sess.harnessSessionId) {
    try {
      await backendApi(sess.port, "GET", `/api/session/${sess.harnessSessionId}`, null, to);
    } catch (e) {
      if (!e || e.status !== 404) return false; // transient — don't disturb
      // 404: stale opencode orphan holds our port — reclaim it for the respawn.
      if (pid) {
        try {
          await killPidAndWaitFree(sess.port, pid, 3000);
        } catch (e2) {
          process.stderr.write(`[${sess.id}] adopt reclaim failed: ${e2 && e2.message}\n`);
        }
      }
      return false;
    }
    if (pid) store.updateSession(sess.id, { backendPid: pid });
    markAlive(sess.id);
    return true;
  }
  // Unbound session with a live opencode on our port: overwhelmingly our own
  // orphan — adopt; ensureSession lazy-backfills the chat binding.
  if (pid) store.updateSession(sess.id, { backendPid: pid });
  markAlive(sess.id);
  return true;
}

// Live child-handle check (adopted backends have none — see backendPid).
function liveWebProc(id) {
  const p = _procs.get(id);
  try {
    return !!p && !p.killed && (p.exitCode === null || p.exitCode === undefined);
  } catch {
    return false;
  }
}

function isConnRefused(e) {
  return !!e && (e.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(String((e && e.message) || "")));
}

// Ids whose backend refused TCP on the last probe (backend gone, not merely
// slow). Consumed by syncAllWebActivity to mark sessions exited. Fail-open:
// timeouts and HTTP errors never land here.
const _webUnreachable = new Set();

async function startWeb(sess, ws, h) {
  // Keep-alive across manager restarts: shutdownAll() leaves web backends
  // running, so adopt the survivor (same port + bound chat verified) instead
  // of respawning and interrupting an in-flight turn.
  try {
    if (await tryAdoptBackend(sess)) {
      store.updateSession(sess.id, { status: "running", error: null });
      return;
    }
  } catch (e) {
    process.stderr.write(`[${sess.id}] backend adopt failed, spawning fresh: ${e && e.message}\n`);
  }
  killSessionProc(sess.id);
  _dshOut.delete(sess.id);
  if (sess.harness === "dsh") store.updateSession(sess.id, { harnessToken: null });
  const bin = h.bin();
  const args = h.args(sess.port);
  // File stdio (not pipes): the backend must survive the manager exiting, and
  // a broken stdout pipe would SIGPIPE it after we go away. Logs land in
  // ~/.ai-manager/backend-logs/<sess>.log (rotated when >5MB on spawn).
  // unref lets the manager exit without waiting out its backends.
  let logFd = null;
  try { logFd = backendLogFd(sess); } catch { logFd = null; }
  const stdio = logFd === null ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd];
  const proc = spawn(bin, args, { cwd: ws.path, stdio, env: { ...process.env, ...h.env() } });
  if (logFd !== null) { try { require("fs").closeSync(logFd); } catch {} } // child holds its dup
  try { proc.unref(); } catch {}
  _procs.set(sess.id, proc);
  if (proc.pid) store.updateSession(sess.id, { backendPid: proc.pid });
  if (proc.stdout) {
    _dshOut.set(sess.id, "");
    proc.stdout.on("data", (c) => {
      process.stdout.write(`[${sess.id}] ${c}`);
      if (sess.harness === "dsh") {
        const buf = (_dshOut.get(sess.id) || "") + String(c);
        _dshOut.set(sess.id, buf.slice(-4096));
      }
    });
  }
  if (proc.stderr) proc.stderr.on("data", (c) => process.stderr.write(`[${sess.id}] ${c}`));
  proc.on("exit", (code) => {
    if (_procs.get(sess.id) === proc) _procs.delete(sess.id);
    _aliveAt.delete(sess.id);
    const cur = sessionById(sess.id);
    if (cur && cur.status === "running") {
      store.updateSession(sess.id, { status: "exited", error: `backend exited (code ${code})` });
    }
  });
  // Adopt-or-wait: if something already answers on the port, adopt it.
  // Boot window is per-harness: dsh cold-starts via npx (can exceed 60s).
  try {
    await waitForPort("127.0.0.1", sess.port, (h && h.bootTimeoutMs) || 20000);
  } catch (e) {
    killSessionProc(sess.id);
    throw e;
  }
  // dsh prints its access token to stdout (`?token=…`, required upstream —
  // the browser must never see it). Capture and store for proxy injection.
  if (sess.harness === "dsh") {
    try {
      const tok = await waitForDshToken(sess.id, 15000);
      if (tok) store.updateSession(sess.id, { harnessToken: tok });
    } catch (e) {
      process.stderr.write(`[${sess.id}] dsh token capture failed: ${e.message}\n`);
    }
  }
  // Opencode backends: pre-create a chat session bound to the workspace
  // directory so the iframe lands directly in chat (no project picker).
  // Best-effort: picker fallback when this fails.
  if (sess.harness === "opencode") {
    try {
      await ensureHarnessSession(sess.id);
    } catch (e) {
      process.stderr.write(`[${sess.id}] harness session pre-create failed: ${e.message}\n`);
    }
  }
  markAlive(sess.id);
}

// Opencode chat pre-create (per manager session, bound to workspace dir).
// Verifies a stored harnessSessionId, recreates on 404. Returns the live id
// or null. Exported for tests.
function backendAuthHeader() {
  try {
    return require("./opencodeAuth").authHeader();
  } catch {
    return null;
  }
}

function backendApi(port, method, apiPath, body, timeoutMs) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { "Content-Type": "application/json" };
    const ah = backendAuthHeader();
    if (ah) headers["Authorization"] = ah;
    if (data) headers["Content-Length"] = String(data.length);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: apiPath, headers, timeout: timeoutMs || 10000 },
      (res) => {
        const bufs = [];
        res.on("data", (c) => bufs.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(bufs).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else {
            const e = new Error(`backend ${method} ${apiPath} → ${res.statusCode}`);
            e.status = res.statusCode;
            e.body = raw;
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("backend api timeout")));
    if (data) req.write(data);
    req.end();
  });
}

async function ensureHarnessSession(id) {
  const sess = sessionById(id);
  if (!sess || sess.harness !== "opencode" || !sess.port) return null;
  const ws = workspaceById(sess.workspaceId);
  if (!ws) return null;
  if (sess.harnessSessionId) {
    try {
      await backendApi(sess.port, "GET", `/api/session/${sess.harnessSessionId}`);
      markAlive(id);
      return sess.harnessSessionId;
    } catch (e) {
      if (!e || e.status !== 404) return sess.harnessSessionId; // transient — keep
      store.updateSession(id, { harnessSessionId: null });
    }
  }
  const live = sessionById(id);
  // Backend may answer TCP (waitForPort) just before its API is ready —
  // retry 5xx/network errors briefly before falling back to the picker.
  let hid = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 5 && !hid; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await backendApi(sess.port, "POST", "/api/session", {
        location: { directory: ws.path },
        title: (live && live.title) || undefined,
      });
      hid = r && r.data && r.data.id;
    } catch (e) {
      lastErr = e;
      if (e && e.status && e.status < 500) break; // 4xx won't heal
    }
  }
  if (!hid) throw lastErr || new Error("backend session create returned no id");
  store.updateSession(id, { harnessSessionId: hid });
  markAlive(id);
  return hid;
}

// Config pre-warm for opencode web sessions (see proxy.js config cache).
//
// A new/cold session's iframe fires ~8 workspace config GETs
// (/api/project|model|provider|integration|config|location|vcs|shell) the
// moment it boots — every one a tunnel RTT (~250-800ms) on a cold cache,
// which is exactly the "models take forever" gap before the composer
// enables. Warming them here over loopback (~1-3ms each, parallel) right
// when the manager creates/ensures the session means the browser's calls
// land as cache HITs seconds later. Bare + ?location[directory]= variants
// (the client sends both). Best-effort, never throws; fire-and-forget from
// the routes so responses never wait on it. Exported for routes + tests.
const PREWARM_API_PATHS = ["project", "model", "provider", "integration", "config", "location", "vcs", "shell"];
async function prewarmSessionConfig(id) {
  const sess = sessionById(id);
  if (!sess || sess.harness !== "opencode" || sess.mode !== "web" || !sess.port) return false;
  const ws = workspaceById(sess.workspaceId);
  const dir = ws && ws.path;
  const paths = [];
  for (const p of PREWARM_API_PATHS) {
    paths.push(`/api/${p}`);
    if (dir) paths.push(`/api/${p}?location%5Bdirectory%5D=${encodeURIComponent(dir)}`);
  }
  const out = await Promise.allSettled(paths.map(async (apiPath) => {
    let data;
    try {
      // Generous timeout: right after a manager restart the backend serves
      // restore traffic too, and a 3s timeout dropped the whole batch under
      // burst load (observed live: all-MISS after a fresh boot). Background
      // anyway — lateness beats absence.
      data = await backendApi(sess.port, "GET", apiPath, null, 10000);
    } catch {
      return;
    }
    if (data === undefined || data === null) return;
    // Lazy require: proxy.js requires sessions.js at load; calling back at
    // request time (both modules settled) avoids the cycle.
    const subPath = apiPath.split("?")[0];
    const qs = apiPath.includes("?") ? apiPath.slice(apiPath.indexOf("?")) : "";
    require("./proxy").configCacheSet(
      require("./proxy").configCacheKey(subPath, qs),
      { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(data)), at: Date.now() }
    );
  }));
  return out.some((r) => r.status === "fulfilled");
}

// Creation-default title for a session (what createSession assigns when no
// explicit title is given). Used to detect "never titled" sessions.
function defaultTitleFor(sess) {
  try {
    const ws = (sess && sess.workspaceId && workspaceById(sess.workspaceId)) || null;
    const h = getHarness(sess.harness);
    return `${h.label} · ${ws ? ws.name : ""}`.trim();
  } catch {
    return "";
  }
}

function isDefaultLikeTitle(sess) {
  const cur = (sess && sess.title) || "";
  if (!cur) return true;
  if (cur === defaultTitleFor(sess)) return true;
  // Prefix fallback: workspace renames shouldn't strand the detection.
  try {
    if (cur.startsWith(`${getHarness(sess.harness).label} · `)) return true;
  } catch {}
  return false;
}

// Harness title sync (backend → manager, best-effort, never throws).
//
// Opencode owns the title: its title agent renames the backend chat after the
// first prompt, and the user can rename inside the opencode UI. The manager
// pre-created that chat with its own title, so without a pull-back the left
// panel keeps the stale creation title forever ("opencode · <ws>"). Pull the
// backend title and adopt it when it is a real (non-default) title.
//
// Observed (2026-10-10, v2.0.26): the backend agent does NOT always rename —
// a bound chat with a user "hi" + assistant replies kept the default title.
// Fallback: when the backend title is stale (empty or still the creation
// default) AND the local title is still the creation default, derive from
// the earliest user message ("hi" → "hi") for LOCAL display only. The
// derivation is never pushed back: pushing would plant a non-default title
// on the backend and pre-empt opencode's own title agent. Likewise a stale
// backend default never reverts a local derived/custom title.
// Custom local titles are never derived over: the fallback only fires while
// the local title is still default-like.
// Skips non-opencode sessions and sessions without a bound chat. Overlong
// backend titles are truncated to RENAME_TITLE_MAX (UI sanity). Returns the
// updated record, the current record when unchanged/skipped, or null when
// the session is unknown or the backend fetch failed (transient — keep the
// local title).
async function syncSessionTitle(id, timeoutMs) {
  const sess = sessionById(id);
  if (!sess || sess.harness !== "opencode" || !sess.port || !sess.harnessSessionId) return sess || null;
  const to = timeoutMs || 2500;
  let remote;
  try {
    remote = await backendApi(sess.port, "GET", `/api/session/${sess.harnessSessionId}`, null, to);
  } catch {
    return null; // backend restarting/down — keep local title
  }
  const raw = remote && remote.data && remote.data.title;
  const t = String(raw ?? "").trim().replace(/\s+/g, " ");
  const backendIsDefault = !t || t === defaultTitleFor(sess) || (() => {
    try {
      return t.startsWith(`${getHarness(sess.harness).label} · `);
    } catch { return false; }
  })();
  if (!backendIsDefault) {
    const next = t.length > RENAME_TITLE_MAX ? t.slice(0, RENAME_TITLE_MAX) : t;
    if (next !== sess.title) return store.updateSession(id, { title: next });
    return sess;
  }
  // Backend is still default/empty: never revert a local derived/custom title.
  if (!isDefaultLikeTitle(sess)) return sess;
  // Backend never titled this chat (still default/empty) and neither did we:
  // derive from the earliest user message. Best-effort, never throws.
  let first = "";
  try {
    const m = await backendApi(sess.port, "GET", `/api/session/${sess.harnessSessionId}/message`, null, to);
    const list = (m && m.data) || [];
    if (Array.isArray(list)) {
      const users = list
        .filter((x) => x && x.type === "user" && String(x.text || "").trim())
        .sort((a, b) => (((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0)));
      if (users.length) first = String(users[0].text).trim().replace(/\s+/g, " ");
    }
  } catch {
    return sess;
  }
  if (!first) return sess;
  const next = first.length > RENAME_TITLE_MAX ? first.slice(0, RENAME_TITLE_MAX) : first;
  if (next === sess.title) return sess;
  // Local display only — never pushed: the backend copy stays default so
  // opencode's own title agent can still fire and win on a later pull.
  return store.updateSession(id, { title: next });
}

// Sync every bound opencode chat concurrently. Best-effort: individual
// failures resolve to null and never reject the batch. Awaited by
// GET /api/state + /api/sessions so the 8s sidebar poll picks up backend
// auto-titles with no frontend change.
async function syncAllSessionTitles(timeoutMs) {
  const targets = store.getSessions().filter(
    (s) => s && s.harness === "opencode" && s.port && s.harnessSessionId
  );
  if (!targets.length) return [];
  const out = await Promise.allSettled(targets.map((s) => syncSessionTitle(s.id, timeoutMs)));
  return out.map((r) => (r.status === "fulfilled" ? r.value : null));
}

// Write-through for manager-initiated renames (manager → backend,
// best-effort, never throws). Keeps the two title copies converged so a later
// syncSessionTitle doesn't revert the user's rename to the stale backend
// copy. Returns true on success, false when skipped or failed.
async function pushTitleToHarness(id, timeoutMs) {
  const sess = sessionById(id);
  if (!sess || sess.harness !== "opencode" || !sess.port || !sess.harnessSessionId) return false;
  try {
    await backendApi(sess.port, "PATCH", `/api/session/${sess.harnessSessionId}`, { title: sess.title }, timeoutMs || 5000);
    return true;
  } catch (e) {
    process.stderr.write(`[${id}] harness title push failed: ${e && e.message}\n`);
    return false;
  }
}

function startPty(sess, ws, h) {
  const key = `session:${sess.id}`;
  const existing = pty.get(key);
  if (existing && !existing.exited) return;
  const bin = h.bin();
  const args = ptyArgsFor(sess, h);
  const env = h.env();
  const spawnOpts = { cwd: ws.path, env, cols: 100, rows: 30 };
  // droid `resume --last` exits instantly when the folder holds no droid
  // conversations ("No sessions found"). Fall back once to a plain
  // interactive launch (lands on the auth wall, but alive and actionable)
  // instead of a permanently dead session.
  if (sess.harness === "droid" && args[0] === "resume") {
    spawnOpts.onExit = ({ exitCode }) => {
      if (exitCode === 0) return;
      const entry = pty.get(key);
      if (!/No sessions found/i.test((entry && entry.backlog) || "")) return;
      process.stderr.write(`[${sess.id}] droid resume found nothing; falling back to interactive\n`);
      try {
        pty.spawn(key, bin, h.args(null), { cwd: ws.path, env, cols: 100, rows: 30 });
      } catch (e) {
        process.stderr.write(`[${sess.id}] droid fallback failed: ${e.message}\n`);
      }
    };
  }
  pty.spawn(key, bin, args, spawnOpts);
  if (!sess.everRan) store.updateSession(sess.id, { everRan: true });
}

// PTY spawn policy per harness:
//   droid: first run is plain interactive; respawns after an exit use
//     `resume --last` so a conversation continues instead of starting blank.
//     (--last = most recent session in the folder, which is ours unless the
//     user ran another droid there meanwhile.)
//   agy: first run is plain interactive; respawns use `--continue` (most
//     recent conversation GLOBALLY — which is ours unless another agy session
//     ran meanwhile; keep one agy session per workspace or set an explicit
//     harness conversation id). `--conversation` adoption only when a harness
//     session id is known.
//   dsh: one-shot `headless`; the session goal is the task (Resume re-runs
//     it). --session-id adoption only when a harness session id is known.
function ptyArgsFor(sess, h) {
  if (sess.harness === "dsh") {
    return h.args(sess.harnessSessionId || null, (sess.title || "").trim() || null);
  }
  if (sess.harnessSessionId) return h.args(sess.harnessSessionId);
  if (sess.everRan && sess.harness === "droid") return ["resume", "--last"];
  if (sess.everRan && sess.harness === "agy") return [...h.args(null), "--continue"];
  return h.args(null);
}

// Attention/activity model (pure — tested in tests/activity.test.js).
//
//   web (opencode) sessions: polled from the backend (see webActivity* below).
//     working = foreground drain owned by this backend (`GET /active`)
//               or streaming a reply / just prompted (pickup race)
//     waiting = turn finished (idle / completed reply, permission or form
//               pending) — needs the user's input
//     running = fresh chat with no messages yet (available, not attention)
//   pty sessions: working  = output within the last 8s (likely generating)
//                 waiting  = quiet longer (likely needs your input)
//                 finished = PTY exited / no PTY ever spawned
const WORKING_WINDOW_MS = 8000;
// Grace for the prompt-pickup race: a freshly sent user message reads as
// inactive until the backend takes the foreground drain.
const PICKUP_GRACE_MS = 15000;

function activityFor(sess, ptyInfo, now = Date.now()) {
  if (sess.mode === "web") {
    const cached = _webActivity.get(sess.id);
    // Cache is refreshed by syncAllWebActivity on every /api/state poll;
    // fall back to process status when it hasn't run yet (boot) or the
    // backend was unreachable (fail-open: no false attention).
    if (cached) return { activity: cached.activity, idleMs: cached.idleMs };
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

// ---- opencode web attention (backend-polled) ----

// Live web-activity cache, refreshed by syncAllWebActivity() ahead of every
// /api/state + /api/sessions poll. read by activityFor() above.
const _webActivity = new Map(); // managerSessionId -> { activity, idleMs, at }

function _clearWebActivityForTest() {
  _webActivity.clear();
}

function latestStampOf(msg) {
  if (!msg || !msg.time) return 0;
  return Number(msg.time.completed || msg.time.created || 0) || 0;
}

// Pure decision: given one backend snapshot, is this chat working, waiting,
// or fresh? Tested in tests/activity.test.js.
//   snap: { isActive, hasMessages, latest, pendingApproval }
//   latest: newest message object (or null); only type + time are read.
function webActivityFromSnapshot(snap, now = Date.now()) {
  const s = snap || {};
  const latest = s.latest || null;
  const stamp = latestStampOf(latest);
  const ageMs = stamp ? Math.max(0, now - stamp) : 0;
  // A permission request or question form blocks the turn on the user even
  // while the backend still owns the foreground drain.
  if (s.pendingApproval) return { activity: "waiting", idleMs: ageMs };
  if (s.isActive) return { activity: "working", idleMs: 0 };
  if (!s.hasMessages || !latest) return { activity: "running", idleMs: 0 };
  // Streaming reply whose completion hasn't landed yet (or just landed while
  // the drain was being handed over) — still the agent's turn.
  if (latest.type === "assistant" && !(latest.time && latest.time.completed)) {
    return { activity: "working", idleMs: 0 };
  }
  // Freshly prompted: the backend hasn't taken the drain yet.
  if (latest.type === "user" && ageMs < PICKUP_GRACE_MS) {
    return { activity: "working", idleMs: 0 };
  }
  return { activity: "waiting", idleMs: ageMs };
}

// Single-session poll against its own backend. Returns {activity, idleMs} or
// null when skipped (non-opencode / unbound / not running) or the backend
// is unreachable (fail-open: caller keeps "running", never false attention).
// activeData (the /api/session/active payload for this backend) may be
// injected by the batched sync below so N sessions on the shared backend
// cost one /active fetch instead of N. Exported for tests.
async function getWebActivity(id, timeoutMs, activeData) {
  const sess = sessionById(id);
  if (!sess || sess.harness !== "opencode" || sess.mode !== "web") return null;
  if (sess.status !== "running" || !sess.port || !sess.harnessSessionId) return null;
  const to = timeoutMs || 1500;
  const hid = sess.harnessSessionId;
  let data;
  if (activeData !== undefined) {
    data = activeData || {};
  } else {
    let active;
    try {
      active = await backendApi(sess.port, "GET", "/api/session/active", null, to);
      _webUnreachable.delete(id);
    } catch (e) {
      // Refused + no live child handle = backend is gone (e.g. died while
      // adopted across a restart). syncAllWebActivity marks it exited; plain
      // timeouts/HTTP errors fail open to null (no false attention).
      // Shared-backend sessions hold no per-session handle, so a refused
      // shared port correctly marks all of them (next ensure revives).
      if (isConnRefused(e) && !liveWebProc(id)) _webUnreachable.add(id);
      return null;
    }
    data = (active && active.data) || {};
  }
  const isActive = !!data[hid];
  const jobs = [];
  jobs.push(
    backendApi(sess.port, "GET", `/api/session/${hid}/message?limit=1&order=desc`, null, to)
      .then((m) => (m && m.data) || [])
      .catch(() => null)
  );
  if (isActive) {
    // Only needed to override working → waiting when the agent is blocked
    // on the user; inactive chats are waiting already (or fresh/working via
    // the message rule), so skip the extra calls there.
    jobs.push(
      backendApi(sess.port, "GET", `/api/session/${hid}/permission`, null, to)
        .then((p) => (p && p.data) || [])
        .catch(() => null)
    );
    jobs.push(
      backendApi(sess.port, "GET", `/api/session/${hid}/form`, null, to)
        .then((f) => (f && f.data) || [])
        .catch(() => null)
    );
  }
  const [msgs, perms, forms] = await Promise.all(jobs);
  if (!msgs) return null; // message history unreadable — fail open
  markAlive(id); // backend answered — recent enough to skip the next ensure probe
  const latest = msgs.length ? msgs[0] : null;
  const pendingApproval =
    (Array.isArray(perms) && perms.length > 0) || (Array.isArray(forms) && forms.length > 0);
  return webActivityFromSnapshot(
    { isActive, hasMessages: msgs.length > 0, latest, pendingApproval: !!pendingApproval },
    Date.now()
  );
}

// Refresh the web-activity cache for every eligible session concurrently.
// Best-effort: individual failures resolve to null and never reject the
// batch; stale cache entries for dead sessions are pruned. Awaited by
// GET /api/state + /api/sessions alongside the title sync.
//
// One /api/session/active fetch per backend PORT (not per session): all
// opencode sessions share one backend, so per-session drains would hit it
// N× per poll. Message/permission/form fetches stay per-session.
async function syncAllWebActivity(timeoutMs) {
  const to = timeoutMs || 1500;
  const targets = store.getSessions().filter(
    (s) =>
      s && s.harness === "opencode" && s.mode === "web" &&
      s.status === "running" && s.port && s.harnessSessionId
  );
  const live = new Set(targets.map((s) => s.id));
  for (const id of [..._webActivity.keys()]) {
    if (!live.has(id)) _webActivity.delete(id);
  }
  if (!targets.length) return new Map();
  const byPort = new Map();
  for (const s of targets) {
    if (!byPort.has(s.port)) byPort.set(s.port, []);
    byPort.get(s.port).push(s);
  }
  const map = new Map();
  await Promise.all([...byPort.entries()].map(async ([port, ss]) => {
    let activeData = null;
    let activeOk = false;
    try {
      const active = await backendApi(port, "GET", "/api/session/active", null, to);
      activeData = (active && active.data) || {};
      activeOk = true;
      for (const s of ss) _webUnreachable.delete(s.id);
    } catch (e) {
      // Fail-open like the single-session path: only refused backends with
      // no live handle count as gone (marked exited below); timeouts and
      // HTTP errors keep the last cache entry.
      if (isConnRefused(e)) {
        for (const s of ss) {
          if (!liveWebProc(s.id)) _webUnreachable.add(s.id);
        }
      }
    }
    if (!activeOk) return;
    const out = await Promise.allSettled(ss.map((s) => getWebActivity(s.id, to, activeData)));
    out.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return;
      _webActivity.set(ss[i].id, { ...r.value, at: Date.now() });
      map.set(ss[i].id, r.value);
    });
  }));
  // Adopted backends have no child handle, so nothing fires when they die —
  // flip them to exited here (user click re-spawns via ensure). Sessions with
  // a live handle are covered by its exit event instead.
  for (const s of targets) {
    if (!_webUnreachable.has(s.id)) continue;
    _webUnreachable.delete(s.id);
    _webActivity.delete(s.id);
    _aliveAt.delete(s.id);
    if (liveWebProc(s.id)) continue;
    store.updateSession(s.id, { status: "exited", error: "backend unreachable (process gone)" });
  }
  return map;
}
// ensure = resume path: restart only if dead, else no-op.
//
// Fast path: a session verified alive within ALIVE_TTL_MS (adopt success,
// recent poll, previous ensure) returns immediately — no TCP probe, no
// backend round-trips. Rapid sidebar/palette switches between a few live
// sessions therefore cost one store read. Unbound opencode chats still fall
// through to backfill; concurrent ensures for one id share a single probe.
async function ensureSession(id) {
  const inflight = _ensureInflight.get(id);
  if (inflight) return inflight;
  const p = _ensureInner(id).finally(() => {
    if (_ensureInflight.get(id) === p) _ensureInflight.delete(id);
  });
  _ensureInflight.set(id, p);
  return p;
}

async function _ensureInner(id) {
  const sess = sessionById(id);
  if (!sess) throw new Error(`unknown session: ${id}`);
  if (sess.mode === "web") {
    if (isSharedOpencode(sess)) {
      // ponytail: liveness cache first — same store record, zero I/O.
      if (sess.status === "running" && sess.harnessSessionId && isRecentlyAlive(id)) {
        return sessionById(id);
      }
      const ws = workspaceById(sess.workspaceId);
      if (!ws) throw new Error(`workspace gone for session ${id}`);
      await ensureSharedBackend(ws.path);
      let cur = sessionById(id);
      if (cur && cur.port !== sharedPort()) {
        // Legacy per-session backend: repoint when idle (working turns
        // stay until the next ensure so the /active drain never blinds).
        await migrateToShared(id);
        cur = sessionById(id);
      }
      if (cur && cur.harness === "opencode" && !cur.harnessSessionId) {
        try {
          await ensureHarnessSession(id);
        } catch (e) {
          process.stderr.write(`[${id}] harness session backfill failed: ${e.message}\n`);
        }
        cur = sessionById(id);
      }
      store.updateSession(id, { status: "running", error: null, backendPid: _sharedPid || (cur && cur.backendPid) });
      markAlive(id);
      return sessionById(id);
    }
    if (sess.status === "running" && sess.port && isRecentlyAlive(id)) {
      if (sess.harness === "opencode" && !sess.harnessSessionId) {
        // Needs a chat backfill — can't skip.
      } else {
        return sessionById(id);
      }
    }
    const proc = _procs.get(id);
    if (proc && !proc.killed && !proc.exitCode) {
      try {
        // Skip the TCP wait when another path just verified this backend.
        if (!isRecentlyAlive(id)) await waitForPort("127.0.0.1", sess.port, 2000);
        store.updateSession(id, { status: "running", error: null });
        markAlive(id);
        // Lazy backfill: older sessions lack a pre-created chat.
        if (sess.harness === "opencode" && !sessionById(id).harnessSessionId) {
          try {
            await ensureHarnessSession(id);
          } catch (e) {
            process.stderr.write(`[${id}] harness session backfill failed: ${e.message}\n`);
          }
        }
        return sessionById(id);
      } catch { /* fall through to restart */ }
    }
    await startSession(id);
    markAlive(id);
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
  const sess0 = sessionById(id);
  if (sess0 && isSharedOpencode(sess0)) return; // shared process outlives any one session
  const proc = _procs.get(id);
  if (proc) {
    _procs.delete(id);
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 3000);
  }
  // Adopted/surviving backends have no child handle — stop the recorded pid.
  // Verified against /api/info so a recycled pid is never signaled; the
  // fallback liveness check no-ops when the pid is already gone.
  const sess = sessionById(id);
  const pid = sess && sess.backendPid;
  if (pid) {
    store.updateSession(id, { backendPid: null });
    (async () => {
      try {
        const info = await backendApi(sess.port, "GET", "/api/info", null, 2000);
        if (!info || info.pid !== pid) return; // not ours — leave it
      } catch (e) {
        if (e && e.status) return; // port answers HTTP errors — not ours
        // Port closed: pid may linger without its server — fall through to
        // the liveness check, which no-ops when the pid is gone.
      }
      try { process.kill(pid, 0); } catch { return; }
      try { process.kill(pid, "SIGTERM"); } catch {}
    })().catch(() => {});
  }
}

// Live web-backend child count (prunes reaped entries). Used by shutdown to
// wait out graceful exits so restarts don't orphan slow backends (dsh/node
// was observed surviving SIGTERM past process.exit).
function webProcCount() {
  for (const [id, proc] of [..._procs.entries()]) {
    try {
      if (proc.exitCode !== null && proc.exitCode !== undefined) _procs.delete(id);
      else if (proc.killed) _procs.delete(id);
    } catch {
      _procs.delete(id);
    }
  }
  return _procs.size;
}

function killSession(id) {
  const sess = sessionById(id);
  if (sess && isSharedOpencode(sess)) {
    // Chat lives in the shared backend's global DB: best-effort DELETE so
    // dead chats don't pile up. The shared process itself stays for the
    // remaining sessions — never killed here.
    const port = sess.port;
    const hid = sess.harnessSessionId;
    if (port && hid) {
      backendApi(port, "DELETE", `/api/session/${hid}`, null, 2000).catch(() => {});
    }
    _aliveAt.delete(id);
    _ensureInflight.delete(id);
    store.removeSession(id);
    return;
  }
  killSessionProc(id);
  pty.kill(`session:${id}`);
  _aliveAt.delete(id);
  _ensureInflight.delete(id);
  store.removeSession(id);
}

function touchSession(id) {
  return store.updateSession(id, { lastActiveAt: Date.now() });
}

const RENAME_TITLE_MAX = 120;

// Rename a session's title (left-panel inline edit). Trims + collapses
// whitespace; throws on missing session / empty / overlong title.
// Exported for the PATCH route + tests.
function renameSession(id, title) {
  const sess = sessionById(id);
  if (!sess) throw new Error(`unknown session: ${id}`);
  const t = String(title ?? "").trim().replace(/\s+/g, " ");
  if (!t) throw new Error("title required");
  if (t.length > RENAME_TITLE_MAX) throw new Error(`title too long (max ${RENAME_TITLE_MAX})`);
  if (t === sess.title) return sess;
  return store.updateSession(id, { title: t, lastActiveAt: Date.now() });
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
    // Web backends intentionally SURVIVE manager shutdown: the rebooted
    // manager adopts them (tryAdoptBackend) so in-flight turns are never
    // interrupted by a deploy. Only terminal sessions die with the manager
    // (their stdio is the pty itself).
    if (s.mode !== "web") pty.kill(`session:${s.id}`);
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
  completePath,
  workspaceById,
  sessionById,
  createSession,
  startSession,
  ensureSession,
  killSession,
  killSessionProc,
  touchSession,
  restoreAll,
  shutdownAll,
  listConsoles,
  createConsole,
  killConsole,
  ptyArgsFor,
  activityFor,
  describeSession,
  webActivityFromSnapshot,
  getWebActivity,
  syncAllWebActivity,
  tryAdoptBackend,
  probePortOnce,
  ensureHarnessSession,  syncSessionTitle,
  syncAllSessionTitles,
  pushTitleToHarness,
  prewarmSessionConfig,
  renameSession,
  RENAME_TITLE_MAX,
  webProcCount,
  sharedPort,
  isSharedOpencode,
  ensureSharedBackend,
  migrateToShared,
  maybeRetireSharedBackend,
  backfillOpencodeHarnessId,
  backfillOpencodeIds,
  _resetSharedForTest,
  WORKING_WINDOW_MS,
  PICKUP_GRACE_MS,
  ALIVE_TTL_MS,
  markAlive,
  isRecentlyAlive,
  _clearAliveForTest,
  _clearWebActivityForTest,
};
