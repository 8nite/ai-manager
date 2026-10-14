// tests/tunnel-watchdog.test.js — tunnel stall watchdog recycles half-open
// sockets before browsers hit the opencode frontend's 60s headers timeout.
const test = require("node:test");
const assert = require("node:assert");

process.env.TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || "test-token";
const {
  shouldRecycleTunnel,
  SEND_STALL_LIMIT,
  SEND_STALL_MS,
  SILENT_RECYCLE_MS,
} = require("../scripts/ai-tunnel.js");

test("tunnel-watchdog: healthy socket is left alone", () => {
  assert.strictEqual(
    shouldRecycleTunnel({ bufferedAmount: 0, stalledMs: 0, silentMs: 1000 }),
    null
  );
});

test("tunnel-watchdog: send stall over limit recycles", () => {
  const reason = shouldRecycleTunnel({
    bufferedAmount: SEND_STALL_LIMIT + 1024,
    stalledMs: SEND_STALL_MS + 1000,
    silentMs: 0,
  });
  assert.ok(typeof reason === "string" && /stalled/.test(reason), `got: ${reason}`);
});

test("tunnel-watchdog: buffered spike under the time threshold does not recycle", () => {
  assert.strictEqual(
    shouldRecycleTunnel({
      bufferedAmount: SEND_STALL_LIMIT * 3,
      stalledMs: SEND_STALL_MS - 1000,
      silentMs: 0,
    }),
    null
  );
});

test("tunnel-watchdog: prolonged silence recycles (half-open suspected)", () => {
  const reason = shouldRecycleTunnel({
    bufferedAmount: 0,
    stalledMs: 0,
    silentMs: SILENT_RECYCLE_MS + 1000,
  });
  assert.ok(typeof reason === "string" && /silent/.test(reason), `got: ${reason}`);
});
