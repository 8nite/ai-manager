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
const crypto = require("crypto");
const { sessionById } = require("./sessions");

// Manager-owned /api/* remainder paths (req.url as seen inside an /api/
// mount, query string allowed). Anything else under /api/ belongs to the
// active web backend: opencode-type clients call root-absolute /api/*
// (e.g. GET /api/event SSE) and must reach their backend, not a 404.
const MANAGER_API_RE = /^\/(state|paths\/complete|workspaces(\/[^/?]+)?|sessions(\/[^/?]+(\/(ensure|touch))?)?|consoles(\/[^/?]+)?|pty\/(session|console)\/[^/?]+\/(stream|input|resize))$/;
function isManagerApiPath(remainder) {
  const p = String(remainder || "/").split("?")[0] || "/";
  return MANAGER_API_RE.test(p);
}

// Pre-json /api/ middleware (mounted in index.js before express.json):
// unknown manager routes proxy to the active web backend so its
// root-absolute API calls (e.g. GET /api/event SSE) keep working remotely.
// Manager-owned routes and cookie-less requests fall through with next().
function apiBackendMiddleware(req, res, next) {
  if (isManagerApiPath(req.url)) return next();
  const cookies = parseCookies(req);
  const sess = cookies.aimgr_active ? sessionById(cookies.aimgr_active) : null;
  const t = targetForSession(sess);
  if (!t) return next();
  proxyRequest(req, res, t, "/api" + (req.url.split("?")[0] || "/"), {
    harnessToken: (sess && sess.harnessToken) || null,
  });
}

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

// Route shim: SPA backends (opencode web) only boot on backend-native
// pathnames (/, /settings, /connect, /new-session, /server/<k>/session/<id>).
// Under the tunnel they load at /s/:id/ or /harness/:id/, so the client
// router throws "Unrecognised route!". For the session-root document we
// rewrite history before app scripts run; root-absolute API/asset
// URLs are unaffected. The script hash is appended to script-src so the
// backend's CSP still passes (hash is computed per script body because the
// session-deep-link variant embeds the pre-created chat id).
const ROUTE_SHIM_BODY = '/*aimgr-route-shim*/history.replaceState(null,"","/")';
// NB: the CSP hash must cover the EXACT inline text (comment included).
const ROUTE_SHIM_HASH = crypto.createHash("sha256").update(ROUTE_SHIM_BODY).digest("base64");

function shimBodyFor(harnessSessionId) {
  if (!harnessSessionId) return ROUTE_SHIM_BODY;
  const safe = String(harnessSessionId).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return ROUTE_SHIM_BODY;
  return '/*aimgr-route-shim*/(function(){try{var b=btoa(location.origin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");history.replaceState(null,"","/server/"+b+"/session/' + safe + '")}catch(e){history.replaceState(null,"","/")}}())';
}

function shimTagFor(harnessSessionId) {
  return `<script>${shimBodyFor(harnessSessionId)}</script>`;
}

function hashForBody(body) {
  return crypto.createHash("sha256").update(body).digest("base64");
}

function shouldShimRoute(subPath, method) {
  return method === "GET" && (subPath === "/" || subPath === "");
}

function injectRouteShim(html, harnessSessionId) {
  if (html.includes("aimgr-route-shim")) return html; // idempotent
  const tag = shimTagFor(harnessSessionId || null);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// Client-default seeds for the embedded web UI.
//
// Two per-browser defaults, both applied only when ABSENT so an explicit user
// choice is never overridden and the Settings toggles keep working:
//
//   followUpBehavior → "queue": same background as withQueueDefault, but for
//     browser traffic: the composer always sends an explicit `delivery` taken
//     from the per-browser setting (compiled default `steer`), so the proxy
//     rewrite never fires for it. The setting lives in localStorage
//     (`opencode.global.dat:settings.v3`, JSON, schema-decoded with defaults
//     — a partial blob is safe).
//   colorScheme → "dark": opencode reads `opencode-color-scheme`
//     (`system`|light|`dark`, default `system` = follow OS) before app boot
//     (see the theme preload script) and in Settings → General.
//
// Runs before app scripts (injected right after <head>); try/catch degrades
// to status quo (private mode, etc.).
// NB: the CSP hash must cover the EXACT inline text (marker included).
const WEB_DEFAULTS_SEED_BODY = '/*aimgr-web-defaults*/try{var s="opencode.global.dat:settings.v3";if(localStorage.getItem(s)===null){localStorage.setItem(s,JSON.stringify({general:{followUpBehavior:"queue"}}))}var c="opencode-color-scheme";if(localStorage.getItem(c)===null){localStorage.setItem(c,"dark")}}catch(e){}';

function injectWebDefaults(html) {
  if (html.includes("aimgr-web-defaults")) return html; // idempotent
  const tag = `<script>${WEB_DEFAULTS_SEED_BODY}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// Hide the top chrome in manager-embedded views.
//
// Opencode offers no hide-tabs setting (only horizontal|vertical arrangement),
// and the manager already owns all of the titlebar's jobs (session switching
// via sidebar/palette, new sessions via +Session, status in the session bar),
// so the in-iframe bars are redundant chrome. Two hooks, both the app's own
// stable attrs (not hashed class names): the app titlebar
// (`header[data-slot="titlebar-v2"]`) and the session header
// (`div[data-session-title]`, sticky top bar with the session title + actions).
// Inline <style> needs no CSP edit: backends serve `style-src 'self'
// 'unsafe-inline'`.
const NO_TITLEBAR_CSS = '/*aimgr-no-titlebar*/header[data-slot="titlebar-v2"],div[data-session-title]{display:none!important}';

function injectNoTitlebar(html) {
  if (html.includes("aimgr-no-titlebar")) return html; // idempotent
  const tag = `<style>${NO_TITLEBAR_CSS}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// Per-pane API scoping for concurrent split-screen web views.
//
// Single-iframe days routed the backend's root-absolute calls (/api/*,
// /_assets/*, WS) via the aimgr_active cookie. Two live iframes share one
// cookie jar, so pane B's /api/event would land on pane A's backend. The
// fix is client-side: each session-root document carries its manager
// session id as a constant, and a pre-app patch rewrites every same-origin
// fetch/XHR/EventSource/WebSocket URL to the explicit /s/:id/* prefix
// (handled by explicitMiddleware, no cookie needed). Assets are identical
// across same-version backends, so scoping them too is harmless.
// Runs before app scripts (same gate as the route shim); own CSP sha256.
// NB: the XHR.open wrapper MUST re-dispatch with the caller's original
// arity. Forwarding explicit `undefined` for a missing `async` flips the
// request to sync in Chrome, so any later `responseType=` throws
// ("...cannot be changed for synchronous requests...") — this broke file
// uploads (opencode POSTs octet-stream via XHR + responseType=json).
function apiScopeBodyFor(mgrSessionId) {
  const safe = String(mgrSessionId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  return '/*aimgr-api-scope*/(function(){try{var P="/s/' + safe + '";function GP(){try{var d=window.frameElement&&window.frameElement.dataset&&window.frameElement.dataset.sess;if(d&&/^[A-Za-z0-9_-]+$/.test(d))return"/s/"+d}catch(e){}return P}function R(u){try{var cp=GP();var x=new URL(u,location.href);if(x.origin!==location.origin)return null;var p=x.pathname||"/";if(p.indexOf(cp+"/")===0)return null;if(p==="/s"||p.indexOf("/s/")===0)return null;if(p.indexOf("/harness/")===0)return null;x.pathname=cp+p;return x.toString()}catch(e){return null}}function RI(i){if(typeof i==="string")return R(i)||i;try{if(i instanceof Request){var n=R(i.url);if(n)return new Request(n,i)}}catch(e){}return i}var OF=window.fetch;window.fetch=function(i,t){try{i=RI(i)}catch(e){}return OF.call(this,i,t)};var OO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{var n=R(u);if(n)u=n}catch(e){}var l=arguments.length;if(l<=2)return OO.call(this,m,u);if(l===3)return OO.call(this,m,u,arguments[2]);if(l===4)return OO.call(this,m,u,arguments[2],arguments[3]);return OO.call(this,m,u,arguments[2],arguments[3],arguments[4])};if(window.EventSource){var OE=window.EventSource;window.EventSource=function(u,o){try{var n=R(u);if(n)u=n}catch(e){}return new OE(u,o)};window.EventSource.prototype=OE.prototype}if(window.WebSocket){var OW=window.WebSocket;window.WebSocket=function(u,r){try{var cp=GP();var s=String((u&&u.toString)?u.toString():u);try{var x=new URL(s,location.href);if(x.host===location.host&&(x.protocol==="ws:"||x.protocol==="wss:"||x.protocol==="http:"||x.protocol==="https:")){var p=x.pathname||"/";if(p.indexOf(cp+"/")!==0&&p!=="/s"&&p.indexOf("/s/")!==0&&p.indexOf("/harness/")!==0){x.pathname=cp+p;s=x.toString()}}}catch(e){var q=R(s);if(q)s=q}u=s}catch(e){}return r!==undefined?new OW(u,r):new OW(u)};window.WebSocket.prototype=OW.prototype}}catch(e){}}())';
}

function injectApiScope(html, mgrSessionId) {
  const body = apiScopeBodyFor(mgrSessionId);
  if (!body) return html;
  if (html.includes("aimgr-api-scope")) return html; // idempotent
  const tag = `<script>${body}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function shimCspHeaders(outH, body) {
  const want = body || ROUTE_SHIM_BODY;
  const hash = hashForBody(want);
  const csp = outH["content-security-policy"];
  if (typeof csp !== "string" || csp.includes(hash)) return;
  outH["content-security-policy"] = csp.replace(
    /script-src[^;]*/,
    (m) => `${m} 'sha256-${hash}'`
  );
}

function targetForSession(sess) {
  if (!sess || sess.mode !== "web" || !sess.port) return null;
  if (sess.status !== "running") return null;
  return { host: "127.0.0.1", port: sess.port };
}

// Immutable static assets: opencode serves its bundle as content-hashed
// `/_assets/<hash>-<name>.js|css` URLs, so a year-long immutable cache is
// safe and kills ~160 requests per cold switch. This matters most over the
// tunnel (each request pays ~250-800ms WAN RTT): after the first load the
// browser revalidates nothing and a switch costs doc + API only. Never
// applied to API/HTML/SSE — only hashed-asset GETs.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
function isImmutableAsset(subPath, method) {
  if (method !== "GET") return false;
  const p = String(subPath || "").split("?")[0];
  if (!p.startsWith("/_assets/")) return false;
  const base = p.slice("/_assets/".length);
  return base.length > 0 && !base.includes("/") && !base.startsWith(".");
}

function immutableAssetHeaders(outH) {
  outH["cache-control"] = IMMUTABLE_CACHE;
  delete outH["pragma"];
  delete outH["expires"];
}

// Short-TTL cache for workspace config GETs.
//
// The opencode SPA refetches per-workspace config on EVERY session switch
// (measured waterfall: /api/project, /model, /provider, /integration,
// /api/config, /location, /vcs, /shell — ~7 sequential RTTs, each
// ~250-800ms over the tunnel). The data is workspace-scoped (same
// ?location[directory]= answers identically for every session in that
// workspace) and changes rarely, so a 30s server-side cache collapses
// repeat switches to zero round trips for these paths. Per-session state
// (session/message/permission/active/event/…) is NEVER cached.
// ponytail: one Map + global clear on any /api mutation, not per-path
// invalidation rules that nobody will maintain.
const CONFIG_CACHE_TTL_MS = 30000;
const CONFIG_CACHE_MAX = 200;
// Browser-visible counterpart: repeats within TTL cost ZERO requests
// (served from disk cache), which is what actually matters over the tunnel
// — the server cache only saves backend milliseconds. `private` keeps it
// out of any shared gateway cache; single-user browser semantics.
const CONFIG_BROWSER_CACHE = "private, max-age=30";
const CONFIG_CACHEABLE_RE = /^\/api\/(project|model|provider|integration|config|location|vcs|shell)$/;
const _configCache = new Map(); // key -> { status, headers, body, at }
function _clearConfigCacheForTest() {
  _configCache.clear();
}
function configCacheKey(subPath, qs) {
  return `${String(subPath || "").split("?")[0]}${qs || ""}`;
}
function isCacheableApi(method, subPath) {
  if (method !== "GET") return false;
  return CONFIG_CACHEABLE_RE.test(String(subPath || "").split("?")[0] || "");
}
function configCacheGet(key) {
  const e = _configCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CONFIG_CACHE_TTL_MS) {
    _configCache.delete(key);
    return null;
  }
  // LRU refresh (cheap recency without a second structure).
  _configCache.delete(key);
  _configCache.set(key, e);
  return e;
}
function configCacheSet(key, entry) {
  _configCache.delete(key);
  _configCache.set(key, entry);
  while (_configCache.size > CONFIG_CACHE_MAX) {
    _configCache.delete(_configCache.keys().next().value);
  }
}

// dsh backends require ?token= upstream (printed at boot, captured by
// sessions.js). Append when the client didn't supply one; the browser never
// sees the secret — it travels manager→backend on loopback only.
// dsh token query is single-phase: the first request exchanges ?token= for a
// session cookie; REPEATING ?token= once the cookie exists re-triggers the
// handshake (303 loop). So append the token only until the browser presents
// the dsh session cookie. Match that cookie specifically: generic UI cookies
// (aimgr_active, oc_locale, …) must NOT count, or the token is wrongly
// skipped and dsh 401s.
function hasBackendCookie(inHeaders) {
  const raw = inHeaders["cookie"] || inHeaders["Cookie"] || "";
  return String(raw)
    .split(";")
    .some((s) => /^\s*dsh-auth-/i.test(s));
}

function withToken(pathQs, token) {
  if (!token) return pathQs;
  if (/(^|[?&])token=/.test(pathQs)) return pathQs;
  return pathQs + (pathQs.includes("?") ? "&" : "?") + "token=" + token;
}

// Resolve (session, subPath, setCookie) from a request URL.
function resolveFromUrl(url) {
  const m = /^(\/harness\/|\/s\/)([^/]+)(\/.*)?$/.exec(url.split("?")[0]);
  if (!m) return null;
  const sess = sessionById(m[2]);
  if (!sess) return { error: 404, message: "unknown session" };
  const t = targetForSession(sess);
  if (!t) return { error: 502, message: `harness backend not running (status=${sess.status || "?"})` };
  return { sess, target: t, subPath: m[3] || "/", focus: true };
}

function sanitizeHeaders(inHeaders, target, opts) {
  const skipForwarded = !!(opts && opts.skipForwarded);
  const injectAuth = !(opts && opts.skipAuth);
  const out = {};
  for (const k of Object.keys(inHeaders)) {
    const lk = k.toLowerCase();
    if (["host", "connection", "transfer-encoding", "upgrade", "proxy-connection", "keep-alive", "te", "trailers", "content-length", "authorization"].includes(lk)) continue;
    out[k] = inHeaders[k];
  }
  out["host"] = `${target.host}:${target.port}`;
  // dsh validates its auth cookie against the perceived host: forwarded
  // headers make it see the manager origin instead of its own, breaking
  // verification into a 303 loop. opencode needs them (server-key origin).
  if (!skipForwarded) {
    out["x-forwarded-proto"] = "http";
    out["x-forwarded-host"] = inHeaders["host"] || "";
    out["x-forwarded-for"] = inHeaders["x-forwarded-for"] || "";
  }
  // Auto-auth upstream `opencode serve` (v2 mandates Basic auth). The browser
  // never supplies this; the manager holds the secret so new sessions open
  // already connected to this host. Skipped for token-authed backends (dsh):
  // a foreign Authorization header breaks their cookie verification.
  if (injectAuth) {
    try {
      out["authorization"] = require("./opencodeAuth").authHeader();
    } catch {}
  }
  return out;
}

// Strip only the manager's own session cookie from upstream responses;
// backend cookies (e.g. dsh auth handshake) must survive (see above).
function stripAimgrCookie(outH) {
  const sc = outH["set-cookie"];
  if (!sc) return;
  const list = Array.isArray(sc) ? sc : [sc];
  const kept = list.filter((c) => !/^\s*aimgr_active\s*=/i.test(String(c)));
  if (kept.length) outH["set-cookie"] = Array.isArray(sc) ? kept : kept[0];
  else delete outH["set-cookie"];
}

// Opencode follow-up default (queue vs steer).
//
// The web UI sends `delivery:"steer"` unless the user picked Queue
// (Settings → General → Follow-up behavior, per-browser localStorage,
// default steer). A follow-up sent while the session is busy then steers the
// active turn instead of waiting its turn. The manager defaults *unspecified*
// delivery to "queue" so follow-ups wait; an explicit "steer"/"queue" from
// the client (or API callers) is always honored. Fail-open: anything
// unparseable is forwarded untouched.
const PROMPT_DELIVERY_RE = /^\/api\/session\/[^/?]+\/(prompt|command)$/;

function withQueueDefault(method, upstreamPath, body) {
  if (method !== "POST") return body;
  const path = String(upstreamPath || "").split("?")[0];
  if (!PROMPT_DELIVERY_RE.test(path)) return body;
  if (!body || !body.length) return body;
  let msg;
  try {
    msg = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return body;
  if (msg.delivery === undefined || msg.delivery === null || msg.delivery === "") {
    return Buffer.from(JSON.stringify({ ...msg, delivery: "queue" }), "utf8");
  }
  return body;
}

function proxyRequest(req, res, target, subPath, opts) {
  const shim = !!opts?.shimRoute && shouldShimRoute(subPath, req.method);
  const shimSessionId = shim && opts?.shimSessionId ? String(opts.shimSessionId) : null;
  const shimBody = shim ? shimBodyFor(shimSessionId) : null;
  const scopeSessionId = shim && opts?.scopeSessionId ? String(opts.scopeSessionId) : null;
  const scopeBody = shim ? apiScopeBodyFor(scopeSessionId) : null;
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const tok = opts?.harnessToken && !hasBackendCookie(req.headers) ? opts.harnessToken : null;
  const upstreamPath = withToken(subPath + qs, tok);
  // Any /api mutation invalidates the config cache (model installs, config
  // edits, …). Over-broad on purpose: mutations are rare, staleness is not.
  if (req.method !== "GET" && String(subPath || "").split("?")[0].startsWith("/api/")) {
    _configCache.clear();
  }
  // Config-GET fast path: serve a fresh entry with zero upstream I/O.
  const cacheKey = isCacheableApi(req.method, subPath) ? configCacheKey(subPath, qs) : null;
  if (cacheKey && !opts?.harnessToken) {
    const hit = configCacheGet(cacheKey);
    if (hit) {
      const h = { ...hit.headers, "cache-control": CONFIG_BROWSER_CACHE, "x-aimgr-cache": "HIT", "content-length": String(hit.body.length) };
      delete h["transfer-encoding"];
      delete h["pragma"];
      delete h["expires"];
      res.writeHead(hit.status, h);
      res.end(hit.body);
      return;
    }
  }
  // harnessToken is only ever set for dsh sessions (opencode uses Basic auth
  // + harnessSessionId), so its presence selects the dsh header policy above.
  const tokenAuthed = !!opts?.harnessToken;
  const headers = sanitizeHeaders(req.headers, target, { skipForwarded: tokenAuthed, skipAuth: tokenAuthed });
  // Shim path needs string surgery: force identity encoding so the upstream
  // body arrives uncompressed.
  if (shim) delete headers["accept-encoding"];
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    body = withQueueDefault(req.method, upstreamPath, body);
    if (body.length) headers["content-length"] = String(body.length);
    const upOpts = {
      hostname: target.host,
      port: target.port,
      method: req.method,
      path: upstreamPath,
      headers,
      timeout: 0,
    };
    const up = http.request(upOpts, (upRes) => {
      const outH = { ...upRes.headers };
      // Backends must not override our session cookie, but their own cookies
      // (e.g. dsh's login session from its 303 handshake) must pass through —
      // stripping all set-cookie broke dsh into a redirect loop.
      stripAimgrCookie(outH);
      if (!shim) {
        // Hashed bundle assets cache for a year (see isImmutableAsset);
        // config GETs fill the short-TTL cache (buffered: they are KBs);
        // everything else streams through untouched (SSE must never buffer).
        if (upRes.statusCode === 200 && isImmutableAsset(subPath, req.method)) {
          immutableAssetHeaders(outH);
        }
        if (cacheKey && !opts?.harnessToken && upRes.statusCode === 200 && req.method === "GET") {
          const bufs = [];
          upRes.on("data", (c) => bufs.push(c));
          upRes.on("end", () => {
            const buf = Buffer.concat(bufs);
            const ct = String(outH["content-type"] || "");
            if (ct.includes("json") || ct.includes("text")) {
              const stored = { ...outH };
              delete stored["transfer-encoding"];
              delete stored["content-length"];
              configCacheSet(cacheKey, { status: upRes.statusCode, headers: stored, body: buf, at: Date.now() });
            }
            outH["x-aimgr-cache"] = "MISS";
            outH["cache-control"] = CONFIG_BROWSER_CACHE;
            delete outH["pragma"];
            delete outH["expires"];
            res.writeHead(upRes.statusCode, outH);
            res.end(buf);
          });
          return;
        }
        res.writeHead(upRes.statusCode, outH);
        upRes.pipe(res);
        return;
      }
      const bufs = [];
      upRes.on("data", (c) => bufs.push(c));
      upRes.on("end", () => {
        let buf = Buffer.concat(bufs);
        const ct = String(outH["content-type"] || "");
        if (upRes.statusCode === 200 && ct.includes("text/html")) {
          buf = Buffer.from(injectNoTitlebar(injectWebDefaults(injectApiScope(injectRouteShim(buf.toString("utf8"), shimSessionId), scopeSessionId))), "utf8");
          shimCspHeaders(outH, shimBody);
          shimCspHeaders(outH, WEB_DEFAULTS_SEED_BODY);
          if (scopeBody) shimCspHeaders(outH, scopeBody);
          outH["content-length"] = String(buf.length);
          // Upstream typically sends chunked; an explicit length must not
          // coexist with transfer-encoding (strict downstream parsers fail).
          delete outH["transfer-encoding"];
        }
        res.writeHead(upRes.statusCode, outH);
        res.end(buf);
      });
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
  let r = resolveFromUrl(req.url);
  if (!r) return next();
  if (r.error === 404) {
    // Shared-SPA resilience: if the session that originally booted the
    // iframe was later deleted after the pane client-switched to another
    // session, long-lived sub-resources (e.g. a reconnecting /api/event SSE
    // stream) still carry the old /s/<deleted>/* prefix. Fall back to the
    // active session's backend for sub-resources instead of 404ing.
    const m = /^(\/harness\/|\/s\/)([^/]+)(\/.+)$/.exec(req.url.split("?")[0]);
    const sub = m && m[3];
    if (sub && sub !== "/") {
      const cookies = parseCookies(req);
      const activeSess = cookies.aimgr_active ? sessionById(cookies.aimgr_active) : null;
      const t = targetForSession(activeSess);
      if (t) r = { sess: activeSess, target: t, subPath: sub, focus: false };
    }
  }
  if (r.error) {
    res.writeHead(r.error, { "Content-Type": "text/plain" });
    return res.end(r.message);
  }
  if (r.focus) {
    res.setHeader("Set-Cookie", `aimgr_active=${r.sess.id}; Path=/; SameSite=Lax`);
  }
  // dsh reads its access token from the *browser* URL (?token=) on boot; the
  // app shell otherwise renders "authentication required". Redirect the
  // session root once so the token is present for boot. Upstream injection
  // alone is not enough. Later requests ride the dsh cookie (see withToken).
  if (
    req.method === "GET" &&
    (r.subPath === "/" || r.subPath === "") &&
    r.sess.harness === "dsh" &&
    r.sess.harnessToken
  ) {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    if (!/(^|[?&])token=/.test(qs) && !hasBackendCookie(req.headers)) {
      const pathOnly = req.url.split("?")[0];
      res.writeHead(302, { Location: pathOnly + (qs ? "&" : "?") + "token=" + r.sess.harnessToken });
      return res.end();
    }
  }
  proxyRequest(req, res, r.target, r.subPath, {
    shimRoute: true,
    // Deep-link straight into the pre-created chat: the workspace is already
    // chosen in ai-manager, so opencode must not ask for a project again.
    shimSessionId: (r.sess && r.sess.harnessSessionId) || null,
    // Per-pane API scoping (split-screen): embeds the manager session id so
    // concurrent iframes route their /api + WS traffic explicitly.
    scopeSessionId: (r.sess && r.sess.id) || null,
    harnessToken: (r.sess && r.sess.harnessToken) || null,
  });
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
  proxyRequest(req, res, t, subPath, {
    harnessToken: (sess && sess.harnessToken) || null,
  });
}

// Raw-socket forward for Upgrade requests (backend web UIs that use WS).
function handleUpgrade(req, socket, head, server) {
  const r = resolveFromUrl(req.url);
  const done = (sess, subPath) => {
    const t = sess ? targetForSession(sess) : null;
    if (!t) { try { socket.destroy(); } catch {} return; }
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const sessTok = sess && sess.harnessToken && !hasBackendCookie(req.headers) ? sess.harnessToken : null;
    const lines = [`${req.method} ${withToken(subPath + qs, sessTok)} HTTP/1.1`];
    const tokUp = !!(sess && sess.harnessToken);
    const headers = sanitizeHeaders(req.headers, t, { skipForwarded: tokUp, skipAuth: tokUp });
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

module.exports = { explicitMiddleware, fallbackMiddleware, handleUpgrade, parseCookies, proxyRequest, resolveFromUrl, targetForSession, isManagerApiPath, apiBackendMiddleware, shouldShimRoute, injectRouteShim, injectWebDefaults, injectNoTitlebar, injectApiScope, apiScopeBodyFor, shimCspHeaders, shimBodyFor, hashForBody, withToken, hasBackendCookie, stripAimgrCookie, withQueueDefault, isImmutableAsset, immutableAssetHeaders, IMMUTABLE_CACHE, isCacheableApi, configCacheKey, configCacheSet, CONFIG_CACHE_TTL_MS, CONFIG_BROWSER_CACHE, _clearConfigCacheForTest, ROUTE_SHIM_HASH, ROUTE_SHIM_BODY, WEB_DEFAULTS_SEED_BODY, NO_TITLEBAR_CSS };
