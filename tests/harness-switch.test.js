// tests/harness-switch.test.js — top-bar harness switch owns the default harness;
// New Session buttons create one-click via quickCreateSession (no modal popup).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");

test("harness-switch: top bar carries a 4-option harness switch", () => {
  assert.ok(html.includes('id="harnessSwitch"'), "missing #harnessSwitch");
  // Switch lives in the top-right cluster (before the New Session button).
  const topRight = html.indexOf('class="top-right"');
  const sw = html.indexOf('id="harnessSwitch"');
  const btn = html.indexOf('id="btnNewSessionTop"');
  assert.ok(topRight !== -1 && sw > topRight && btn > sw, "switch must sit top-right, before New Session");
  for (const h of ["opencode", "droid", "chassis", "agy"]) {
    assert.ok(html.includes(`data-harness="${h}"`), `switch missing option ${h}`);
  }
  assert.ok(html.includes('class="hs-btn sel"'), "one switch option pre-selected");
});

test("harness-switch: no Launch New AI Session popup remains", () => {
  assert.ok(!html.includes('id="modal"'), "new-session #modal must be removed");
  assert.ok(!html.includes("Launch New AI Session"), "modal title must be gone");
  assert.ok(!js.includes("openModal"), "openModal must be gone (use quickCreateSession)");
  assert.ok(!js.includes("submitModal"), "submitModal must be gone (use quickCreateSession)");
  assert.ok(js.includes("quickCreateSession"), "missing quickCreateSession one-click create");
});

test("harness-switch: frontend persists selection and feeds quick-create", () => {
  assert.ok(js.includes("getSelectedHarness"), "missing getSelectedHarness");
  assert.ok(js.includes("setSelectedHarness"), "missing setSelectedHarness");
  assert.ok(js.includes("ai-manager.harness"), "selection must persist to localStorage");
  assert.ok(js.includes("#harnessSwitch .hs-btn"), "switch buttons must be wired");
  // quickCreateSession reads the switch value directly; no modal hidden field.
  assert.ok(/quickCreateSession[\s\S]*?getSelectedHarness\(\)/.test(js), "quickCreateSession must read the switch pick");
  assert.ok(!js.includes('id="fHarness"') && !html.includes('id="fHarness"'), "hidden #fHarness must be gone with the modal");
});

test("harness-switch: switch styled + compact on small screens", () => {
  assert.ok(css.includes(".harness-switch"), "missing .harness-switch style");
  assert.ok(css.includes(".hs-btn.sel"), "missing selected-state style");
  assert.ok(css.includes(".hs-btn"), "missing .hs-btn style");
});

test("harness-switch: agy (antigravity CLI) is a first-class switch option", () => {
  assert.ok(html.includes('data-harness="agy"'), "switch missing agy option");
  assert.ok(html.includes("Antigravity"), "agy option should name Antigravity");
  assert.ok(js.includes('"agy"'), "HARNESS_NAMES must include agy");
  assert.ok(css.includes('[data-harness="agy"]'), "agy needs selected-state style");
  assert.ok(css.includes(".tag.agy"), "agy needs a session tag style");
  assert.ok(css.includes("--harness-agy"), "agy needs brand color vars");
});

test("harness-switch: chassis (coding-agent web harness) is a first-class switch option", () => {
  assert.ok(html.includes('data-harness="chassis"'), "switch missing chassis option");
  assert.ok(html.includes("Coding agent"), "chassis option should name its profile");
  assert.ok(js.includes('"chassis"'), "HARNESS_NAMES must include chassis");
  assert.ok(js.includes("frameSrcFor"), "web deep-link src helper present");
  assert.ok(css.includes('[data-harness="chassis"]'), "chassis needs selected-state style");
  assert.ok(css.includes(".tag.chassis"), "chassis needs a session tag style");
  assert.ok(css.includes("--harness-chassis"), "chassis needs brand color vars");
  assert.ok(!html.includes('data-harness="lumina"'), "lumina option removed from switch");
  assert.ok(!js.includes('"lumina"'), "HARNESS_NAMES must not include lumina");
});

test("harness-switch: frontend HARNESS_NAMES matches the backend registry", () => {
  // Regression (2026-11-06): a harness swap shipped without a version bump,
  // so stale tabs ran immutable-cached app.js whose HARNESS_NAMES rejected
  // the new switch option (silent no-op in setSelectedHarness). Source-level
  // parity is asserted here; the ?v= pin forces refetch across deploys.
  const { harnessNames } = require("../src/server/backends");
  const m = js.match(/const HARNESS_NAMES = \[([^\]]*)\]/);
  assert.ok(m, "HARNESS_NAMES declaration present in app.js");
  const front = m[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean).sort();
  assert.deepEqual(front, harnessNames().sort(), "frontend/backend harness sets must agree");
});
