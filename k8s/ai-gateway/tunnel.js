// k8s/opencode-auth/tunnel.js — WebSocket tunnel server (multiplexed HTTP-over-WS)
//
// Protocol (JSON frames over a single WebSocket):
//   Server → Client:
//     {type:"request",    id, method, path, headers}     // incoming HTTP from browser
//     {type:"request-data", id, dataB64}                 // request body chunk
//     {type:"request-end", id}                           // body done
//     {type:"ping", id}                                  // keepalive
//   Client → Server:
//     {type:"response",    id, status, headers}          // reply from local backend
//     {type:"response-data", id, dataB64}                // response body chunk
//     {type:"response-end", id}                          // response done
//     {type:"pong", id}
//
// Multi-tunnel: multiple tunnel clients can be connected simultaneously.
// Each device can be bound to a specific tunnel (device.tunnelId). If the
// requesting device has no binding, the first active tunnel is used
// (backward-compatible with the single-tunnel setup). This lets us support
// "multi remote device accessing the same time" — multiple users, each with
// their own local opencode serve, behind one gateway pod.
const crypto = require("crypto");
const zlib = require("zlib");
const db = require("./db");

const tunnels = new Map();  // token → {ws, id, lastSeenAt, lastPingSent, name}
const pending = new Map();  // requestId → {res, device, headersSent, startedAt, tunnelToken}

// Basic credential for the local `opencode serve` behind the tunnel
// (pinned via OPENCODE_SERVER_PASSWORD in opencode-serve.service). Injected
// on tunneled requests that don't already carry an Authorization header, so
// remote browsers never see serve's native user+pass dialog. Absent env =
// no injection (pass-through, backward compatible).
const SERVE_BASIC = process.env.OPENCODE_SERVER_PASSWORD
  ? "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64")
  : null;

// Per-device "force a page refresh on the next HTML response" queue.
// Populated when the SSE subscriber for a device dies (the "resume"
// signal: the browser was backgrounded, the socket went half-dead, the
// 15s heartbeat detected it, etc.). On the next HTML response for that
// device, we inject `Refresh: 0` so the browser reloads with fresh
// state. Single-use: cleared on first injection. TTL'd to 30s so it
// never fires on unrelated future requests.
const deviceRefreshQueue = new Map();  // deviceId → expiresAt (ms epoch)

// Server-side SSE fanout for /global/event.
// The opencode serve is a single-instance backend; every browser client
// wants the same live event stream. Instead of each browser opening its own
// upstream (which causes races, reconnects, and the "device B got cut" symptom),
// the gateway holds ONE persistent upstream per tunnel and fans every event
// out to all currently-subscribed browser clients.
//
// Lifecycle:
//   - Lazy open: first browser subscriber triggers `openUpstream(tunnel)`.
//   - Fanout: response-data frames from the upstream → write to every
//     subscriber's res. Per-subscriber write errors drop just that subscriber.
//   - Drain: response-end from the upstream → end all subscribers, clear
//     upstream. Next subscriber triggers a fresh open.
//   - Last-out: when the last subscriber leaves (close/error), close the
//     upstream so we don't hold an idle connection to the opencode serve.
const sseFanout = new Map(); // tunnelToken → { upstreamId, upstreamStatus, upstreamHeaders, subscribers:Set<{res,device,startedAt,headersSent}> }

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log("[" + ts() + "]", ...a); }

function setup(wss) {
  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) { try { ws.close(4001, "missing token"); } catch {} return; }
    const t = db.getTunnelByToken(token);
    if (!t) { try { ws.close(4002, "invalid token"); } catch {} return; }

    // If a connection is already active for this token, keep the existing one
    // and reject the duplicate.  Duplicate connection events are a known
    // artifact of some proxy stacks (nginx + keepalive).  Closing the *old*
    // socket creates a reconnect ping‑pong; closing the *new* one breaks the
    // cycle.
    const prev = tunnels.get(token);
    if (prev) {
      if (prev.ws === ws) {
        // Same-ws duplicate (edge case) — silently ignore
        return;
      }
      // If the stored connection is still alive AND has seen traffic
      // recently, keep it and reject the newcomer.  Otherwise the stored
      // entry is stale (nginx ingress may have killed the underlying TCP
      // stream without the server noticing) and we accept the new one.
      const staleCutoff = Date.now() - 10_000; // 10s
      if (prev.ws.readyState === 1 /* OPEN */ && prev.lastSeenAt > staleCutoff) {
        // Silently reject duplicate (nginx artifact — would flood logs)
        try { ws.close(4003, "replaced"); } catch {}
        return;
      }
      // Old connection is dead/dying — clean up and accept the new one.
      log(`[tunnel] stale tunnel cleaned up for ${t.name} (${t.id})`);
    }
    tunnels.set(token, { ws, id: t.id, name: t.name, lastSeenAt: Date.now(), lastPingSent: 0 });
    db.markTunnelConnected(t.id);
    log(`[tunnel] connected: ${t.name} (${t.id}) wsReady=${ws.readyState} activeTunnels=${tunnels.size}`);

    // Send hello so client knows auth succeeded
    try { ws.send(JSON.stringify({ type: "hello", id: t.id })); } catch {}

    const pingInterval = setInterval(() => {
      const entry = tunnels.get(token);
      if (!entry || entry.ws !== ws) return;
      // If we haven't seen traffic in 60s, send a ping. If we don't get a pong
      // in 15s, kill the tunnel.
      if (Date.now() - entry.lastSeenAt > 60_000) {
        try { ws.send(JSON.stringify({ type: "ping", id: "k" + Date.now() })); } catch {}
        entry.lastPingSent = Date.now();
        setTimeout(() => {
          if (tunnels.get(token)?.ws === ws && Date.now() - (tunnels.get(token).lastSeenAt) > 75_000) {
            try { ws.close(4004, "no pong"); } catch {}
          }
        }, 15_000).unref();
      }
    }, 30_000);
    pingInterval.unref();

    ws.on("message", (raw) => {
      const entry = tunnels.get(token);
      if (entry) entry.lastSeenAt = Date.now();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "response") {
        const p = pending.get(msg.id);
        if (!p) return;
        // Add cache-busting for HTML responses. The opencode web UI's HTML
        // embeds Vite chunk hashes; a cached stale build is the most common
        // cause of "Failed to fetch dynamically imported module" when the
        // local opencode serve is rebuilt while a browser tab is open.
        const headers = { ...(msg.headers || {}) };
        const ct = (headers["content-type"] || "").toLowerCase();
        if (ct.includes("text/html")) {
          // HTML: never cache. Stale HTML = broken dynamic imports (Vite chunk hashes).
          headers["cache-control"] = "no-store, no-cache, must-revalidate, max-age=0";
          headers["pragma"] = "no-cache";
          headers["expires"] = "0";
          // CSP relaxation: the opencode serve ships a strict CSP that
          // only allows the SHA-256 of its own oc-theme-preload-script
          // (`sha256-jURJv6M3UYb5GqNE3+c1I0SvGlqS1+LmHVWtqFsefBk=`).
          // Our PWA + orphan-cleanup injection (see the `injection`
          // const below) is a DIFFERENT inline script, so CSP would
          // block it by default. Append the hash of our injection so
          // the browser permits it. Keep the opencode-serve's original
          // hash intact so the preload script still works.
          //
          // If the `injection` string below changes, recompute with:
          //   node -e 'const c=require("crypto");const m=require("fs").readFileSync("tunnel.js","utf8").match(/const injection = `<script>(.*?)<\/script>`/s);console.log("sha256-"+c.createHash("sha256").update(m[1],"utf8").digest("base64"))'
          const existing = headers["content-security-policy"];
          if (typeof existing === "string" && existing.includes("script-src")) {
            headers["content-security-policy"] = existing.replace(
              /script-src([^;]*)/,
              (m) => `${m} 'sha256-LPyxuSHlVEsnBzhkaBitxjmbiEzwOsWKKYGQlj+6a7Q='`,
            );
          }
        } else if (
          ct.includes("javascript") || ct.includes("css") ||
          ct.includes("font/") || ct.includes("image/") ||
          p.path.match(/\.(js|css|woff2?|ttf|eot|png|jpe?g|gif|svg|webp|ico)(\?|$)/i)
        ) {
          // Hashed static assets from Vite: safe to cache long-term.
          // These traverse the full tunnel roundtrip on every load — caching
          // them eliminates the single biggest latency source on mobile.
          if (!headers["cache-control"]) {
            headers["cache-control"] = "public, max-age=604800, immutable";
          }
        }
        // Resume-detected page refresh: if this device's SSE just died
        // (see deviceRefreshQueue populated in handleSseSubscribe's
        // res.on("close")), and the response is HTML, inject a
        // `Refresh: 0` header so the browser reloads the page with
        // fresh state. Single-use (cleared below) and TTL'd to 30s.
        if (p.device && ct.includes("text/html")) {
          const expiresAt = deviceRefreshQueue.get(p.device.id);
          if (expiresAt !== undefined) {
            if (Date.now() < expiresAt) {
              headers["refresh"] = "0";
              deviceRefreshQueue.delete(p.device.id);
              logProxy(p, `→ injected Refresh: 0 (resume detected)`);
            } else {
              deviceRefreshQueue.delete(p.device.id); // expired
            }
          }
        }
        // PWA service-worker registration. For HTML responses from the
        // opencode web UI, defer writing the response and instead buffer
        // the body so we can inject a <script> that calls
        // navigator.serviceWorker.register('/sw.js') before </head>.
        // The SW is the only piece missing for Android Chrome PWA
        // installability (the opencode web UI's manifest is already
        // complete). Without this injection, the opencode web UI's HTML
        // never registers a SW and Chrome won't show the install prompt.
        // We strip the upstream content-length because we're about to
        // recompute it after the injection.
        if (!p.fanout && ct.includes("text/html")) {
          p.htmlMode = true;
          p.htmlStatus = msg.status;
          p.htmlHeaders = headers;
          p.htmlBuf = Buffer.alloc(0);
          delete p.htmlHeaders["content-length"];
          return; // Don't write headers yet — wait for response-end
        }
        if (p.fanout) {
          // SSE upstream headers arrived. Capture for late-attaching
          // subscribers, and write headers to everyone already attached.
          p.fanout.upstreamStatus = msg.status;
          p.fanout.upstreamHeaders = headers;
          p.fanout.upstreamHeadersSent = true;
          for (const sub of [...p.fanout.subscribers]) {
            try { sub.res.writeHead(msg.status, headers); sub.headersSent = true; }
            catch (e) { p.fanout.subscribers.delete(sub); }
          }
          p.headersSent = true;
          return;
        }
        try {
          p.res.writeHead(msg.status, headers);
          p.headersSent = true;
        } catch (e) { pending.delete(msg.id); try { p.res.end(); } catch {} }
      } else if (msg.type === "response-data") {
        const p = pending.get(msg.id);
        if (!p) return;
        // HTML responses are buffered (see the response handler above)
        // so we can inject the SW registration script on response-end.
        // Everything else streams straight through.
        if (p.htmlMode) {
          p.htmlBuf = Buffer.concat([p.htmlBuf, Buffer.from(msg.data, "base64")]);
          return;
        }
        if (p.fanout) {
          // SSE chunk: write to every current subscriber. Per-subscriber
          // write errors drop just that subscriber (e.g. browser navigated
          // away); the upstream and remaining subscribers stay alive.
          const buf = Buffer.from(msg.data, "base64");
          p.fanout.bytes += buf.length;
          for (const sub of [...p.fanout.subscribers]) {
            try { sub.res.write(buf); }
            catch (e) { p.fanout.subscribers.delete(sub); }
          }
          return;
        }
        try { p.res.write(Buffer.from(msg.data, "base64")); }
        catch (e) { pending.delete(msg.id); try { p.res.end(); } catch {} }
      } else if (msg.type === "response-end") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (p.htmlMode) {
          // PWA bootstrap injection. We deferred writing the response
          // when we saw `text/html` in the response handler. Now that the
          // full body is buffered, splice the bootstrap script in before
          // </head> (or </body> as a fallback for malformed HTML) and
          // recompute the Content-Length. The script is inline (no extra
          // roundtrip) and handles two things:
          //
          //   1. Service worker registration (Chrome's PWA installability
          //      check requires a registered SW with a fetch handler).
          //
          //   2. beforeinstallprompt handling. Chrome's native install
          //      UI is silent until the user manually hunts the menu, so
          //      we surface a custom "Install OpenCode" banner with an
          //      Install button (calls event.prompt()) and a Dismiss
          //      button (persists in localStorage). The banner is hidden
          //      automatically if the page is already running as an
          //      installed PWA (`display-mode: standalone`) or if the
          //      `appinstalled` event fires (the user installed via the
          //      address-bar icon or another path).
          //
          //   We also expose `window.__pwaInstallEvent` and dispatch a
          //   custom `pwa-installable` event so the opencode web UI's own
          //   code can hook into this (e.g. a settings-page "Install app"
          //   button, or a more sophisticated in-app prompt).
          const injection = `<script>(function(){try{var nk="opencode.global.dat:notification";var nv=JSON.parse(localStorage.getItem(nk)||'{"list":[]}');var orig=nv.list;var cleaned=orig.filter(function(n){return n&&n.session&&n.session!=="global"&&!String(n.session).startsWith("sub_")});if(cleaned.length!==orig.length){localStorage.setItem(nk,JSON.stringify({list:cleaned}));if(!sessionStorage.getItem("__orphan_cleanup_done")){sessionStorage.setItem("__orphan_cleanup_done","1");location.reload();return}}else{sessionStorage.removeItem("__orphan_cleanup_done")}}catch(e){}if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){});if(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)return;var ev=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();ev=e;window.__pwaInstallEvent=e;window.dispatchEvent(new CustomEvent('pwa-installable',{detail:e}));if(localStorage.getItem('pwa-install-dismissed')||document.getElementById('pwa-install-banner'))return;var b=document.createElement('div');b.id='pwa-install-banner';b.style.cssText='position:fixed;bottom:20px;right:20px;background:#1a1a1a;color:#fafafa;padding:12px 16px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);z-index:999999;display:flex;align-items:center;gap:12px;font:14px system-ui;max-width:380px;border:1px solid #333';b.innerHTML='<div style="flex:1"><div style="font-weight:600;margin-bottom:2px">Install OpenCode</div><div style="opacity:0.7;font-size:12px">Add to home screen for fullscreen app</div></div><button id="pwa-install-btn" style="background:#fafafa;color:#080808;border:0;padding:8px 16px;border-radius:6px;font:600 13px system-ui;cursor:pointer">Install</button><button id="pwa-dismiss-btn" style="background:transparent;border:0;color:#fafafa;cursor:pointer;font:18px system-ui;padding:0;width:24px;height:24px;line-height:1">×</button>';document.body.appendChild(b);document.getElementById('pwa-install-btn').onclick=async function(){if(!ev)return;ev.prompt();var r=await ev.userChoice;if(r&&r.outcome==='accepted')b.remove();ev=null};document.getElementById('pwa-dismiss-btn').onclick=function(){b.remove();localStorage.setItem('pwa-install-dismissed','1')}});window.addEventListener('appinstalled',function(){localStorage.removeItem('pwa-install-dismissed');var b=document.getElementById('pwa-install-banner');if(b)b.remove()})})()</script>`;
          let html;
          const enc = String(p.htmlHeaders["content-encoding"] || "").toLowerCase();
          if (enc.includes("br") || enc.includes("gzip") || enc.includes("deflate")) {
            // The local backend compressed the HTML (every real browser sends
            // Accept-Encoding). The buffered bytes are NOT utf8 text — running
            // toString() on them corrupts the body and the browser renders
            // garbage. Decompress first, inject, send identity.
            // ponytail: sync zlib on ~6KB HTML per navigation; async buys nothing here.
            let raw = p.htmlBuf;
            try {
              if (enc.includes("br")) raw = zlib.brotliDecompressSync(raw);
              else if (enc.includes("gzip")) raw = zlib.gunzipSync(raw);
              else raw = zlib.inflateSync(raw);
            } catch (e) {
              // Can't decode safely — forward untouched rather than corrupt.
              // No content-length was set (deleted at response time), so Node
              // frames it correctly on end().
              logProxy(p, `← ${p.htmlStatus} passthrough undecodable ${enc} ${Date.now() - p.startedAt}ms`);
              try { p.res.writeHead(p.htmlStatus, p.htmlHeaders); p.res.end(p.htmlBuf); }
              catch (ee) { try { p.res.end(); } catch {} }
              return;
            }
            delete p.htmlHeaders["content-encoding"];
            html = raw.toString("utf8");
          } else {
            html = p.htmlBuf.toString("utf8");
          }
          let idx = html.indexOf("</head>");
          if (idx === -1) idx = html.indexOf("</body>");
          if (idx === -1) idx = html.length;
          html = html.slice(0, idx) + injection + html.slice(idx);
          const newBuf = Buffer.from(html, "utf8");
          // The local backend usually sends `transfer-encoding: chunked` (no
          // content-length). We copied its headers verbatim, so we must drop
          // TE when we set an explicit content-length — sending both makes
          // ingress-nginx reject the response with 502 ("Content-Length and
          // Transfer-Encoding at the same time").
          delete p.htmlHeaders["transfer-encoding"];
          delete p.htmlHeaders["Transfer-Encoding"];
          p.htmlHeaders["content-length"] = String(newBuf.length);
          try {
            p.res.writeHead(p.htmlStatus, p.htmlHeaders);
            p.res.end(newBuf);
            logProxy(p, `← ${p.htmlStatus} ${newBuf.length}B ${Date.now() - p.startedAt}ms (+PWA)`);
          } catch (e) { try { p.res.end(); } catch {} }
          return;
        }
        if (p.fanout) {
          // Upstream SSE ended. End every current subscriber and DROP the
          // fan state — the next browser reconnect (typically <1s, the
          // EventSource default) must trigger a fresh upstream open. If we
          // kept the fan in sseFanout with upstreamEnded=true, every
          // reconnect would hit the "ended" path and be closed immediately,
          // causing a tight reconnect loop with no actual upstream.
          const t = p.tunnelToken;
          const bytes = p.fanout.bytes;
          const sinceMs = Date.now() - p.fanout.startedAt;
          const nsubs = p.fanout.subscribers.size;
          p.fanout.upstreamEnded = true;
          log(`[fanout] upstream ended: ${bytes}B in ${sinceMs}ms (${nsubs} subs) — fan torn down, next attach triggers fresh open`);
          for (const sub of p.fanout.subscribers) {
            try { sub.res.end(); } catch {}
          }
          p.fanout.subscribers.clear();
          sseFanout.delete(t);
          return;
        }
        logProxy(p, `← ${p.lastStatus || "?"} ${p.bytes || 0}B ${Date.now() - p.startedAt}ms`);
        try { p.res.end(); } catch {}
      } else if (msg.type === "pong") {
        // no-op, just a keepalive ack
      }
    });

    ws.on("close", (code, reason) => {
      if (tunnels.get(token)?.ws === ws) tunnels.delete(token);
      // Tear down any fanout state tied to this tunnel — no upstream to fan to.
      const fan = sseFanout.get(token);
      if (fan) {
        sseFanout.delete(token);
        for (const sub of fan.subscribers) {
          try { sub.res.end(); } catch {}
        }
      }
      log(`[tunnel] disconnected: ${t.name} (${t.id}) code=${code} activeTunnels=${tunnels.size}`);
      // Fail any in-flight requests that were routed to this tunnel with a
      // proper 502 instead of silently truncating the response. Otherwise the
      // browser sees a half-formed body and reports a confusing error.
      // Skip fanout upstreams — their subscribers were already closed above
      // and they have no `res` to write to.
      for (const [id, p] of pending) {
        if (p.tunnelToken !== token) continue;
        if (p.fanout) { pending.delete(id); continue; }
        pending.delete(id);
        if (!p.headersSent) {
          logProxy(p, `← tunnel dropped (502) ${Date.now() - p.startedAt}ms`);
          try { p.res.writeHead(502, { "Content-Type": "text/plain" });
                p.res.end("tunnel disconnected"); } catch {}
        } else {
          try { p.res.end(); } catch {}
        }
      }
    });
    ws.on("error", (e) => log(`[tunnel] error: ${t.name} (${t.id}): ${e.message}`));
  });
}

// Pick the tunnel for a given request. Each device can be bound to a specific
// tunnel via device.tunnelId; otherwise the first active tunnel is used
// (backward-compatible single-tunnel mode).
function tunnelForRequest(req) {
  const all = [...tunnels.entries()].filter(([_, e]) => e.ws.readyState === 1);
  if (all.length === 0) return null;
  if (req.device && req.device.tunnelId) {
    const match = all.find(([_, e]) => e.id === req.device.tunnelId);
    if (match) return { token: match[0], entry: match[1] };
    // Device is bound to a specific tunnel but it's offline. Don't silently
    // fall back to another tunnel — the request would touch a different
    // user's opencode serve. Return null and let the caller return 503.
    return null;
  }
  return { token: all[0][0], entry: all[0][1] };
}

// Backward-compat shim for the admin CLI ("tunnel status"). Returns the first
// active tunnel. The full list lives in tunnels.values() and is exposed via
// listTunnels() below.
function activeTunnel() {
  for (const [token, entry] of tunnels) {
    if (entry.ws.readyState === 1 /* OPEN */) return { token, entry };
  }
  return null;
}

function listTunnels() {
  const out = [];
  for (const [token, entry] of tunnels) {
    out.push({
      token: token.slice(0, 8) + "…",
      id: entry.id,
      name: entry.name,
      ready: entry.ws.readyState === 1,
      lastSeenAt: entry.lastSeenAt,
    });
  }
  return out;
}

function logProxy(p, msg) {
  const dev = p.device ? p.device.name : "?";
  const tid = p.tunnelEntry ? p.tunnelEntry.id.slice(0, 8) : "?";
  console.log(`[${ts()}] [proxy] ${p.method} ${p.path} dev="${dev}" t=${tid} ${msg}`);
}

// ---------- /global/event SSE fanout ----------

// Subscribe a browser client to the per-tunnel SSE fanout. The first
// subscriber triggers an upstream open to the opencode serve; subsequent
// subscribers attach to the same upstream. When the last subscriber leaves,
// the upstream is "closed" by removing the gateway's tracking (see note
// below on the cancel limitation).
function handleSseSubscribe(req, res, t, path) {
  let fan = sseFanout.get(t.token);
  if (!fan) {
    fan = {
      upstreamId: null,
      upstreamStatus: null,
      upstreamHeaders: null,
      upstreamHeadersSent: false,
      upstreamEnded: false,
      subscribers: new Set(),
      bytes: 0,
      startedAt: Date.now(),
    };
    sseFanout.set(t.token, fan);
    openSseUpstream(t, fan, path, sanitizeHeaders(req.headers));
  }
  const sub = { res, device: req.device || null, startedAt: Date.now(), headersSent: false };
  fan.subscribers.add(sub);
  logProxy(
    { res, device: sub.device, method: "GET", path, tunnelEntry: t.entry, startedAt: sub.startedAt, lastStatus: null, bytes: 0, headersSent: false },
    `→ fanout (subs=${fan.subscribers.size}${fan.upstreamHeadersSent ? ", upstream live" : ", upstream pending"}${fan.upstreamEnded ? ", upstream ended" : ""})`
  );

  // Upstream already streaming? Write headers to this subscriber now.
  if (fan.upstreamHeadersSent && !fan.upstreamEnded) {
    try {
      sub.res.writeHead(fan.upstreamStatus, fan.upstreamHeaders);
      sub.headersSent = true;
    } catch (e) {
      fan.subscribers.delete(sub);
      return;
    }
  } else if (fan.upstreamEnded) {
    // Upstream ended before this subscriber attached (rare — opencode serve
    // rarely ends the stream). End the subscriber immediately; the next
    // attach will trigger a fresh open.
    fan.subscribers.delete(sub);
    try { res.end(); } catch {}
    return;
  }

  // Heartbeat: write an SSE comment to every subscriber every 15s.
  //
  // Three things this gets us:
  //   1. Detect a half-dead browser TCP connection (browser killed the
  //      socket without sending FIN — happens with mobile background
  //      tabs, OS sleep, aggressive middlebox idle kills). On write
  //      error we drop just that subscriber; the next browser
  //      EventSource auto-reconnect (default ~3s) re-establishes.
  //   2. Keep the connection warm against middlebox idle timeouts
  //      (Cloudflare 100s, nginx 60s, k8s ingress 60s default).
  //   3. Force the browser to keep the EventSource live even when
  //      the opencode serve upstream is silent (no LLM is generating,
  //      so opencode serve sends nothing on /global/event).
  //
  // SSE comments (": heartbeat\n\n") are ignored by the browser's
  // EventSource, so this is a no-op for the UI — it only exercises
  // the TCP socket. `unref()` so the interval never keeps the
  // gateway process alive on its own.
  const heartbeat = setInterval(() => {
    for (const s of [...fan.subscribers]) {
      try { s.res.write(": heartbeat\n\n"); }
      catch (e) { fan.subscribers.delete(s); }
    }
  }, 15_000);
  heartbeat.unref();

  // Drop the subscriber when its response closes (browser disconnect,
  // navigation, tab close, etc.). If it's the last one out, tear down
  // the fanout state.
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!fan.subscribers.has(sub)) return; // already removed
    fan.subscribers.delete(sub);

    // Mark this device for a one-shot page refresh. The SSE just died —
    // that's our "resume" signal. The next HTML response the browser
    // requests (page reload, navigation, F5) gets `Refresh: 0` injected
    // by the response handler, so the user comes back to a fresh UI
    // instead of the stale snapshot they had when the SSE went away.
    // 30s TTL keeps it from firing on unrelated future requests.
    if (sub.device) {
      deviceRefreshQueue.set(sub.device.id, Date.now() + 30_000);
    }
    logProxy(
      { res, device: sub.device, method: "GET", path, tunnelEntry: t.entry, startedAt: sub.startedAt, lastStatus: null, bytes: 0, headersSent: sub.headersSent },
      `← fanout unsub (subs=${fan.subscribers.size})`
    );
    if (fan.subscribers.size === 0) {
      // The tunnel protocol has no "cancel upstream" frame, so the
      // opencode-serve side of the /global/event will keep streaming
      // until opencode itself closes it (which is "never"). The
      // gateway's tracking is gone, so the streamed bytes are
      // silently dropped (pending.delete on the next frame). The
      // leaked opencode-serve connection is the cost of the protocol's
      // design — it cleans up on tunnel-client restart.
      sseFanout.delete(t.token);
      if (fan.upstreamId && pending.has(fan.upstreamId)) {
        pending.delete(fan.upstreamId);
        log(`[fanout] last subscriber out — upstream ${fan.upstreamId.slice(0, 8)} abandoned (${fan.bytes}B received so far)`);
      } else {
        log(`[fanout] last subscriber out — no live upstream to abandon`);
      }
    }
  });
}

// Open a /global/event upstream through the tunnel. Tracked in `pending`
// with `res: null` and `fanout: fan` so the response frames in
// `ws.on("message")` route to the fanout, not to a missing res.
function openSseUpstream(t, fan, path, headers) {
  const id = crypto.randomUUID();
  fan.upstreamId = id;
  const p = {
    fanout: fan,
    res: null,
    device: null,
    tunnelToken: t.token,
    tunnelEntry: t.entry,
    method: "GET",
    path,
    headersSent: false,
    startedAt: Date.now(),
    bytes: 0,
    lastStatus: null,
  };
  pending.set(id, p);
  try {
    t.entry.ws.send(JSON.stringify({ type: "request", id, method: "GET", path, headers }));
    t.entry.ws.send(JSON.stringify({ type: "request-end", id }));
  } catch (e) {
    pending.delete(id);
    log(`[fanout] upstream open failed: ${e.message}`);
    fan.upstreamEnded = true;
    for (const sub of fan.subscribers) { try { sub.res.end(); } catch {} }
    fan.subscribers.clear();
  }
}

// List fanouts for /health. Returns one entry per tunnel with an open
// upstream or active subscribers.
function listSseFanouts() {
  const out = [];
  for (const [token, fan] of sseFanout) {
    out.push({
      tunnel: token.slice(0, 8) + "…",
      upstreamId: fan.upstreamId ? fan.upstreamId.slice(0, 8) : null,
      upstreamLive: fan.upstreamHeadersSent && !fan.upstreamEnded,
      upstreamEnded: fan.upstreamEnded,
      subscribers: fan.subscribers.size,
      bytes: fan.bytes,
      sinceMs: Date.now() - fan.startedAt,
    });
  }
  return out;
}

// HTTP middleware: forwards the request body to the chosen tunnel and streams
// the response back. Per-request logs at start and end so a dynamic-import
// failure (or any other tunnel-side problem) is visible in the pod logs.
function proxyHttp(req, res) {
  const t = tunnelForRequest(req);
  if (!t) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset=utf-8>
<title>OpenCode — tunnel offline</title>
<style>body{font-family:system-ui;margin:40px;max-width:560px;color:#222}h1{font-size:20px}p{line-height:1.5}</style>
<h1>Tunnel offline</h1>
<p>The local <code>opencode serve</code> tunnel is not connected${req.device && req.device.tunnelId ? " for your device" : ""}. Start the tunnel client on the server machine and reload this page.</p>
<p style="color:#666;font-size:13px">If you don't have a tunnel token, generate one: <code>kubectl -n nexvision exec deploy/ai-manager-gateway -- gateway-admin tunnel-token create --name "my-laptop"</code></p>`);
  }
  const path = req.originalUrl || req.url;

  // /global/event is the opencode live-event SSE. Every browser wants the
  // same stream — fan it out from a single upstream held by the gateway
  // (see sseFanout). Without this, each browser opens its own upstream,
  // the opencode serve races to handle them, and one device gets cut.
  if (req.method === "GET" && req.path === "/global/event") {
    return handleSseSubscribe(req, res, t, path);
  }

  const id = crypto.randomUUID();
  const p = {
    res,
    device: req.device || null,
    tunnelToken: t.token,
    tunnelEntry: t.entry,
    method: req.method,
    path,
    headersSent: false,
    startedAt: Date.now(),
    bytes: 0,
    lastStatus: null,
  };
  pending.set(id, p);
  logProxy(p, `→ tunnel`);

  // Send request frame
  try {
    const fwdHeaders = sanitizeHeaders(req.headers);
    if (SERVE_BASIC && !fwdHeaders["authorization"]) fwdHeaders["authorization"] = SERVE_BASIC;
    t.entry.ws.send(JSON.stringify({
      type: "request",
      id,
      method: req.method,
      path,
      headers: fwdHeaders,
    }));
  } catch (e) {
    pending.delete(id);
    logProxy(p, `send failed: ${e.message}`);
    res.writeHead(502); res.end("tunnel send failed: " + e.message);
    return;
  }

  // Stream body.  If the body was already buffered by upstream middleware
  // (`req.rawBody` set by the raw-body capture in server.js), send it as a
  // single `request-data` frame and `request-end` immediately.  Otherwise
  // fall back to streaming `data`/`end` events.  Express's `express.json()`
  // middleware consumes the request stream before our handler runs, so we
  // always need the raw-body buffer approach.
  if (req.rawBody !== undefined || req.rawBodyError) {
    if (req.rawBody && req.rawBody.length > 0) {
      try {
        t.entry.ws.send(JSON.stringify({ type: "request-data", id, data: req.rawBody.toString("base64") }));
        p.bytes = req.rawBody.length;
      } catch (e) { cleanup(id, "tunnel send failed: " + e.message); return; }
    }
    try { t.entry.ws.send(JSON.stringify({ type: "request-end", id })); }
    catch (e) { cleanup(id, "tunnel send failed: " + e.message); }
  } else {
    req.on("data", (chunk) => {
      if (!pending.has(id)) return;
      p.bytes += chunk.length;
      try {
        t.entry.ws.send(JSON.stringify({ type: "request-data", id, data: chunk.toString("base64") }));
      } catch (e) { cleanup(id, "tunnel send failed: " + e.message); }
    });
    req.on("end", () => {
      if (!pending.has(id)) return;
      try { t.entry.ws.send(JSON.stringify({ type: "request-end", id })); }
      catch (e) { cleanup(id, "tunnel send failed: " + e.message); }
    });
  }
  req.on("error", (e) => cleanup(id, "client req error: " + e.message));
  res.on("close", () => { if (pending.has(id)) cleanup(id, "client closed early"); });

  // Track the response status once headers arrive so the end-of-request log
  // includes it. The response handler in the ws.on("message") above writes
  // the status to p.lastStatus via the implicit side channel below.
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (status, ...rest) {
    p.lastStatus = status;
    return origWriteHead(status, ...rest);
  };

  // Timeout if no response in 5 minutes
  setTimeout(() => { if (pending.has(id)) cleanup(id, "request timeout"); }, 5 * 60 * 1000).unref();
}

function cleanup(id, msg) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.fanout) {
    // Upstream timeout / error. End every subscriber. The next attach
    // triggers a fresh upstream open.
    log(`[fanout] upstream cleanup (${msg}): ${p.fanout.bytes}B received`);
    p.fanout.upstreamEnded = true;
    for (const sub of p.fanout.subscribers) {
      try { sub.res.end(); } catch {}
    }
    p.fanout.subscribers.clear();
    return;
  }
  // HTML responses are buffered until response-end so the SW-registration
  // injection can run. If we get a cleanup before that (timeout, tunnel
  // drop, etc.), headers were never sent — just end the response. The
  // browser will get an empty body, which is fine: it didn't pay the cost
  // of receiving partial HTML that would have been malformed by the missing
  // script tag.
  if (p.htmlMode) {
    logProxy(p, `cleanup (htmlMode) reason="${msg}" ${Date.now() - p.startedAt}ms`);
    try { p.res.end(); } catch {}
    return;
  }
  logProxy(p, `cleanup reason="${msg}" ${Date.now() - p.startedAt}ms`);
  if (!p.headersSent) {
    try { p.res.writeHead(504, { "Content-Type": "text/plain" }); p.res.end(msg || "timeout"); } catch {}
  } else {
    try { p.res.end(); } catch {}
  }
}

function sanitizeHeaders(headers) {
  // Pass most headers through; strip hop-by-hop and host (we set host on the local request)
  const out = {};
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (["host", "connection", "transfer-encoding", "upgrade", "proxy-connection", "keep-alive", "te", "trailers"].includes(lk)) continue;
    out[k] = headers[k];
  }
  // Tag the request so the local server sees it came via the auth proxy
  out["x-forwarded-proto"] = "https";
  out["x-forwarded-host"] = headers["x-forwarded-host"] || headers["host"] || "";
  out["x-forwarded-for"] = (headers["x-forwarded-for"] ? headers["x-forwarded-for"] + ", " : "") + (headers["x-real-ip"] || "");
  out["x-opencode-auth"] = "1";
  return out;
}

module.exports = {
  setup, proxyHttp,
  activeTunnel, listTunnels, tunnelForRequest,
  listSseFanouts,
  tunnels, pending, sseFanout,
};
