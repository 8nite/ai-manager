// gateway-tunnel.test.js — SSE fanout for */api/event (inFlight storm fix).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Isolate the gateway JSON registry: requiring tunnel.js pulls db.js which
// creates DATA_FILE on first load. Point it at a scratch file first.
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gwtest-")), "registry.json");
const tunnel = require("../k8s/ai-gateway/tunnel.js");

test("gateway-tunnel: sseFanoutKeyForPath unit", () => {
  const f = tunnel.sseFanoutKeyForPath;
  assert.equal(f("/global/event"), "/global/event");
  assert.equal(f("/api/event"), "/api/event");
  assert.equal(f("/s/sess_abc/api/event"), "/api/event");
  assert.equal(f("/harness/sess_xyz/api/event"), "/api/event");
  assert.equal(f("/s/sess_abc/api/event?x=1"), "/api/event");
  assert.equal(f("/global/event?foo=bar"), "/global/event");
  assert.equal(f("/"), null);
  assert.equal(f("/api/state"), null);
  assert.equal(f("/s/sess_abc/api/session/hid/prompt"), null);
  assert.equal(f(null), null);
  assert.equal(f(""), null);
});

test("gateway-tunnel: distinct /s/*/api/event share one upstream", () => {
  const { EventEmitter } = require("node:events");
  // Fresh maps for this test.
  tunnel.tunnels.clear();
  tunnel.pending.clear();
  tunnel.sseFanout.clear();
  const sent = [];
  const fakeWs = { readyState: 1, send: (s) => { sent.push(JSON.parse(s.toString())); } };
  tunnel.tunnels.set("tok_test_123", { ws: fakeWs, id: "tun1", name: "t1", lastSeenAt: Date.now(), lastPingSent: 0 });
  const mkRes = () => {
    const r = new EventEmitter();
    r.writeHead = () => {};
    r.write = () => true;
    r.end = () => {};
    return r;
  };
  const mkReq = (p) => ({ method: "GET", path: p, originalUrl: p, url: p, headers: {}, device: null, rawBody: Buffer.alloc(0) });
  tunnel.proxyHttp(mkReq("/s/sess_aaa/api/event"), mkRes());
  tunnel.proxyHttp(mkReq("/s/sess_bbb/api/event"), mkRes());
  assert.equal(tunnel.sseFanout.size, 1);
  assert.equal(tunnel.pending.size, 1);
  const [[key, fan]] = [...tunnel.sseFanout];
  assert.equal(key, "tok_test_123\n/api/event");
  assert.equal(fan.subscribers.size, 2);
  // Upstream opened once against the first subscriber's full path.
  const ups = sent.filter((s) => s.type === "request");
  assert.equal(ups.length, 1);
  assert.equal(ups[0].path, "/s/sess_aaa/api/event");
  const health = tunnel.listSseFanouts();
  assert.equal(health.length, 1);
  assert.equal(health[0].path, "/api/event");
  assert.equal(health[0].subscribers, 2);
  // Cleanup: drop subscribers + maps so later tests / runner see no residue.
  for (const sub of [...fan.subscribers]) { try { sub.res.emit("close"); } catch {} }
  tunnel.tunnels.clear();
  tunnel.pending.clear();
  tunnel.sseFanout.clear();
});

test("gateway-tunnel: non-SSE paths still open separate upstreams", () => {
  const { EventEmitter } = require("node:events");
  tunnel.tunnels.clear();
  tunnel.pending.clear();
  tunnel.sseFanout.clear();
  const fakeWs = { readyState: 1, send: () => {} };
  tunnel.tunnels.set("tok_test_456", { ws: fakeWs, id: "tun2", name: "t2", lastSeenAt: Date.now(), lastPingSent: 0 });
  const mkRes = () => {
    const r = new EventEmitter();
    r.writeHead = () => {};
    r.write = () => true;
    r.end = () => {};
    return r;
  };
  const mkReq = (p) => Object.assign(new EventEmitter(), { method: "GET", path: p, originalUrl: p, url: p, headers: {}, device: null, rawBody: Buffer.alloc(0) });
  tunnel.proxyHttp(mkReq("/api/state"), mkRes());
  tunnel.proxyHttp(mkReq("/api/state"), mkRes());
  assert.equal(tunnel.sseFanout.size, 0);
  assert.equal(tunnel.pending.size, 2);
  tunnel.tunnels.clear();
  tunnel.pending.clear();
  tunnel.sseFanout.clear();
});

test("gateway-tunnel: extractServerGreeting finds the greeting frame", () => {
  const { extractServerGreeting } = tunnel;
  const greet = Buffer.from('data: {"id":"e1","type":"server.connected","data":{}}\n\n');
  assert.deepEqual(extractServerGreeting(greet), greet);
  // Leading comment frames are skipped; incomplete tail waits for more bytes.
  const mixed = Buffer.concat([Buffer.from(": hello\n\n"), greet]);
  assert.deepEqual(extractServerGreeting(mixed), greet);
  assert.equal(extractServerGreeting(Buffer.from('data: {"id":"e1","type":"server.con')), null);
  assert.equal(extractServerGreeting(Buffer.from(": just-a-comment\n\n")), null);
});

test("gateway-tunnel: captureGreeting assembles split frames, flushGreeting writes once", () => {
  const fan = { subscribers: new Set(), greeting: null, greetBuf: Buffer.alloc(0), greetDone: false };
  const writes = [];
  const mkSub = (ok = true) => ({ res: { write: (c) => { if (!ok) throw new Error("dead"); writes.push(c.toString()); }, end: () => {} }, headersSent: true, greeted: false });
  const a = mkSub(), b = mkSub(), c = { res: { write: () => { throw new Error("no headers yet"); }, end: () => {} }, headersSent: false, greeted: false };
  fan.subscribers.add(a); fan.subscribers.add(b); fan.subscribers.add(c);
  tunnel.captureGreeting(fan, Buffer.from('data: {"id":"e1","type":"server.con'));
  assert.equal(fan.greeting, null, "split frame waits for the rest");
  assert.equal(tunnel.flushGreeting(fan), 0);
  tunnel.captureGreeting(fan, Buffer.from('nected","data":{}}\n\n: heartbeat\n\n'));
  assert.ok(fan.greeting && fan.greeting.includes("server.connected"));
  assert.equal(tunnel.flushGreeting(fan), 2, "only headers-sent subs get it");
  assert.ok(a.greeted && b.greeted && !c.greeted);
  assert.ok(writes.every((w) => w.includes("server.connected")));
  assert.equal(tunnel.flushGreeting(fan), 0, "second flush is a no-op");
  // Oversized stream without a greeting gives up instead of growing forever.
  const big = { subscribers: new Set(), greeting: null, greetBuf: Buffer.alloc(0), greetDone: false };
  tunnel.captureGreeting(big, Buffer.alloc(20 * 1024, 65));
  assert.equal(big.greetDone, true);
  assert.equal(big.greeting, null);
});

test("gateway-tunnel: late fanout subscribers get the greeting replayed", async () => {
  const { EventEmitter } = require("node:events");
  const { WebSocketServer, WebSocket } = require("ws");
  const db = require("../k8s/ai-gateway/db.js");
  tunnel.tunnels.clear();
  tunnel.pending.clear();
  tunnel.sseFanout.clear();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));
  const port = wss.address().port;
  tunnel.setup(wss);
  const tok = db.createTunnelToken({ name: "gwtest-greet" }).token;
  const frames = [];
  const client = new WebSocket(`ws://127.0.0.1:${port}/tunnel?token=${tok}`);
  client.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no hello")), 3000);
    client.on("message", (d) => { try { if (JSON.parse(d.toString()).type === "hello") { clearTimeout(t); resolve(); } } catch {} });
  });
  const sendUp = (obj) => client.send(JSON.stringify(obj));
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const mkPair = () => {
    const res = new EventEmitter();
    res.chunks = []; res.head = null;
    res.writeHead = (s, h) => { res.status = s; res.head = h; };
    res.write = (c) => res.chunks.push(Buffer.from(c));
    res.end = (c) => { if (c) res.chunks.push(Buffer.from(c)); };
    const req = Object.assign(new EventEmitter(), {
      method: "GET", path: "/x", originalUrl: "/x", url: "/x",
      headers: {}, device: null, rawBody: Buffer.alloc(0),
    });
    return { req, res };
  };
  const textOf = (res) => Buffer.concat(res.chunks).toString("utf8");
  const waitFor = async (fn, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out: " + what);
  };
  try {
    // First subscriber opens the single upstream.
    const p1 = mkPair(); p1.req.path = p1.req.originalUrl = p1.req.url = "/s/sess_a/api/event";
    tunnel.proxyHttp(p1.req, p1.res);
    await waitFor(() => frames.some((f) => f.type === "request"), "upstream open");
    const upId = frames.find((f) => f.type === "request").id;
    assert.equal(tunnel.pending.size, 1);
    sendUp({ type: "response", id: upId, status: 200, headers: { "content-type": "text/event-stream" } });
    await waitFor(() => p1.res.status === 200, "sub1 headers");
    // Comment-only chunk: streamed, but no greeting yet.
    sendUp({ type: "response-data", id: upId, data: b64(": hello\n\n") });
    await waitFor(() => textOf(p1.res).includes("hello"), "sub1 comment");
    // Second subscriber attaches live but before the greeting: headers, no greeting.
    const p2 = mkPair(); p2.req.path = p2.req.originalUrl = p2.req.url = "/s/sess_b/api/event";
    tunnel.proxyHttp(p2.req, p2.res);
    await waitFor(() => p2.res.status === 200, "sub2 headers");
    assert.ok(!textOf(p2.res).includes("server.connected"), "no greeting before it arrives upstream");
    // Greeting split across two frames: both early subs get the replay.
    sendUp({ type: "response-data", id: upId, data: b64('data: {"id":"e1","type":"server.con') });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!textOf(p1.res).includes("server.connected"), "split greeting waits for the rest");
    sendUp({ type: "response-data", id: upId, data: b64('nected","data":{}}\n\n') });
    await waitFor(() => textOf(p1.res).includes("server.connected") && textOf(p2.res).includes("server.connected"), "greeting replayed to both");
    // Third subscriber attaches after caching: headers + greeting immediately,
    // with zero new upstream traffic.
    const nUp = frames.filter((f) => f.type === "request").length;
    const p3 = mkPair(); p3.req.path = p3.req.originalUrl = p3.req.url = "/s/sess_c/api/event";
    tunnel.proxyHttp(p3.req, p3.res);
    await waitFor(() => p3.res.status === 200 && textOf(p3.res).includes("server.connected"), "late sub greeted on attach");
    assert.equal(frames.filter((f) => f.type === "request").length, nUp, "no new upstream for late sub");
    assert.equal(tunnel.pending.size, 1, "still a single upstream");
    assert.equal(tunnel.listSseFanouts()[0].hasGreeting, true);
    for (const p of [p1, p2, p3]) p.res.emit("close");
  } finally {
    try { client.close(); } catch {}
    await new Promise((r) => wss.close(r));
    tunnel.tunnels.clear();
    tunnel.pending.clear();
    tunnel.sseFanout.clear();
  }
});
