// tests/proxy.test.js — JSON bodies must survive the reverse proxy.
// Regression: express.json() mounted before the proxy used to consume the
// request stream, so POST/PUT JSON to web harnesses arrived empty.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { EventEmitter } = require("events");
const proxy = require("../src/server/proxy");

function echoBackend() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function mockReq({ method = "POST", url = "/x", body = "", headers = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers || { "content-type": "application/json" };
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function mockRes() {
  const res = new EventEmitter();
  res.status = null;
  res.chunks = [];
  res.headersSent = false;
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.writeHead = (s, h) => { res.status = s; res.head = h; res.headersSent = true; };
  res.write = (c) => res.chunks.push(Buffer.from(c));
  res.end = (c) => {
    if (c) res.chunks.push(Buffer.from(c));
    res.emit("done", Buffer.concat(res.chunks).toString("utf8"));
  };
  return res;
}

test("proxy: JSON body + method + path forwarded intact", async () => {
  const srv = await echoBackend();
  const port = srv.address().port;
  const payload = JSON.stringify({ hello: "world", n: 42 });
  const req = mockReq({ url: "/harness/x", body: payload });
  const res = mockRes();
  const done = new Promise((resolve) => res.on("done", resolve));
  proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/echo?q=1");
  const raw = await done;
  const got = JSON.parse(raw);
  assert.equal(res.status, 200);
  assert.equal(got.method, "POST");
  assert.equal(got.url, "/echo?q=1");
  assert.equal(got.body, payload);
  srv.close();
});

test("proxy: isManagerApiPath splits manager vs backend routes", () => {
  const { isManagerApiPath } = proxy;
  for (const p of ["/state", "/state?x=1", "/workspaces", "/workspaces/ws_1",
    "/sessions", "/sessions/sess_1", "/sessions/sess_1/ensure", "/sessions/sess_1/touch",
    "/consoles", "/consoles/con_1",
    "/pty/session/sess_1/stream", "/pty/console/con_1/input", "/pty/session/s_1/resize"]) {
    assert.equal(isManagerApiPath(p), true, p);
  }
  for (const p of ["/", "/event", "/event?x=1", "/session", "/sessions/sess_1/kill",
    "/pty/session/s_1/bogus", "/workspaces/a/b", "/stately"]) {
    assert.equal(isManagerApiPath(p), false, p);
  }
});

test("proxy: route shim predicate + injection + CSP", () => {
  const { shouldShimRoute, injectRouteShim, shimCspHeaders, ROUTE_SHIM_HASH } = proxy;
  assert.equal(shouldShimRoute("/", "GET"), true);
  assert.equal(shouldShimRoute("", "GET"), true);
  assert.equal(shouldShimRoute("/", "POST"), false);
  assert.equal(shouldShimRoute("/api/event", "GET"), false);
  assert.equal(shouldShimRoute("/_assets/x.js", "GET"), false);

  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const out = injectRouteShim(html);
  assert.ok(out.includes("aimgr-route-shim"));
  assert.ok(out.indexOf("aimgr-route-shim") > out.indexOf("<head>"));
  assert.ok(out.indexOf("aimgr-route-shim") < out.indexOf("<title>"));
  assert.equal(injectRouteShim(out), out); // idempotent
  assert.ok(injectRouteShim("<p>no head</p>").startsWith("<script>"));

  const h = { "content-security-policy": "default-src 'self'; script-src 'self'" };
  shimCspHeaders(h);
  assert.ok(h["content-security-policy"].includes(`'sha256-${ROUTE_SHIM_HASH}'`));
  const before = h["content-security-policy"];
  shimCspHeaders(h); // idempotent
  assert.equal(h["content-security-policy"], before);
  const noCsp = {};
  shimCspHeaders(noCsp); // no-op without CSP
  assert.deepEqual(noCsp, {});
});

test("proxy: shimRoute end-to-end rewrites session-root HTML", async () => {
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const req = mockReq({ method: "GET", url: "/s/sess_x/" });
  const res = mockRes();
  const done = new Promise((resolve) => res.on("done", resolve));
  proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/", { shimRoute: true });
  const raw = await done;
  assert.equal(res.status, 200);
  assert.ok(raw.includes("aimgr-route-shim"));
  assert.ok(Number(res.head["content-length"]) === Buffer.byteLength(raw));
  assert.ok(String(res.head["content-security-policy"]).includes("sha256-"));
  srv.close();
});

test("proxy: explicitMiddleware pins session + shims root HTML, passes assets", async () => {
  const os = require("os");
  const path = require("path");
  const store = require("../src/server/store");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-proxy-${Date.now()}.json`));

  // Stub backend mimicking `opencode serve`: HTML shell with CSP at /,
  // JS assets, and a JSON API that 401s without auth.
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/api/event") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url.startsWith("/_assets/")) {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("//js");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const ws = store.addWorkspace({ id: "ws_1", path: "/tmp", name: "tmp", createdAt: 1 });
  store.addSession({
    id: "sess_web", workspaceId: ws.id, harness: "opencode", title: "t",
    mode: "web", port, status: "running", createdAt: 1, lastActiveAt: 1,
  });
  const noFallthrough = () => { throw new Error("should not fall through"); };

  // 1. Session root document → shimmed HTML + focus cookie.
  const res1 = mockRes();
  const done1 = new Promise((r) => res1.on("done", r));
  proxy.explicitMiddleware(mockReq({ method: "GET", url: "/s/sess_web/" }), res1, noFallthrough);
  const raw1 = await done1;
  assert.equal(res1.status, 200);
  assert.ok(raw1.includes("aimgr-route-shim"), "shim script injected");
  assert.ok(String(res1.head["content-security-policy"]).includes("sha256-"), "CSP allows shim");
  assert.ok(String(res1.headers["set-cookie"]).includes("aimgr_active=sess_web"), "focus cookie set");

  // 2. Subpath asset → proxied untouched.
  const res2 = mockRes();
  const done2 = new Promise((r) => res2.on("done", r));
  proxy.explicitMiddleware(mockReq({ method: "GET", url: "/s/sess_web/_assets/x.js" }), res2, noFallthrough);
  const raw2 = await done2;
  assert.equal(raw2, "//js");
  assert.ok(!raw2.includes("aimgr-route-shim"));

  // 3. /api/ middleware: backend API proxied, manager routes + cookieless fall through.
  let nexted = 0;
  const next = () => { nexted++; };
  const res3 = mockRes();
  const done3 = new Promise((r) => res3.on("done", r));
  proxy.apiBackendMiddleware(
    mockReq({ method: "GET", url: "/event", headers: { cookie: "aimgr_active=sess_web" } }),
    res3, next
  );
  const raw3 = await done3;
  assert.equal(res3.status, 401, "reached backend API, not manager 404");
  assert.equal(raw3, "{}");
  assert.equal(nexted, 0);
  proxy.apiBackendMiddleware(mockReq({ method: "GET", url: "/state" }), mockRes(), next);
  assert.equal(nexted, 1, "manager route falls through");
  proxy.apiBackendMiddleware(mockReq({ method: "GET", url: "/event" }), mockRes(), next);
  assert.equal(nexted, 2, "no active-session cookie falls through");

  srv.close();
});

test("proxy: resolveFromUrl maps prefixes", () => {
  // Unknown session id → 404 descriptor (no store dependency on happy path)
  const r = proxy.resolveFromUrl("/harness/sess_missing/");
  assert.equal(r.error, 404);
  assert.equal(proxy.resolveFromUrl("/api/state"), null);
  assert.equal(proxy.resolveFromUrl("/s/abc").sess, undefined); // error obj, not null
});

test("proxy: upstream Authorization injected (opencode auto-connect)", async () => {
  const auth = require("../src/server/opencodeAuth");
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authorization: req.headers.authorization || null }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const req = mockReq({ method: "GET", url: "/s/x" });
  const res = mockRes();
  const done = new Promise((r) => res.on("done", r));
  proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/api/info");
  const raw = await done;
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(raw).authorization, auth.authHeader());
  srv.close();
});

test("proxy: session shim deep-links into pre-created chat (no project picker)", () => {
  const { shimBodyFor, hashForBody, injectRouteShim, shimCspHeaders } = proxy;
  // No session → legacy root rewrite (stable hash).
  assert.equal(shimBodyFor(null), proxy.ROUTE_SHIM_BODY);
  assert.equal(shimBodyFor(""), proxy.ROUTE_SHIM_BODY);
  // With session → replaceState targets /server/<b64>/session/<id>.
  const body = shimBodyFor("ses_abc123XYZ_-");
  assert.ok(body.includes("ses_abc123XYZ_-"), body);
  assert.ok(body.includes("/session/"), body);
  assert.ok(body.includes("btoa(location.origin)"), body);
  // Unsafe chars stripped — the raw payload must not survive verbatim.
  const evil = shimBodyFor('ses_";alert(1)//');
  assert.ok(!evil.includes('alert(1)'), "parens/semicolon payload stripped");
  assert.ok(evil.includes("ses_alert1"), "safe chars kept");
  // Injection + CSP carry the per-session script.
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const out = injectRouteShim(html, "ses_abc123XYZ_-");
  assert.ok(out.includes("ses_abc123XYZ_-"));
  const h = { "content-security-policy": "default-src 'self'; script-src 'self'" };
  shimCspHeaders(h, body);
  assert.ok(h["content-security-policy"].includes(`'sha256-${hashForBody(body)}'`));
});

test("proxy: explicitMiddleware shims pre-created chat id into session root", async () => {
  const os = require("os");
  const path = require("path");
  const store = require("../src/server/store");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-proxy-shim-${Date.now()}.json`));
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const ws = store.addWorkspace({ id: "ws_1", path: "/tmp", name: "tmp", createdAt: 1 });
  store.addSession({
    id: "sess_chat", workspaceId: ws.id, harness: "opencode", title: "t",
    mode: "web", port, status: "running", harnessSessionId: "ses_precreated123",
    createdAt: 1, lastActiveAt: 1,
  });
  const res1 = mockRes();
  const done1 = new Promise((r) => res1.on("done", r));
  proxy.explicitMiddleware(
    mockReq({ method: "GET", url: "/s/sess_chat/" }), res1,
    () => { throw new Error("should not fall through"); }
  );
  const raw1 = await done1;
  assert.equal(res1.status, 200);
  assert.ok(raw1.includes("ses_precreated123"), "deep-link shim injected");
  assert.ok(raw1.includes("/session/"), "shim targets session route");
  assert.ok(!raw1.includes('/*aimgr-route-shim*/history.replaceState(null,"","/")'), "not the bare root shim");
  srv.close();
});

test("proxy: withToken appends dsh token upstream only when absent", () => {
  const { withToken } = proxy;
  assert.equal(withToken("/a?b=1", "TOK12345"), "/a?b=1&token=TOK12345");
  assert.equal(withToken("/", "TOK12345"), "/?token=TOK12345");
  assert.equal(withToken("/?token=OTHER", "TOK12345"), "/?token=OTHER");
  assert.equal(withToken("/api/x", null), "/api/x");
  assert.equal(withToken("/api/x", ""), "/api/x");
});

test("proxy: proxyRequest forwards harnessToken query upstream", async () => {
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const get = (url, opts) => new Promise((resolve) => {
    const req = mockReq({ method: "GET", url });
    const res = mockRes();
    res.on("done", (raw) => resolve({ status: res.status, body: raw }));
    proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/page", opts);
  });
  const withTok = await get("/s/x/", { harnessToken: "TOK12345" });
  assert.equal(withTok.status, 200);
  assert.equal(JSON.parse(withTok.body).url, "/page?token=TOK12345");
  const plain = await get("/s/x/", {});
  assert.equal(JSON.parse(plain.body).url, "/page");
  srv.close();
});

test("proxy: harnessToken skipped once backend cookie exists (dsh handshake)", async () => {
  const { hasBackendCookie } = proxy;
  assert.equal(hasBackendCookie({}), false);
  assert.equal(hasBackendCookie({ cookie: "aimgr_active=sess_1" }), false);
  assert.equal(hasBackendCookie({ cookie: "oc_locale=en; aimgr_active=sess_1" }), false);
  assert.equal(hasBackendCookie({ cookie: "aimgr_active=sess_1; dsh-auth-x=abc" }), true);
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const get = (headers, opts) => new Promise((resolve) => {
    const req = mockReq({ method: "GET", url: "/s/x/", headers });
    const res = mockRes();
    res.on("done", (raw) => resolve(JSON.parse(raw).url));
    proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/page", opts);
  });
  assert.equal(await get({ cookie: "dsh-auth-x=abc" }, { harnessToken: "TOK" }), "/page");
  assert.equal(await get({}, { harnessToken: "TOK" }), "/page?token=TOK");
  srv.close();
});

test("proxy: backend cookies pass through, aimgr_active stripped", async () => {
  const { stripAimgrCookie } = proxy;
  const h = { "set-cookie": ["aimgr_active=evil; Path=/", "dsh_sess=abc; Path=/; HttpOnly"] };
  stripAimgrCookie(h);
  assert.deepEqual(h["set-cookie"], ["dsh_sess=abc; Path=/; HttpOnly"]);
  const h2 = { "set-cookie": "aimgr_active=evil; Path=/" };
  stripAimgrCookie(h2);
  assert.ok(!("set-cookie" in h2));
  const h3 = {};
  stripAimgrCookie(h3); // no-op
  assert.deepEqual(h3, {});
});

test("proxy: dsh session root redirects once to ?token= for app boot", async () => {
  const os = require("os");
  const path = require("path");
  const store = require("../src/server/store");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-proxy-dsh-${Date.now()}.json`));
  const ws = store.addWorkspace({ id: "ws_1", path: "/tmp", name: "tmp", createdAt: 1 });
  store.addSession({
    id: "sess_dsh", workspaceId: ws.id, harness: "dsh", title: "t",
    mode: "web", port: 9, status: "running", harnessToken: "TOKFORBOOT",
    createdAt: 1, lastActiveAt: 1,
  });
  // No backend cookie, no token in query → 302 to ?token= (no backend hit).
  const res1 = mockRes();
  let wroteHead = null;
  res1.writeHead = (s, h) => { wroteHead = { s, h }; res1.headersSent = true; };
  const origEnd = res1.end;
  const done1 = new Promise((r) => res1.on("done", r));
  res1.end = (c) => { if (c) res1.chunks.push(Buffer.from(c)); res1.emit("done", ""); };
  proxy.explicitMiddleware(mockReq({ method: "GET", url: "/s/sess_dsh/" }), res1, () => { throw new Error("must not fall through"); });
  await done1;
  assert.equal(wroteHead.s, 302);
  assert.ok(String(wroteHead.h.Location).includes("token=TOKFORBOOT"), wroteHead.h.Location);
  assert.ok(String(res1.headers["set-cookie"]).includes("aimgr_active=sess_dsh"));
  // With backend cookie present → no redirect (falls to proxy; port 9 refuses).
  const res2 = mockRes();
  const done2 = new Promise((r) => res2.on("done", r));
  proxy.explicitMiddleware(
    mockReq({ method: "GET", url: "/s/sess_dsh/", headers: { cookie: "dsh-auth-x=abc" } }),
    res2, () => { throw new Error("must not fall through"); }
  );
  const raw2 = await done2;
  assert.ok(String(raw2).includes("unreachable"), "proxied, not redirected");
});

test("proxy: withQueueDefault unit (fail-open)", () => {
  const { withQueueDefault } = proxy;
  const B = (s) => Buffer.from(s, "utf8");
  // Missing/null/empty delivery → queue.
  for (const raw of [`{"text":"hi"}`, `{"text":"hi","delivery":null}`, `{"text":"hi","delivery":""}`]) {
    const out = withQueueDefault("POST", "/api/session/ses_1/prompt", B(raw));
    assert.equal(JSON.parse(out.toString("utf8")).delivery, "queue", raw);
  }
  // Explicit values pass through byte-identical (query string tolerated).
  for (const d of ["steer", "queue"]) {
    const raw = JSON.stringify({ text: "hi", delivery: d });
    assert.equal(withQueueDefault("POST", "/api/session/ses_1/prompt?x=1", B(raw)).toString("utf8"), raw);
  }
  // Non-matching method/path/body pass through untouched.
  const raw = `{"text":"hi"}`;
  assert.equal(withQueueDefault("GET", "/api/session/ses_1/prompt", B(raw)).toString("utf8"), raw);
  assert.equal(withQueueDefault("POST", "/api/session/ses_1/message", B(raw)).toString("utf8"), raw);
  assert.equal(withQueueDefault("POST", "/api/event", B(raw)).toString("utf8"), raw);
  assert.equal(withQueueDefault("POST", "/api/session/ses_1/prompt", B("not json{")).toString("utf8"), "not json{");
  assert.equal(withQueueDefault("POST", "/api/session/ses_1/prompt", B("[1,2]")).toString("utf8"), "[1,2]");
  assert.equal(withQueueDefault("POST", "/api/session/ses_1/prompt", Buffer.alloc(0)).length, 0);
});

test("proxy: unspecified prompt delivery forwarded as queue, explicit steer kept", async () => {
  const srv = await echoBackend();
  const port = srv.address().port;
  const post = (subPath, body) => new Promise((resolve) => {
    const req = mockReq({ method: "POST", url: "/s/sess_web/x", body });
    const res = mockRes();
    res.on("done", (raw) => resolve(JSON.parse(raw).body));
    proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, subPath);
  });
  assert.equal(JSON.parse(await post("/api/session/ses_abc/prompt", JSON.stringify({ text: "hi" }))).delivery, "queue");
  assert.equal(JSON.parse(await post("/api/session/ses_abc/prompt", JSON.stringify({ text: "hi", delivery: null }))).delivery, "queue");
  const steer = JSON.parse(await post("/api/session/ses_abc/prompt", JSON.stringify({ text: "hi", delivery: "steer" })));
  assert.equal(steer.delivery, "steer");
  assert.equal(steer.text, "hi");
  // Slash commands share the default.
  assert.equal(JSON.parse(await post("/api/session/ses_abc/command", JSON.stringify({ name: "x", text: "y" }))).delivery, "queue");
  // Other endpoints arrive byte-identical.
  const other = JSON.stringify({ text: "hi" });
  assert.equal(await post("/api/session/ses_abc/model", other), other);
  assert.equal(await post("/api/event", other), other);
  srv.close();
});

test("proxy: injectWebDefaults unit (queue + dark defaults, explicit choice kept)", () => {
  const { injectWebDefaults, WEB_DEFAULTS_SEED_BODY } = proxy;
  // Seed contract, asserted statically: exact storage keys, absent-only
  // guards, default values, never throws.
  assert.ok(WEB_DEFAULTS_SEED_BODY.includes("aimgr-web-defaults"), "marker comment");
  assert.ok(WEB_DEFAULTS_SEED_BODY.includes("opencode.global.dat:settings.v3"), "settings key");
  assert.ok(WEB_DEFAULTS_SEED_BODY.includes("opencode-color-scheme"), "color-scheme key");
  assert.ok(WEB_DEFAULTS_SEED_BODY.includes("getItem(s)===null"), "settings absent-only guard");
  assert.ok(WEB_DEFAULTS_SEED_BODY.includes("getItem(c)===null"), "scheme absent-only guard");
  assert.ok(/followUpBehavior:"queue"/.test(WEB_DEFAULTS_SEED_BODY), "queue default");
  assert.ok(/setItem\(c,"dark"\)/.test(WEB_DEFAULTS_SEED_BODY), "dark default");
  assert.ok(/^\/\*aimgr-web-defaults\*\/try\{.*\}catch\(e\)\{\}$/.test(WEB_DEFAULTS_SEED_BODY), "try/catch wrapped");
  // Seed carries the queue default as a JS literal (partial blob is
  // schema-safe: the app decodes with defaults for missing keys).
  const m = /general:\{followUpBehavior:"(queue|steer)"\}/.exec(WEB_DEFAULTS_SEED_BODY);
  assert.ok(m, "seed carries a general.followUpBehavior default");
  assert.equal(m[1], "queue");

  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const out = injectWebDefaults(html);
  assert.ok(out.includes("aimgr-web-defaults"));
  assert.ok(out.indexOf("aimgr-web-defaults") > out.indexOf("<head>"));
  assert.ok(out.indexOf("aimgr-web-defaults") < out.indexOf("<title>"));
  assert.equal(injectWebDefaults(out), out); // idempotent
  assert.ok(injectWebDefaults("<p>no head</p>").startsWith("<script>"));
});

test("proxy: shimRoute end-to-end injects web defaults + CSP hash", async () => {
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const req = mockReq({ method: "GET", url: "/s/sess_x/" });
  const res = mockRes();
  const done = new Promise((resolve) => res.on("done", resolve));
  proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/", { shimRoute: true });
  const raw = await done;
  assert.equal(res.status, 200);
  assert.ok(raw.includes("aimgr-route-shim"), "route shim still injected");
  assert.ok(raw.includes("aimgr-web-defaults"), "defaults seed injected");
  const csp = String(res.head["content-security-policy"]);
  assert.ok(csp.includes("sha256-"), "CSP allows inline scripts");
  assert.ok(csp.includes(`'sha256-${proxy.hashForBody(proxy.WEB_DEFAULTS_SEED_BODY)}'`), "seed hash in CSP");
  srv.close();
});

test("proxy: injectNoTitlebar unit (whole bar hidden via slot hook)", () => {
  const { injectNoTitlebar, NO_TITLEBAR_CSS } = proxy;
  // Contract: stable slot hook (not hashed classes); the whole titlebar goes
  // (manager owns its jobs: switching, new sessions, status).
  assert.ok(NO_TITLEBAR_CSS.includes("aimgr-no-titlebar"), "marker comment");
  assert.ok(NO_TITLEBAR_CSS.includes('header[data-slot="titlebar-v2"]'), "slot hook");
  assert.ok(/display:\s?none\s?!important/.test(NO_TITLEBAR_CSS), "hidden");

  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const out = injectNoTitlebar(html);
  assert.ok(out.includes("aimgr-no-titlebar"));
  assert.ok(out.includes("<style>"), "style tag (no CSP hash needed: style-src allows unsafe-inline)");
  assert.ok(out.indexOf("aimgr-no-titlebar") > out.indexOf("<head>"));
  assert.equal(injectNoTitlebar(out), out); // idempotent
  assert.ok(injectNoTitlebar("<p>no head</p>").startsWith("<style>"));
});

test("proxy: shimRoute end-to-end injects no-titlebar style", async () => {
  const html = '<!doctype html><html><head><title>t</title></head><body><header data-slot="titlebar-v2"></header></body></html>';
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const req = mockReq({ method: "GET", url: "/s/sess_x/" });
  const res = mockRes();
  const done = new Promise((resolve) => res.on("done", resolve));
  proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/", { shimRoute: true });
  const raw = await done;
  assert.equal(res.status, 200);
  assert.ok(raw.includes("aimgr-route-shim"), "route shim still injected");
  assert.ok(raw.includes("aimgr-web-defaults"), "defaults seed still injected");
  assert.ok(raw.includes("aimgr-no-titlebar"), "no-titlebar style injected");
  srv.close();
});

test("proxy: injectNoTitlebar also hides session header (div[data-session-title])", () => {
  const { injectNoTitlebar, NO_TITLEBAR_CSS } = proxy;
  // Both hooks: legacy app titlebar + session header bar (user-supplied snippet:
  // <div data-session-title="" class="pointer-events-none sticky top-0 ...">).
  assert.ok(NO_TITLEBAR_CSS.includes('header[data-slot="titlebar-v2"]'), "titlebar hook kept");
  assert.ok(NO_TITLEBAR_CSS.includes("div[data-session-title]"), "session header hook");
  assert.ok(/display:\s?none\s?!important/.test(NO_TITLEBAR_CSS), "hidden");
  const html = '<!doctype html><html><head><title>t</title></head><body><div data-session-title=""><h1>opencode · ai-manager</h1></div></body></html>';
  const out = injectNoTitlebar(html);
  assert.ok(out.includes("aimgr-no-titlebar"));
  assert.equal(injectNoTitlebar(out), out); // idempotent
});

test("sidebar: left panel renders no harness tag (dashboard keeps it)", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
  const shelfFn = src.slice(src.indexOf("function renderAttentionShelf"), src.indexOf("function renderWorkspaces"));
  const wsFn = src.slice(src.indexOf("function renderWorkspaces"), src.indexOf("function startRename"));
  assert.ok(!shelfFn.includes('class="tag'), "attention shelf (left panel) has no harness tag");
  assert.ok(!wsFn.includes('class="tag'), "workspace session rows (left panel) have no harness tag");
  const dashFn = src.slice(src.indexOf("function renderDash"), src.indexOf("function hideStageViews"));
  assert.ok(dashFn.includes('class="tag'), "dashboard keeps harness tag");
});

test("sidebar: session title uses full row width (hover actions take no space)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");
  // Title label must be allowed to shrink/ellipsis within flex (else overflow).
  assert.ok(/\.sess \.lbl\s*\{[^}]*min-width:\s*0/.test(css), ".sess .lbl has min-width:0");
  // Empty idle span must not reserve a flex gap.
  assert.ok(css.includes(".sess .idle:empty"), "empty .idle hidden");
  // Hover-only buttons must not consume flex space when idle.
  for (const cls of [".sess-rename-hover", ".sess-del-hover"]) {
    const base = new RegExp(cls.replace(/\./g, "\\.") + "\\s*\\{[^}]*display:\\s*none").test(css);
    assert.ok(base, `${cls} display:none by default`);
    assert.ok(css.includes(`:hover ${cls}`), `${cls} shown on row hover`);
  }
});

test("ui-cleanup: sessionBar, statusline, shortcut-tip, sidebar-heading removed", () => {
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "public", "index.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");
  // Served manager DOM carries none of the removed chrome.
  for (const token of ['id="sessionBar"', 'id="statusline"', 'id="statusText"', 'id="hostStatus"',
    'shortcut-tip', 'sidebar-heading', 'WORKSPACES & SESSIONS',
    'crumbWs', 'sessionTitle', 'sessionStatusBadge', 'sessionHarnessBadge', 'sessionIdleBadge',
    'btnRename', 'btnEnsure', 'btnKill', 'btnOpenExternal']) {
    assert.ok(!html.includes(token), `index.html still contains ${token}`);
  }
  // No wiring references the removed bar/footer (status() is a no-op stub).
  for (const token of ["renderSessionBar", "renamingBar", "startBarRename", "cancelBarRename",
    "commitBarRename", "crumbWs", "sessionStatusBadge", "sessionHarnessBadge", "sessionIdleBadge",
    "btnRename", "btnEnsure", "btnKill", "btnOpenExternal", '$("statusText")', '$("hostStatus")',
    '"sessionTitle"', '"sessionBar"', '"statusline"']) {
    assert.ok(!js.includes(token), `app.js still references ${token}`);
  }
  // No dead style rules for the removed chrome.
  for (const token of [".session-bar", "#statusline", ".shortcut-tip", ".sidebar-heading",
    ".session-actions", ".tool-btn", ".harness-badge", ".status-badge", ".session-badges",
    ".session-title", ".crumb-nav", ".status-left", ".status-right", ".host-pill",
    ".status-shortcut-hint", ".status-indicator-dot", "#sessionTitle"]) {
    assert.ok(!css.includes(token), `app.css still contains ${token}`);
  }
  // Sidebar count pill survives (updateCounts + sidebar header need it).
  assert.ok(html.includes("sidebarCountPill"), "sidebar count pill removed by accident");
  assert.ok(js.includes("sidebarCountPill"), "count updater lost its target");
});

test("proxy: apiScopeBodyFor unit (per-pane fetch/XHR/SSE/WS scoping)", () => {
  const { apiScopeBodyFor } = proxy;
  assert.equal(apiScopeBodyFor(null), null);
  assert.equal(apiScopeBodyFor(""), null);
  const body = apiScopeBodyFor("sess_abc123XYZ_-");
  assert.ok(body.includes("aimgr-api-scope"), "marker comment");
  assert.ok(body.includes("/s/sess_abc123XYZ_-"), "embeds manager session prefix");
  assert.ok(body.includes("window.fetch"), "patches fetch");
  assert.ok(body.includes("XMLHttpRequest"), "patches XHR");
  assert.ok(body.includes("EventSource"), "patches SSE");
  assert.ok(body.includes("WebSocket"), "patches WS");
  // Unsafe chars stripped — the raw payload must not survive verbatim.
  const evil = apiScopeBodyFor('sess_";alert(1)//');
  assert.ok(evil && !evil.includes("alert(1)"), "payload stripped");
});

test("proxy: injectApiScope unit (idempotent, after head)", () => {
  const { injectApiScope } = proxy;
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const out = injectApiScope(html, "sess_x1");
  assert.ok(out.includes("aimgr-api-scope"));
  assert.ok(out.includes("/s/sess_x1"));
  assert.ok(out.indexOf("aimgr-api-scope") > out.indexOf("<head>"));
  assert.equal(injectApiScope(out, "sess_x1"), out); // idempotent
  assert.equal(injectApiScope(html, null), html); // no session → untouched
  assert.equal(injectApiScope(html, ""), html);
});

test("proxy: shimRoute end-to-end injects api scope + CSP hash", async () => {
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const req = mockReq({ method: "GET", url: "/s/sess_scope1/" });
  const res = mockRes();
  const done = new Promise((resolve) => res.on("done", resolve));
  proxy.proxyRequest(req, res, { host: "127.0.0.1", port }, "/", { shimRoute: true, scopeSessionId: "sess_scope1" });
  const raw = await done;
  assert.equal(res.status, 200);
  assert.ok(raw.includes("aimgr-route-shim"), "route shim kept");
  assert.ok(raw.includes("aimgr-web-defaults"), "defaults kept");
  assert.ok(raw.includes("aimgr-api-scope"), "api scope injected");
  assert.ok(raw.includes("/s/sess_scope1"), "scope carries manager session id");
  const csp = String(res.head["content-security-policy"]);
  assert.ok(csp.includes(`'sha256-${proxy.hashForBody(proxy.apiScopeBodyFor("sess_scope1"))}'`), "scope hash in CSP");
  srv.close();
});

test("proxy: explicitMiddleware passes scopeSessionId for session roots", async () => {
  const os = require("os");
  const path = require("path");
  const store = require("../src/server/store");
  store._resetForTest(path.join(os.tmpdir(), `aimgr-proxy-scope-${Date.now()}.json`));
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const ws = store.addWorkspace({ id: "ws_1", path: "/tmp", name: "tmp", createdAt: 1 });
  store.addSession({
    id: "sess_scope2", workspaceId: ws.id, harness: "opencode", title: "t",
    mode: "web", port, status: "running",
    createdAt: 1, lastActiveAt: 1,
  });
  const res1 = mockRes();
  const done1 = new Promise((r) => res1.on("done", r));
  proxy.explicitMiddleware(
    mockReq({ method: "GET", url: "/s/sess_scope2/" }), res1,
    () => { throw new Error("should not fall through"); }
  );
  const raw1 = await done1;
  assert.equal(res1.status, 200);
  assert.ok(raw1.includes("/s/sess_scope2"), "scoped prefix embedded");
  assert.ok(raw1.includes("aimgr-api-scope"), "scope script present");
  srv.close();
});

test("proxy: hashed bundle assets get immutable caching, API paths untouched", async () => {
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": req.url.endsWith(".js") ? "text/javascript" : "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      });
      res.end(req.url);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  try {
    assert.equal(proxy.isImmutableAsset("/_assets/index-xL8X34y1.js", "GET"), true);
    assert.equal(proxy.isImmutableAsset("/_assets/app.css?v=2", "GET"), true);
    assert.equal(proxy.isImmutableAsset("/_assets/index-xL8X34y1.js", "POST"), false);
    assert.equal(proxy.isImmutableAsset("/api/event", "GET"), false);
    assert.equal(proxy.isImmutableAsset("/", "GET"), false);
    assert.equal(proxy.isImmutableAsset("/_assets/../secret", "GET"), false);
    // Through proxyRequest: asset responses gain immutable, API passes through.
    const res1 = mockRes();
    const done1 = new Promise((r) => res1.on("done", r));
    proxy.proxyRequest(mockReq({ method: "GET", url: "/x" }), res1,
      { host: "127.0.0.1", port }, "/_assets/index-xL8X34y1.js");
    await done1;
    assert.equal(res1.status, 200);
    assert.equal(res1.head["cache-control"], proxy.IMMUTABLE_CACHE);
    assert.ok(!("pragma" in res1.head) && !("expires" in res1.head), "revalidation headers stripped");
    const res2 = mockRes();
    const done2 = new Promise((r) => res2.on("done", r));
    proxy.proxyRequest(mockReq({ method: "GET", url: "/x" }), res2,
      { host: "127.0.0.1", port }, "/api/event");
    await done2;
    assert.equal(res2.status, 200);
    assert.equal(res2.head["cache-control"], "no-cache", "API responses must not be cached");
  } finally {
    srv.close();
  }
});

test("proxy: workspace config GETs cache briefly, mutations invalidate", async () => {
  proxy._clearConfigCacheForTest();
  let hits = 0;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.method === "GET") hits++;
      res.writeHead(req.method === "GET" && req.url.startsWith("/api/model") ? 200 : 200,
        { "Content-Type": "application/json" });
      res.end(JSON.stringify({ n: hits }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const get = async (subPath, reqUrl, method) => {
    const res = mockRes();
    const done = new Promise((r) => res.on("done", r));
    proxy.proxyRequest(mockReq({ method: method || "GET", url: reqUrl || "/x" }), res,
      { host: "127.0.0.1", port }, subPath);
    const raw = await done;
    return { res, raw };
  };
  try {
    assert.equal(proxy.isCacheableApi("GET", "/api/model"), true);
    assert.equal(proxy.isCacheableApi("GET", "/api/model?location%5Bdirectory%5D=%2Ftmp"), true);
    assert.equal(proxy.isCacheableApi("POST", "/api/model"), false);
    assert.equal(proxy.isCacheableApi("GET", "/api/session/abc"), false);
    assert.equal(proxy.isCacheableApi("GET", "/api/event"), false);
    assert.equal(proxy.isCacheableApi("GET", "/api/session/active"), false);
    // Mirror real traffic: clean subPath, query on req.url (as express
    // delivers it after the /s/:id prefix strip).
    const q = "?location%5Bdirectory%5D=%2Ftmp";
    const first = await get("/api/model", `/s/sess_1/api/model${q}`);
    assert.equal(first.res.head["x-aimgr-cache"], "MISS");
    assert.equal(first.res.head["cache-control"], proxy.CONFIG_BROWSER_CACHE);
    const second = await get("/api/model", `/s/sess_1/api/model${q}`);
    assert.equal(second.res.head["x-aimgr-cache"], "HIT");
    assert.equal(second.res.head["cache-control"], proxy.CONFIG_BROWSER_CACHE);
    assert.equal(second.raw, first.raw, "hit serves the stored body");
    assert.equal(hits, 1, `one upstream fetch for two GETs (got ${hits})`);
    // Different workspace (different query) is a different entry.
    await get("/api/model", "/s/sess_1/api/model?location%5Bdirectory%5D=%2Fother");
    assert.equal(hits, 2);
    // Any /api mutation clears the cache.
    await get("/api/session/abc/prompt", "/s/sess_1/api/session/abc/prompt", "POST");
    const third = await get("/api/model", `/s/sess_1/api/model${q}`);
    assert.equal(third.res.head["x-aimgr-cache"], "MISS");
    assert.equal(hits, 3, "mutation must invalidate");
  } finally {
    proxy._clearConfigCacheForTest();
    srv.close();
  }
});
