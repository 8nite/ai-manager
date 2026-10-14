#!/usr/bin/env node
// scripts/ai-tunnel.js — local WebSocket tunnel client
//
// Connects outbound to wss://ai-manager.nexvision.cc/tunnel?token=... and proxies
// every received HTTP request to the local opencode serve (default 127.0.0.1:3000).
// Reconnects with exponential backoff if the connection drops.
//
// Usage:
//   TUNNEL_TOKEN=xxx node scripts/opencode-tunnel.js
//   # or
//   node scripts/ai-tunnel.js --token xxx --url wss://... --port 4000
//
// Env:
//   TUNNEL_TOKEN  (required) — the token from `gateway-admin tunnel-token create`
//   TUNNEL_URL    (optional, default wss://ai-manager.nexvision.cc/tunnel)
//   LOCAL_HOST    (optional, default 127.0.0.1)
//   LOCAL_PORT    (optional, default 4000 — the ai-manager web UI)

const http = require("http");
const WebSocket = require("ws");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const TOKEN  = process.env.TUNNEL_TOKEN || arg("--token");
const URL    = process.env.TUNNEL_URL   || arg("--url",   "wss://ai-manager.nexvision.cc/tunnel");
const HOST   = process.env.LOCAL_HOST   || arg("--host",  "127.0.0.1");
const PORT   = parseInt(process.env.LOCAL_PORT || arg("--port", "4000"), 10);

if (!TOKEN) { console.error("error: TUNNEL_TOKEN (or --token) required"); process.exit(1); }

let ws = null;
let backoff = 1000;
let stopping = false;
const inflight = new Map();  // id → {req, timer}

// Stall watchdog state (see shouldRecycleTunnel below). Updated on every
// inbound frame; the interval in the boot section recycles a half-open socket
// (e.g. 3MB Send-Q stuck home→k8s with no close event) instead of hanging
// in-flight requests until the gateway's 5min timeout.
let lastInboundAt = Date.now();
let stallSince = 0; // first-seen timestamp of bufferedAmount over the limit, else 0
const SEND_STALL_LIMIT = 1 * 1024 * 1024; // 1MB unsent
const SEND_STALL_MS = 30_000;             // sustained this long → recycle
const SILENT_RECYCLE_MS = 90_000;         // no inbound frame this long → recycle

// Pure decision for the watchdog above. Returns a reason string when the
// tunnel should be recycled, else null. Exported for tests.
//   bufferedAmount: ws.bufferedAmount (bytes the kernel hasn't ACKed)
//   stalledMs: how long bufferedAmount has been over SEND_STALL_LIMIT
//   silentMs: how long since the last inbound frame
function shouldRecycleTunnel({ bufferedAmount, stalledMs, silentMs }) {
  if (bufferedAmount > SEND_STALL_LIMIT && stalledMs > SEND_STALL_MS) {
    return `send stalled (${Math.round(bufferedAmount / 1024)}KB unsent for ${Math.round(stalledMs / 1000)}s)`;
  }
  if (silentMs > SILENT_RECYCLE_MS) {
    return `silent for ${Math.round(silentMs / 1000)}s (half-open suspected)`;
  }
  return null;
}

function log(...a) { console.log("[" + new Date().toISOString().slice(11,19) + "]", ...a); }

function connect() {
  if (stopping) return;
  const fullUrl = URL + (URL.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  log("connecting to", fullUrl, "→ local", HOST + ":" + PORT);
  ws = new WebSocket(fullUrl, { handshakeTimeout: 15000 });

  ws.on("open", () => { backoff = 1000; lastInboundAt = Date.now(); stallSince = 0; log("tunnel UP"); });
  ws.on("close", (code, reason) => {
    // When the server rejects a duplicate connection (4003), back off harder
    // instead of joining the reconnect ping‑pong.
    if (code === 4003) backoff = Math.max(backoff, 5000);
    const jitter = Math.floor(Math.random() * 500); // 0–500ms jitter to break tight race loops
    const delay = backoff + jitter;
    log("tunnel DOWN (code=" + code + " reason=" + (reason || "") + "), retry in " + Math.round(delay/1000) + "s");
    ws = null;
    for (const [, c] of inflight) { try { c.req.destroy(); } catch {} }
    inflight.clear();
    if (!stopping) setTimeout(connect, delay), backoff = Math.min(backoff * 1.7, 30_000);
  });
  ws.on("error", (e) => log("tunnel error:", e.message));
  ws.on("message", (raw) => {
    lastInboundAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", id: msg.id })); } catch {}
      return;
    }
    if (msg.type === "hello") {
      log("tunnel hello received (id=" + msg.id + ")");
      return;
    }
    if (msg.type === "request")      return handleRequest(msg);
    if (msg.type === "request-data") return onRequestData(msg);
    if (msg.type === "request-end")  return onRequestEnd(msg);
  });
}

// Buffer per request: { method, path, headers, body: Buffer[] }
const pending = new Map();  // id → pending req info

function handleRequest(msg) {
  pending.set(msg.id, { method: msg.method, path: msg.path, headers: msg.headers || {}, body: [] });
}
function onRequestData(msg) {
  const p = pending.get(msg.id);
  if (p) p.body.push(Buffer.from(msg.data || "", "base64"));
}
function onRequestEnd(msg) {
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (!p) return;
  forwardToLocal(msg.id, p);
}

function sendFrame(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { log("send failed:", e.message); }
}

// Paths whose responses are long-lived SSE streams and must not be killed
// by the 60s safety-net timer below. The browser's EventSource reconnects
// on real end-of-stream, so the right lifetime for these is "as long as
// the local backend keeps it open" — not 60 seconds.
function isLongLivedSsePath(p) {
  if (!p) return false;
  // Strip query string for the path check.
  const path = (p.path || "").split("?")[0];
  // /global/event: opencode/dsh live events (via manager proxy).
  // /api/pty/*: ai-manager terminal SSE streams (must never be cut).
  // (Regular /harness/ + /s/ traffic keeps the 60s safety timeout; their
  // SSE responses are caught by the dynamic text/event-stream detection.)
  return path === "/global/event" || path.endsWith("/event") || path.endsWith("/stream") ||
    path.includes("/api/pty/");
}

function forwardToLocal(id, p) {
  // We have the full body buffered. Make the local request.
  const body = Buffer.concat(p.body);
  // Rewrite the Host header so the local server binds the right virtual host.
  const headers = { ...p.headers, host: HOST + ":" + PORT };
  // Some clients send Transfer-Encoding: chunked; we set Content-Length instead
  // because http.request handles Content-Length and chunks fine.
  if (body.length) headers["content-length"] = String(body.length);
  delete headers["transfer-encoding"];

  const opts = {
    hostname: HOST,
    port: PORT,
    method: p.method,
    path: p.path,
    headers,
    // Node.js v22 defaults http.Agent.options.timeout to 5000ms, which kills
    // SSE streams (/global/event) after 5s. The 60_000 setTimeout below is
    // the real safety net; disable the socket timeout here.
    timeout: 0,
  };
  // Safety-net timeout: 60s for normal requests. For long-lived SSE paths
  // (e.g. /global/event) we skip the timer entirely — the stream's natural
  // lifetime is "until the local backend closes it", and the previous code
  // was tearing down /global/event every 60s, which froze the browser UI
  // mid-AI-response and made the EventSource reconnect every minute. SSE
  // is also detected dynamically when the response Content-Type is
  // text/event-stream (for streaming paths we didn't pre-list), in which
  // case the timer is cleared inside the response callback below.
  let timer = null;
  if (!isLongLivedSsePath(p)) {
    timer = setTimeout(() => {
      const inf = inflight.get(id);
      if (inf) { try { inf.req.destroy(); } catch {} inflight.delete(id); }
      sendResponse(id, 504, { "content-type": "text/plain" }, Buffer.from("local request timeout"));
    }, 60_000);
  }

  const req = http.request(opts, (res) => {
    // Track whether we've already sent the response frame. If the stream
    // errors mid-flight (common for SSE /global/event when the browser
    // disconnects), we still need to send *something* — the gateway's
    // proxyHttp is waiting for a response frame before it can writeHead
    // to the browser. Without it, the browser sees a truncated body.
    let headersSent = false;
    sendFrame({ type: "response", id, status: res.statusCode, headers: res.headers });
    headersSent = true;
    // Dynamic SSE detection: if the backend reports text/event-stream on
    // a path we didn't pre-classify, clear the safety-net timer so the
    // stream can run as long as the backend keeps it open.
    const ct = (res.headers["content-type"] || "").toLowerCase();
    if (timer && ct.includes("text/event-stream")) {
      clearTimeout(timer);
      timer = null;
    }
    res.on("data", (chunk) => sendResponseData(id, chunk));
    res.on("end", () => { sendResponseEnd(id); cleanup(); });
    res.on("error", (e) => {
      log("local response error:", e.message, `path=${p.path} method=${p.method}`);
      if (!headersSent) {
        // Headers never reached us (extremely rare; e.g. backend crashed
        // before writing any). Send a 502 so the gateway can finish the
        // upstream request cleanly.
        sendResponse(id, 502, { "content-type": "text/plain" }, Buffer.from("local response aborted before headers: " + e.message));
      } else {
        // Headers already sent — we were mid-stream. Just end the stream.
        // The browser will see a truncated SSE/response body, which is the
        // best we can do when the local backend aborts a long-lived stream.
        sendResponseEnd(id);
      }
      cleanup();
    });
  });
  function cleanup() { if (timer) { clearTimeout(timer); timer = null; } inflight.delete(id); }
  inflight.set(id, { req, timer });
  req.on("error", (e) => {
    const errorMsg = `local backend error: ${e.message}`;
    log(errorMsg, `path=${p.path} method=${p.method}`);
    sendResponse(id, 502, { "content-type": "text/plain" }, Buffer.from(errorMsg));
    clearTimeout(timer);
    inflight.delete(id);
  });
  req.on("timeout", () => {
    log("local request timeout", `path=${p.path} method=${p.method}`);
    sendResponse(id, 504, { "content-type": "text/plain" }, Buffer.from("local request timeout"));
    clearTimeout(timer);
    inflight.delete(id);
  });
  if (body.length) req.write(body);
  req.end();
}

function sendResponse(id, status, headers, body) {
  sendFrame({ type: "response", id, status, headers: headers || {} });
  if (body) sendResponseData(id, body);
  sendResponseEnd(id);
}
function sendResponseData(id, chunk) { sendFrame({ type: "response-data", id, data: chunk.toString("base64") }); }
function sendResponseEnd(id)         { sendFrame({ type: "response-end", id }); }

// Health check for backend connectivity
let backendHealthy = false;
let lastBackendCheck = 0;
const BACKEND_CHECK_INTERVAL = 30_000; // Check every 30 seconds

// Dedicated agent for health checks to avoid interaction with forwarded
// request connections that use timeout:0 (Node.js v22 defaults agent
// timeout to 5000ms; mixing timeout:0 and timeout:5000 requests through
// the same global agent can cause sockets to get stuck).
const healthAgent = new http.Agent({ keepAlive: false, timeout: 5000 });

function checkBackendHealth() {
  const now = Date.now();
  if (now - lastBackendCheck < BACKEND_CHECK_INTERVAL) return;
  lastBackendCheck = now;

  const req = http.request({
    hostname: HOST,
    port: PORT,
    method: "GET",
    path: "/health",
    agent: healthAgent,
  }, (res) => {
    backendHealthy = res.statusCode === 200;
    if (!backendHealthy) log(`backend health check failed: status=${res.statusCode}`);
    res.resume();
  });

  req.on("error", (e) => {
    backendHealthy = false;
    log(`backend health check error: ${e.message}`);
  });

  req.on("timeout", () => {
    backendHealthy = false;
    log("backend health check timeout");
    req.destroy();
  });

  req.setTimeout(5000);
  req.end();
}

// Watchdog: recycle a half-open tunnel socket. A stalled TCP (uplink
// congestion, dead NAT mapping) emits no close/error, so without this the
// client would queue responses behind megabytes of unsent bytes until the
// gateway's 5min timeout — while browsers abort at the opencode frontend's
// 60s headers timeout ("Transport: Timed out waiting for the server").
// Terminating triggers the existing close handler, which reconnects with
// backoff; the gateway fail-fast 502s the stale in-flight and ingress
// retries them against the fresh socket.
function checkTunnelStall() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { stallSince = 0; return; }
  let buffered = 0;
  try { buffered = ws.bufferedAmount || 0; } catch { buffered = 0; }
  const now = Date.now();
  if (buffered > SEND_STALL_LIMIT) {
    if (!stallSince) stallSince = now;
  } else {
    stallSince = 0;
  }
  const reason = shouldRecycleTunnel({
    bufferedAmount: buffered,
    stalledMs: stallSince ? now - stallSince : 0,
    silentMs: now - lastInboundAt,
  });
  if (reason) {
    log(`tunnel stalled, recycling: ${reason}`);
    stallSince = 0;
    try { ws.terminate(); } catch { try { ws.close(); } catch {} }
  }
}

// Boot section: only auto-start when run as the tunnel process, so unit
// tests can require this file for shouldRecycleTunnel without side effects.
if (require.main === module) {
  // Check backend health periodically
  setInterval(checkBackendHealth, BACKEND_CHECK_INTERVAL);
  // Initial check
  checkBackendHealth();
  // Stall watchdog (see above)
  setInterval(checkTunnelStall, 10_000).unref();

  // Graceful shutdown
  process.on("SIGINT",  () => { log("shutting down"); stopping = true; try { ws?.close(); } catch {} process.exit(0); });
  process.on("SIGTERM", () => { log("shutting down"); stopping = true; try { ws?.close(); } catch {} process.exit(0); });

  connect();
}

module.exports = { shouldRecycleTunnel, SEND_STALL_LIMIT, SEND_STALL_MS, SILENT_RECYCLE_MS };
