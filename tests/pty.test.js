// pty.test.js — exit diagnostics + write-after-exit contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const pty = require("../src/server/pty");

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      let v = null;
      try { v = cond(); } catch {}
      if (v) { clearInterval(iv); resolve(v); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error("timeout")); }
    }, 50);
  });
}

test("exited PTY records code and rejects writes", async () => {
  const key = `test:exit-${Date.now()}`;
  pty.spawn(key, "sh", ["-c", "exit 1"], { cols: 80, rows: 10 });
  const entry = await waitFor(() => {
    const e = pty.get(key);
    return e && e.exited ? e : null;
  }, 5000);
  assert.equal(entry.exitCode, 1);
  assert.equal(pty.write(key, "x"), false);
  pty.kill(key);
  assert.equal(pty.get(key), null);
});

test("zero-exit PTY records code 0", async () => {
  const key = `test:exit0-${Date.now()}`;
  pty.spawn(key, "true", [], { cols: 80, rows: 10 });
  const entry = await waitFor(() => {
    const e = pty.get(key);
    return e && e.exited ? e : null;
  }, 5000);
  assert.equal(entry.exitCode, 0);
  pty.kill(key);
});

test("live PTY accepts writes", async () => {
  const key = `test:live-${Date.now()}`;
  pty.spawn(key, "cat", [], { cols: 80, rows: 10 });
  await new Promise((r) => setTimeout(r, 300));
  const e = pty.get(key);
  assert.ok(e && !e.exited);
  assert.equal(pty.write(key, "hi\n"), true);
  await waitFor(() => pty.get(key) && pty.get(key).backlog.includes("hi"), 5000);
  pty.kill(key);
});
