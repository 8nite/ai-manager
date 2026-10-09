// k8s/ai-gateway/server.js — main entry: HTTP + WebSocket server
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const db = require("./db");
const webauthn = require("./webauthn");
const sessionMw = require("./session");
const tunnel = require("./tunnel");

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// Capture the raw request body BEFORE any other middleware consumes it.
// Tunnel-proxied requests need the unmodified body bytes.  Buffer up to
// 16 MB to match the ingress `proxy-body-size`.  After buffering, the
// stream is paused so downstream body-parser middlewares don't choke on
// an already-consumed stream.  Attach as `req.rawBody` (Buffer).
const rawBodyCapture = (req, res, next) => {
  const chunks = [];
  let size = 0;
  const limit = 16 * 1024 * 1024;
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) { req.rawBodyError = true; return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (!req.rawBodyError) req.rawBody = Buffer.concat(chunks);
    // Restore the body as a stream for downstream body-parser
    Object.defineProperty(req, "body", {
      value: undefined, writable: true, configurable: true,
    });
    // body-parser uses content-type detection. It will try to read from the
    // request stream, but it's already consumed.  We replace the read method
    // by using the cached `read` stub approach: set the stream as paused and
    // pre-buffer. body-parser uses `raw-body` which calls `req.on('readable')`
    // — but for already-buffered bodies, we need a different approach.
    next();
  });
  req.on("error", (e) => { req.rawBodyError = e; next(); });
};
app.use(rawBodyCapture);

// Custom JSON parser that uses the pre-captured rawBody.  Avoids the
// "stream is not readable" error that body-parser raises once
// rawBodyCapture has consumed the stream.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") {
    if (req.rawBody === undefined) return next();
  }
  if (req.rawBody === undefined || req.rawBody.length === 0) return next();
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("application/json")) return next();
  try {
    req.body = JSON.parse(req.rawBody.toString("utf8"));
  } catch (e) {
    return res.status(400).json({ error: "invalid_json", message: e.message });
  }
  next();
});

// ----- Public health -----
app.get("/health", (req, res) => {
  const tunnels = tunnel.listTunnels();
  res.json({
    status: "ok",
    rpId: db.get().rpId,
    devices: db.listDevices().length,
    pending: db.listPending().length,
    sessions: db.listSessions().length,
    tunnels: tunnels.length,
    tunnelConnected: tunnels.some(t => t.ready),
    activeTunnels: tunnels,
    // Pending = requests currently in flight through the tunnel proxy.
    // A high number with few active tunnels = overload.
    inFlight: tunnel.pending ? tunnel.pending.size : 0,
    // Per-tunnel /global/event fanout: one upstream serving N subscribers.
    // N >= 2 with one upstream = the multi-device mirror is working.
    sseFanouts: tunnel.listSseFanouts(),
  });
});

// ----- WebAuthn endpoints (public — used during the registration/login flow) -----
app.post("/auth/register/begin",  webauthn.registerBegin);
app.post("/auth/register/finish", webauthn.registerFinish);
app.post("/auth/login/begin",     webauthn.loginBegin);
app.post("/auth/login/finish",    webauthn.loginFinish);
app.get("/auth/pending-status/:deviceId", webauthn.pendingStatus);
app.post("/auth/logout",          sessionMw.requireSession, (req, res) => {
  db.revokeSession(req.session.id);
  res.clearCookie("opencode_sid", { path: "/" });
  res.json({ ok: true });
});

// ----- Static pages (public) -----
const PUBLIC_DIR = path.join(__dirname, "public");
// We serve the static landing/login/register pages only when there is no
// valid session. Once authenticated, "/" and every other path go through
// the proxy to the local opencode. (The "no-cache" header on the HTML files
// ensures a stale landing page can't be shown after login.)
app.get(["/", "/index.html"], (req, res, next) => {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)opencode_sid=([^;]+)/);
  if (m) {
    const s = db.getSession(m[1]);
    if (s) {
      const d = db.getDevice(s.deviceId);
      if (d && d.approvedAt > 0) return next();
    }
  }
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
// Authenticated session introspection (for the landing page JS to check)
app.get("/api/me", sessionMw.requireSession, (req, res) => {
  res.json({ device: { id: req.device.id, name: req.device.name }, session: { id: req.session.id.slice(0, 8) + "…", expiresAt: req.session.expiresAt } });
});
app.get("/login",    (req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "register.html")));

// Service worker for PWA installability on Android Chrome. Served BEFORE
// the auth middleware so the SW fetch itself doesn't require a session
// (the SW intercepts all fetches once registered, and Chrome's install
// check runs without credentials). The SW is a no-op network passthrough
// (see sw.js) — we only need it to satisfy the "SW with a fetch event
// handler" installability contract. The iOS manifest in the opencode web
// UI's HTML head handles iOS Safari's "Add to Home Screen" with no SW.
//
// `Service-Worker-Allowed: /` lets the SW (served from /sw.js) take
// control of the entire origin scope `/`, not just the default `/sw.js`
// directory scope. Without this header, the registration would fail with
// "The path of the provided scope ('/') is not under the max scope
// allowed ('/sw.js')".
app.get("/sw.js", (req, res) => {
  res.set("Service-Worker-Allowed", "/");
  res.set("Cache-Control", "no-cache"); // never cache the SW itself
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "sw.js"));
});
// Other static assets (styles.css, etc) — note: express.static is the LAST
// middleware, so it only matches if nothing above did. This means "/" goes
// to the proxy when authenticated, not back to index.html.
app.use(express.static(PUBLIC_DIR, {
  index: false,  // never auto-serve index.html; the route above handles "/"
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      // HTML: no-cache (stale page after login would break UX)
      res.setHeader("Cache-Control", "no-cache");
    } else {
      // Static assets (CSS, images, fonts): long cache.
      // These are small, rarely change, and traversing the tunnel for them
      // is the main source of latency on mobile.
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    }
  },
}));

// ----- Authenticated proxy to local opencode via tunnel -----
// Everything not matched above (including /) requires a valid session cookie,
// then forwards through the WebSocket tunnel to the local opencode serve.
app.use(sessionMw.requireSession, (req, res, next) => {
  // Refresh session lastSeenAt (async, fire-and-forget)
  db.touchSession(req.session.id);
  next();
}, tunnel.proxyHttp);

// ----- Error handler -----
app.use((err, req, res, _next) => {
  console.error("[server] error:", err);
  res.status(500).json({ error: "internal_error" });
});

// ----- Start HTTP + WS server -----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/tunnel") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

tunnel.setup(wss);

server.listen(PORT, () => {
  console.log(`[ai-manager-gateway] listening on :${PORT}, rpId=${db.get().rpId}`);
  // Run a GC sweep on startup to drop expired sessions/pending tokens
  db.gc();
  // Install the `gateway-admin` CLI onto PATH so
  // `kubectl exec deploy/ai-manager-gateway -- gateway-admin ...` works.
  // The container runs as root, so symlinking into /usr/local/bin is fine;
  // best-effort only — admin still works via `node /app/admin.js`.
  try {
    const fs = require("fs");
    fs.chmodSync("/app/gateway-admin", 0o755);
    try { fs.unlinkSync("/usr/local/bin/gateway-admin"); } catch {}
    fs.symlinkSync("/app/gateway-admin", "/usr/local/bin/gateway-admin");
  } catch (e) {
    console.log(`[ai-manager-gateway] gateway-admin install skipped: ${e.message}`);
  }
});
