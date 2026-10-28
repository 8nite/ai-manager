// index.js — ai-manager server wiring (express, no build step).
//
//   manager UI  → http://127.0.0.1:<AI_MGR_PORT|4000>
//   tunnel      → scripts/ai-tunnel.js forwards this port to ai-manager.nexvision.cc

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");

const store = require("./store");
const sessions = require("./sessions");
const pty = require("./pty");
const proxy = require("./proxy");
const { harnessNames } = require("./backends");

const PORT = parseInt(process.env.AI_MGR_PORT || "4000", 10);
// Bind host (default loopback). Set AI_MGR_HOST=0.0.0.0 for direct LAN
// access (e.g. phone/another machine on the same network — no auth on the
// manager UI, so only do this on networks you trust).
const HOST = process.env.AI_MGR_HOST || "127.0.0.1";
const VERSION = require("../../package.json").version;

const app = express();

// Harness reverse proxy FIRST: express.json() below consumes request
// streams for JSON bodies, which would strip POST/PUT bodies bound for
// web harness backends. The proxy only intercepts /harness/* and /s/*
// and calls next() for everything else.
app.use(proxy.explicitMiddleware);

// Remote web-harness API: backends like opencode call root-absolute /api/*
// (e.g. GET /api/event SSE). Unknown manager routes proxy to the active
// backend instead of 404ing. Mounted BEFORE express.json() so POST/PUT
// bodies bound for backends stream through intact.
app.use("/api/", proxy.apiBackendMiddleware);

app.use(express.json({ limit: "256kb" }));

// ---- health ----
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    workspaces: store.getWorkspaces().length,
    sessions: store.getSessions().length,
    uptime: process.uptime(),
  });
});

// ---- state ----
app.get("/api/state", async (_req, res) => {
  // Pull backend auto-titles (title agent renames the chat after the first
  // prompt) so the sidebar picks them up on its 8s poll. Best-effort: sync
  // never fails the route. Titles + activity run concurrently (not in
  // series) so one slow backend stalls the poll once, not twice.
  try { await Promise.all([sessions.syncAllSessionTitles(), sessions.syncAllWebActivity(1500)]); } catch {}
  res.json({
    workspaces: store.getWorkspaces(),
    sessions: store.getSessions().map(sessions.describeSession),
    consoles: sessions.listConsoles(),
    harnesses: harnessNames(),
  });
});

// ---- path autocomplete ("open folder" picker) ----
app.get("/api/paths/complete", (req, res) => {
  const q = (req.query && (req.query.q ?? req.query.query ?? req.query.path)) || "";
  try {
    res.json(sessions.completePath(String(q)));
  } catch {
    res.json({ query: String(q), dir: null, home: null, entries: [] });
  }
});

// ---- workspaces ("open folder") ----
app.post("/api/workspaces", (req, res) => {
  const p = req.body && req.body.path;
  if (!p || typeof p !== "string") {
    return res.status(400).json({ error: "path required" });
  }
  try {
    const ws = sessions.createWorkspace(p);
    res.json(ws);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.delete("/api/workspaces/:id", (req, res) => {
  const dropped = sessions.removeWorkspace(req.params.id);
  res.json({ ok: true, droppedSessions: dropped });
});

// ---- sessions ----
app.post("/api/sessions", async (req, res) => {
  const { workspaceId, harness, title } = req.body || {};
  if (!workspaceId || !harness) {
    return res.status(400).json({ error: "workspaceId + harness required" });
  }
  try {
    const s = await sessions.createSession(workspaceId, harness, title);
    res.json(s);
    // Pre-warm workspace config over loopback (never blocks the response):
    // the new session's iframe boots seconds later and its config calls
    // should hit the proxy cache instead of paying tunnel RTTs each.
    if (s && s.harness === "opencode") {
      sessions.prewarmSessionConfig(s.id).catch(() => {});
    }
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/sessions", async (_req, res) => {
  try { await Promise.all([sessions.syncAllSessionTitles(), sessions.syncAllWebActivity(1500)]); } catch {}
  res.json(store.getSessions().map(sessions.describeSession));
});

app.post("/api/sessions/:id/ensure", async (req, res) => {
  try {
    const s = await sessions.ensureSession(req.params.id);
    // Title sync runs after the response so switches never wait on it —
    // the 8s sidebar poll converges titles anyway.
    res.json(sessions.sessionById(req.params.id) || s);
    try { await sessions.syncSessionTitle(req.params.id); } catch {}
    // Same pre-warm as create (background): every switch calls ensure just
    // before its iframe boots, rolling the 30s config TTL forward.
    try {
      const cur = sessions.sessionById(req.params.id);
      if (cur && cur.harness === "opencode") sessions.prewarmSessionConfig(cur.id).catch(() => {});
    } catch {}
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/sessions/:id/touch", (req, res) => {
  const s = sessions.touchSession(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown session" });
  res.json(s);
});

app.patch("/api/sessions/:id", async (req, res) => {
  const { title } = (req.body || {});
  try {
    const s = sessions.renameSession(req.params.id, title);
    // Write-through so the backend copy converges; otherwise the next
    // title sync would revert the user's rename to the stale backend copy.
    try { await sessions.pushTitleToHarness(req.params.id); } catch {}
    res.json(s);
  } catch (e) {
    const msg = String(e.message || e);
    const code = /unknown session/.test(msg) ? 404 : 400;
    res.status(code).json({ error: msg });
  }
});

app.delete("/api/sessions/:id", (req, res) => {
  sessions.killSession(req.params.id);
  res.json({ ok: true });
});

// ---- consoles (bottom panel) ----
app.post("/api/consoles", (req, res) => {
  const { workspaceId } = req.body || {};
  if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
  try {
    res.json(sessions.createConsole(workspaceId));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/consoles", (_req, res) => {
  res.json(sessions.listConsoles());
});

app.delete("/api/consoles/:id", (req, res) => {
  sessions.killConsole(req.params.id);
  res.json({ ok: true });
});

// ---- terminal streams (SSE + POST; tunnel-compatible) ----
function ptyKey(kind, id) {
  if (kind !== "session" && kind !== "console") return null;
  return `${kind}:${id}`;
}

app.get("/api/pty/:kind/:id/stream", (req, res) => {
  const key = ptyKey(req.params.kind, req.params.id);
  if (!key) return res.status(400).end("bad kind");
  const entry = pty.get(key);
  if (!entry) return res.status(404).end("no such terminal (ensure the session first)");
  const fresh = !entry.exited;
  pty.attachSse(key, res);
  if (!fresh) res.end();
});

app.post("/api/pty/:kind/:id/input", (req, res) => {
  const key = ptyKey(req.params.kind, req.params.id);
  if (!key) return res.status(400).json({ error: "bad kind" });
  const data = req.body && req.body.data;
  if (typeof data !== "string") return res.status(400).json({ error: "data required" });
  if (!pty.write(key, data)) return res.status(410).json({ error: "terminal exited" });
  res.json({ ok: true });
});

app.post("/api/pty/:kind/:id/resize", (req, res) => {
  const key = ptyKey(req.params.kind, req.params.id);
  if (!key) return res.status(400).json({ error: "bad kind" });
  const { cols, rows } = req.body || {};
  res.json({ ok: pty.resize(key, cols, rows) });
});

// ---- harness reverse proxy (explicit prefixes) ----
// NOTE: explicitMiddleware is mounted at the top (before express.json),
// so this line is intentionally absent here. See above.

// ---- static manager UI ----
// Own assets (app.js/app.css) are version-pinned immutable (?v=VERSION,
// injected into index.html below): repeat loads over the tunnel cost zero
// requests for them, like the backend bundle. index.html itself stays
// uncached — it is the version anchor. Unversioned asset URLs fall through
// to plain static (freshness first: safe across deploys).
const PUBLIC = path.join(__dirname, "..", "public");
app.get(["/app.js", "/app.css"], (req, res, next) => {
  if (req.query.v !== VERSION) return next();
  res.sendFile(path.join(PUBLIC, path.basename(req.path)), { maxAge: "1y", immutable: true });
});
// The shell is the version anchor: always fresh (explicit no-cache —
// res.send sets none and heuristic caching would pin stale ?v= URLs).
app.get(["/", "/index.html"], (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(managerIndexHtml());
});
app.use(express.static(PUBLIC, { index: "index.html" }));

// Manager shell with the running VERSION stamped into asset URLs.
let _indexCache = null; // { mtime, html } — re-read when the file changes
function managerIndexHtml() {
  const file = path.join(PUBLIC, "index.html");
  const mtime = fs.statSync(file).mtimeMs;
  if (!_indexCache || _indexCache.mtime !== mtime) {
    _indexCache = {
      mtime,
      html: fs.readFileSync(file, "utf8").split("__AI_MGR_VERSION__").join(VERSION),
    };
  }
  return _indexCache.html;
}

// Unknown /api/* → JSON 404 (must sit before the asset fallback, else a
// mistyped API path would return the SPA or get proxied to a harness).
// Note: with an active web session, non-manager /api/* was already proxied
// to that backend by the pre-json middleware above; this 404 only fires
// with no active backend.
app.use("/api/", (_req, res) => {
  res.status(404).json({ error: "unknown api route" });
});

// ---- fallback: active-session asset proxy, else SPA ----
app.use(proxy.fallbackMiddleware);
app.get("*", (req, res, next) => {
  if (req.method !== "GET") return next();
  res.set("Cache-Control", "no-cache").type("html").send(managerIndexHtml());
});

// ---- server + upgrade ----
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  // Our own streams are SSE (no upgrade). Anything upgradeable belongs to a
  // web harness backend — forward it.
  proxy.handleUpgrade(req, socket, head, server);
});

server.listen(PORT, HOST, async () => {
  console.log(`[ai-manager] v${VERSION} UI at http://${HOST}:${PORT}`);
  console.log(`[ai-manager] store: ${store.filePath()}`);
  // Best-effort resume of persisted sessions.
  try {
    await sessions.restoreAll();
    console.log(`[ai-manager] restored ${store.getSessions().length} session(s)`);
  } catch (e) {
    console.error("[ai-manager] restore failed:", e.message);
  }
});

function shutdown() {
  console.log("[ai-manager] shutting down (web backends stay alive for adoption)");
  try { sessions.shutdownAll(); } catch {}
  // No graceful-wait window: web backends are intentionally left running and
  // adopted on next boot; only pty sessions die here (synchronous kills).
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
