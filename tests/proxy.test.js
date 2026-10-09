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

function mockReq({ method = "POST", url = "/x", body = "" }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
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

test("proxy: resolveFromUrl maps prefixes", () => {
  // Unknown session id → 404 descriptor (no store dependency on happy path)
  const r = proxy.resolveFromUrl("/harness/sess_missing/");
  assert.equal(r.error, 404);
  assert.equal(proxy.resolveFromUrl("/api/state"), null);
  assert.equal(proxy.resolveFromUrl("/s/abc").sess, undefined); // error obj, not null
});
