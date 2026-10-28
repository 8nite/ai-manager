// tests/opencode-auto-update.test.js — cron must not report failure when already current.
// Regression: 2026-10-25 cron compared CURRENT="v2.1.4" (opencode --version,
// v-prefixed) against LATEST="2.1.4" (update API, unprefixed), so the
// up-to-date early-exit never fired and the post-upgrade check failed
// spuriously ("version still v2.1.4 after upgrade (want 2.1.4)").
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "opencode-auto-update.sh");

test("opencode-auto-update: strips v-prefix from CURRENT/AFTER before comparing to LATEST", () => {
  assert.ok(fs.existsSync(SCRIPT), `missing script: ${SCRIPT}`);
  const text = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(text.includes('CURRENT="${CURRENT#v}"'),
    "script must normalize CURRENT (${CURRENT#v}) so 'v2.1.4' equals API '2.1.4'");
  assert.ok(text.includes('AFTER="${AFTER#v}"'),
    "script must normalize AFTER (${AFTER#v}) so the post-upgrade check compares like with like");
});

test("opencode-auto-update: v-prefixed binary version equals unprefixed API version after normalization", () => {
  // Simulate: `opencode --version` -> "opencode v2.1.4", API -> "2.1.4".
  let CURRENT = "v2.1.4"; CURRENT = CURRENT.replace(/^v/, "");
  const LATEST = "2.1.4".replace(/^v/, "");
  assert.strictEqual(CURRENT, LATEST, "normalized versions must compare equal (early-exit path)");
  let AFTER = "v2.1.4"; AFTER = AFTER.replace(/^v/, "");
  assert.strictEqual(AFTER, LATEST, "normalized AFTER must equal LATEST (post-upgrade check)");
});
