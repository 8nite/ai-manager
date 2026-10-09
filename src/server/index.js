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
const VERSION = require("../../package.json").version;

const app = express();
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
app.get("/api/state", (_req, res) => {
  res.json({
    workspaces: store.getWorkspaces(),
    sessions: store.getSessions(),
    consoles: sessions.listConsoles(),
    harnesses: harnessNames(),
  });
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
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(store.getSessions());
});

app.post("/api/sessions/:id/ensure", async (req, res) => {
  try {
    const s = await sessions.ensureSession(req.params.id);
    res.json(s);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/sessions/:id/touch", (req, res) => {
  const s = sessions.touchSession(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown session" });
  res.json(s);
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
app.use(proxy.explicitMiddleware);

// ---- static manager UI ----
const PUBLIC = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC, { index: "index.html" }));

// Unknown /api/* → JSON 404 (must sit before the asset fallback, else a
// mistyped API path would return the SPA or get proxied to a harness).
app.use("/api/", (_req, res) => {
  res.status(404).json({ error: "unknown api route" });
});

// ---- fallback: active-session asset proxy, else SPA ----
app.use(proxy.fallbackMiddleware);
app.get("*", (req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(PUBLIC, "index.html"));
});

// ---- server + upgrade ----
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  // Our own streams are SSE (no upgrade). Anything upgradeable belongs to a
  // web harness backend — forward it.
  proxy.handleUpgrade(req, socket, head, server);
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[ai-manager] v${VERSION} UI at http://127.0.0.1:${PORT}`);
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
  console.log("[ai-manager] shutting down");
  try { sessions.shutdownAll(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
