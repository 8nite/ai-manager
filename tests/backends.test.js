// tests/backends.test.js — harness registry shape.
const test = require("node:test");
const assert = require("node:assert");
const { harnessNames, getHarness } = require("../src/server/backends");

test("backends: opencode/droid/chassis registered with modes", () => {
  assert.deepEqual(harnessNames().sort(), ["agy", "chassis", "droid", "opencode"]);
  assert.equal(getHarness("opencode").mode, "web");
  assert.equal(getHarness("chassis").mode, "web");
  assert.equal(getHarness("agy").mode, "pty");
  assert.equal(getHarness("droid").mode, "pty");
  assert.throws(() => getHarness("nope"), /unknown harness/);
});

test("backends: web args include the allocated port", () => {
  const a = getHarness("opencode").args(4199);
  assert.ok(a.includes("4199"), JSON.stringify(a));
});

test("backends: opencode env pins stable server password (auto-connect)", () => {
  const auth = require("../src/server/opencodeAuth");
  const env = getHarness("opencode").env();
  assert.equal(env.OPENCODE_SERVER_PASSWORD, auth.getPassword());
  assert.ok(env.OPENCODE_SERVER_PASSWORD.length >= 16);
});

test("backends: chassis serve args bind loopback on the allocated port", () => {
  const chassis = getHarness("chassis");
  assert.deepEqual(chassis.args(4123), ["serve", "--hostname", "127.0.0.1", "--port", "4123"]);
});

test("backends: agy defaults to flash-high model, resumes via --conversation", () => {
  const agy = getHarness("agy");
  assert.deepEqual(agy.args(null), ["--model", "gemini-3.8-flash-high"]);
  assert.deepEqual(agy.args("conv-1"), ["--model", "gemini-3.8-flash-high", "--conversation", "conv-1"]);
});

test("backends: agy honors AGY_MODEL + AGY_ARGS overrides", () => {
  const agy = getHarness("agy");
  const prevModel = process.env.AGY_MODEL;
  const prevArgs = process.env.AGY_ARGS;
  try {
    process.env.AGY_MODEL = "gpt-oss-120b-medium";
    assert.deepEqual(agy.args(null), ["--model", "gpt-oss-120b-medium"]);
    process.env.AGY_ARGS = "--model foo --continue";
    assert.deepEqual(agy.args(null), ["--model", "foo", "--continue"]);
    assert.deepEqual(agy.args("conv-9"), ["--model", "foo", "--continue"]);
  } finally {
    if (prevModel === undefined) delete process.env.AGY_MODEL;
    else process.env.AGY_MODEL = prevModel;
    if (prevArgs === undefined) delete process.env.AGY_ARGS;
    else process.env.AGY_ARGS = prevArgs;
  }
});

test("backends: chassis honors CHASSIS_BIN and pins stable server password (auto-connect)", () => {
  const { getHarness } = require("../src/server/backends");
  const auth = require("../src/server/chassisAuth");
  const prevBin = process.env.CHASSIS_BIN;
  try {
    process.env.CHASSIS_BIN = "/tmp/fake-chassis";
    const chassis = getHarness("chassis");
    assert.equal(chassis.bin(), "/tmp/fake-chassis");
    assert.equal(chassis.env().CHASSIS_SERVER_PASSWORD, auth.getPassword());
    assert.ok(chassis.env().CHASSIS_SERVER_PASSWORD.length >= 16);
  } finally {
    if (prevBin === undefined) delete process.env.CHASSIS_BIN;
    else process.env.CHASSIS_BIN = prevBin;
  }
});

test("backends: opencode env routes LLM calls via headroom proxy config", () => {
  const { getHarness } = require("../src/server/backends");
  const prevOff = process.env.AI_MGR_HEADROOM_OFF;
  const prevPort = process.env.HEADROOM_PORT;
  const prevBase = process.env.AI_MGR_HEADROOM_PORT;
  try {
    delete process.env.AI_MGR_HEADROOM_OFF;
    delete process.env.HEADROOM_PORT;
    delete process.env.AI_MGR_HEADROOM_PORT;
    const env = getHarness("opencode").env();
    assert.ok(env.OPENCODE_SERVER_PASSWORD.length >= 16);
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(cfg.provider.anthropic.options.baseURL, "http://127.0.0.1:8787/v1");
    assert.equal(cfg.provider.openai.options.baseURL, "http://127.0.0.1:8787/v1");
    assert.equal(cfg.provider.headroom.npm, "@ai-sdk/openai-compatible");
    assert.ok(cfg.mcp.headroom.enabled);
    if (cfg.plugin) {
      const fs = require("fs");
      assert.ok(fs.existsSync(cfg.plugin[0]), cfg.plugin[0]);
      assert.equal(env.HEADROOM_PROXY_URL, "http://127.0.0.1:8787");
    }
  } finally {
    if (prevOff === undefined) delete process.env.AI_MGR_HEADROOM_OFF;
    else process.env.AI_MGR_HEADROOM_OFF = prevOff;
    if (prevPort === undefined) delete process.env.HEADROOM_PORT;
    else process.env.HEADROOM_PORT = prevPort;
    if (prevBase === undefined) delete process.env.AI_MGR_HEADROOM_PORT;
    else process.env.AI_MGR_HEADROOM_PORT = prevBase;
  }
});

test("backends: opencode headroom routing honors port override and OFF switch", () => {
  const { getHarness, headroomProxyPort } = require("../src/server/backends");
  const keys = ["AI_MGR_HEADROOM_OFF", "HEADROOM_PORT", "AI_MGR_HEADROOM_PORT"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.AI_MGR_HEADROOM_OFF;
    process.env.HEADROOM_PORT = "9999";
    assert.equal(headroomProxyPort(), 9999);
    const cfg = JSON.parse(getHarness("opencode").env().OPENCODE_CONFIG_CONTENT);
    assert.equal(cfg.provider.anthropic.options.baseURL, "http://127.0.0.1:9999/v1");
    process.env.AI_MGR_HEADROOM_OFF = "1";
    const off = getHarness("opencode").env();
    assert.ok(off.OPENCODE_SERVER_PASSWORD.length >= 16);
    assert.equal(off.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(off.HEADROOM_PROXY_URL, undefined);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test("backends: opencode headroom plugin override missing file omits plugin", () => {
  const { headroomOpencodeConfig } = require("../src/server/backends");
  const prev = process.env.HEADROOM_OPENCODE_PLUGIN_PATH;
  try {
    process.env.HEADROOM_OPENCODE_PLUGIN_PATH = "/tmp/does-not-exist-entry.opencode.js";
    const cfg = headroomOpencodeConfig(8787);
    assert.equal(cfg.plugin, undefined);
    assert.ok(cfg.provider.headroom);
  } finally {
    if (prev === undefined) delete process.env.HEADROOM_OPENCODE_PLUGIN_PATH;
    else process.env.HEADROOM_OPENCODE_PLUGIN_PATH = prev;
  }
});

test("backends: opencode headroom plugin resolves to a 2.x directory", () => {
  const fs = require("fs");
  const path = require("path");
  const { headroomOpencodeConfig } = require("../src/server/backends");
  const prev = process.env.HEADROOM_OPENCODE_PLUGIN_PATH;
  try {
    delete process.env.HEADROOM_OPENCODE_PLUGIN_PATH;
    const cfg = headroomOpencodeConfig(8787);
    if (cfg.plugin) {
      const dir = cfg.plugin[0];
      assert.ok(fs.statSync(dir).isDirectory(), dir);
      assert.ok(fs.existsSync(path.join(dir, "index.js")), dir);
    }
  } finally {
    if (prev === undefined) delete process.env.HEADROOM_OPENCODE_PLUGIN_PATH;
    else process.env.HEADROOM_OPENCODE_PLUGIN_PATH = prev;
  }
});
