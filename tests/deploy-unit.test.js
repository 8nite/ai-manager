// tests/deploy-unit.test.js — deployed systemd unit must not sweep workers on restart.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UNIT = path.join(os.homedir(), ".config", "systemd", "user", "ai-manager.service");

test("deploy-unit: service unit uses KillMode=process (web backends survive restart)", () => {
  assert.ok(fs.existsSync(UNIT), `missing unit file: ${UNIT}`);
  const text = fs.readFileSync(UNIT, "utf8");
  assert.ok(/^KillMode=process\s*$/m.test(text),
    "unit must set KillMode=process so restarts signal only the main node process");
  assert.ok(/Restart=always/.test(text), "unit must keep Restart=always");
});

test("deploy-unit: ai-manager ingress retries 502/503/504 (tunnel reconnect window)", () => {
  // Gateway manifests deploy via kubectl and are not part of this repo
  // (see .gitignore); skip on fresh clones that lack k8s/.
  const doc = path.join(__dirname, "..", "k8s", "ai-gateway", "deploy.yaml");
  if (!fs.existsSync(doc)) {
    console.log("skip: k8s/ai-gateway/deploy.yaml absent (gateway deploys separately)");
    return;
  }
  const text = fs.readFileSync(doc, "utf8");
  assert.ok(/proxy-next-upstream:\s*"error timeout http_502 http_503 http_504"/.test(text),
    "ingress must retry error/timeout/502/503/504 against the gateway upstream");
  assert.ok(/proxy-next-upstream-tries:\s*"3"/.test(text),
    "ingress must bound upstream retry tries");
});

test("deploy-unit: server binds AI_MGR_HOST with loopback default", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "server", "index.js"), "utf8");
  assert.ok(/process\.env\.AI_MGR_HOST\s*\|\|\s*"127\.0\.0\.1"/.test(src),
    "index.js must read AI_MGR_HOST with a 127.0.0.1 default");
  assert.ok(/server\.listen\(PORT,\s*HOST/.test(src),
    "index.js must listen on HOST, not a hardcoded address");
});

test("deploy-unit: service unit exposes the UI on all interfaces (AI_MGR_HOST=0.0.0.0)", () => {
  for (const f of [UNIT, path.join(__dirname, "..", "deploy", "ai-manager.service")]) {
    assert.ok(fs.existsSync(f), `missing unit file: ${f}`);
    const text = fs.readFileSync(f, "utf8");
    assert.ok(/^Environment=AI_MGR_HOST=0\.0\.0\.0\s*$/m.test(text),
      `${f} must set Environment=AI_MGR_HOST=0.0.0.0 for LAN access`);
  }
});
