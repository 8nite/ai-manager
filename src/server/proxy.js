// proxy.js — reverse proxy from the manager to web harness backends.
//
//   /harness/:id/*  → http://127.0.0.1:<port>/*   (explicit per-session)
//   /s/:id/*        → same, + sets aimgr_active cookie (focus mode for remote)
//   other paths     → if aimgr_active cookie points at a running web session
//                    AND no local route/static file matched, fall through to
//                    that backend (lets the backend's root-absolute asset URLs
//                    like /assets/*.js resolve through the single tunnel port).
//
// v0.1 limit: only the *active* web session's absolute assets resolve
// remotely. Concurrent multi-session web UIs over remote are best-effort.

const http = require("http");
const net = require("net");
const { sessionById } = require("./sessions");

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function targetForSession(sess) {
  if (!sess || sess.mode !== "web" || !sess.port) return null;
  if (sess.status !== "running") return null;
  return { host: "127.0.0.1", port: sess.port };
}

// Resolve (session, subPath, setCookie) from a request URL.
function resolveFromUrl(url) {
  const m = /^(\/harness\/|\/s\/)([^/]+)(\/.*)?$/.exec(url.split("?")[0]);
  if (!m) return null;
  const sess = sessionById(m[2]);
  if (!sess) return { error: 404, message: "unknown session" };
  const t = targetForSession(sess);
  if (!t) return { error: 502, message: `harness backend not running (status=${sess.status || "?"})` };
  return { sess, target: t, subPath: m[3] || "/", focus: m[1] === "/s/" };
}

function sanitizeHeaders(inHeaders, target) {
  const out = {};
  for (const k of Object.keys(inHeaders)) {
    const lk = k.toLowerCase();
    if (["host", "connection", "transfer-encoding", "upgrade", "proxy-connection", "keep-alive", "te", "trailers", "content-length"].includes(lk)) continue;
    out[k] = inHeaders[k];
  }
  out["host"] = `${target.host}:${target.port}`;
  out["x-forwarded-proto"] = "http";
  out["x-forwarded-host"] = inHeaders["host"] || "";
  out["x-forwarded-for"] = inHeaders["x-forwarded-for"] || "";
  return out;
}

function proxyRequest(req, res, target, subPath) {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const headers = sanitizeHeaders(req.headers, target);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (body.length) headers["content-length"] = String(body.length);
    const opts = {
      hostname: target.host,
      port: target.port,
      method: req.method,
      path: subPath + qs,
      headers,
      timeout: 0,
    };
    const up = http.request(opts, (upRes) => {
      const outH = { ...upRes.headers };
      // Never let the backend set our session cookie.
      delete outH["set-cookie"];
      res.writeHead(upRes.statusCode, outH);
      upRes.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("harness backend unreachable: " + e.message);
    });
    up.on("timeout", () => { try { up.destroy(); } catch {} });
    if (body.length) up.write(body);
    up.end();
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("client request error");
  });
}

// Express middleware for /harness/* and /s/* (mounted at root; checks prefix).
function explicitMiddleware(req, res, next) {
  const r = resolveFromUrl(req.url);
  if (!r) return next();
  if (r.error) {
    res.writeHead(r.error, { "Content-Type": "text/plain" });
    return res.end(r.message);
  }
  if (r.focus) {
    res.setHeader("Set-Cookie", `aimgr_active=${r.sess.id}; Path=/; SameSite=Lax`);
  }
  proxyRequest(req, res, r.target, r.subPath);
}

// Fallback after static: route misses to the active session's backend.
function fallbackMiddleware(req, res, next) {
  if (req.method !== "GET") return next();
  if (req.url.startsWith("/api/") || req.url === "/health") return next();
  const cookies = parseCookies(req);
  if (!cookies.aimgr_active) return next();
  const sess = sessionById(cookies.aimgr_active);
  const t = targetForSession(sess);
  if (!t) return next();
  const subPath = req.url.split("?")[0] || "/";
  proxyRequest(req, res, t, subPath);
}

// Raw-socket forward for Upgrade requests (backend web UIs that use WS).
function handleUpgrade(req, socket, head, server) {
  const r = resolveFromUrl(req.url);
  const done = (sess, subPath) => {
    const t = sess ? targetForSession(sess) : null;
    if (!t) { try { socket.destroy(); } catch {} return; }
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const lines = [`${req.method} ${subPath + qs} HTTP/1.1`];
    const headers = sanitizeHeaders(req.headers, t);
    delete headers["content-length"];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    lines.push("", "");
    const up = net.createConnection({ host: t.host, port: t.port }, () => {
      up.write(lines.join("\r\n"));
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => { try { socket.destroy(); } catch {} });
    socket.on("error", () => { try { up.destroy(); } catch {} });
  };
  if (r && !r.error) return done(r.sess, r.subPath);
  if (!r) {
    // Cookie-based fallback for upgrades (same rule as HTTP fallback).
    const cookies = parseCookies(req);
    const sess = cookies.aimgr_active ? sessionById(cookies.aimgr_active) : null;
    if (sess && targetForSession(sess)) return done(sess, req.url.split("?")[0]);
  }
  try { socket.destroy(); } catch {}
}

module.exports = { explicitMiddleware, fallbackMiddleware, handleUpgrade, parseCookies, proxyRequest, resolveFromUrl, targetForSession };
