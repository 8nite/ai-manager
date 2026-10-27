"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ov = require("../src/server/harnessOverlay");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hov-"));
}
function promotedFixture() {
  const root = tmp();
  const dir = path.join(root, "promoted", "nightly-brief");
  const base = { "guardrails.md": "base rules\n", "systemprompt.md": "base prompt\n" };
  const adopted = {
    "guardrails.md": "base rules\n- When briefing, load the `brief-check` skill.\n",
    "systemprompt.md": "base prompt\n",
    "skills/brief-check/SKILL.md": "---\nname: brief-check\ndescription: Checks briefs.\n---\n# check\n",
  };
  for (const [sub, tree] of [["tree", adopted], ["base", base]]) {
    for (const [rel, body] of Object.entries(tree)) {
      const p = path.join(dir, sub, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
  fs.writeFileSync(path.join(dir, "PROMOTED.json"), JSON.stringify({
    fingerprint: "abc123def456", time: 1792800000,
  }));
  return { root, dir, base, adopted };
}

test("buildBlock emits adopted-minus-base delta only", () => {
  const { base, adopted } = promotedFixture();
  const b = ov.buildBlock("nightly-brief", "abc123def456", adopted, base, "2026-10-24");
  assert.match(b, /aimgr-harness:begin nightly-brief@abc123def456/);
  assert.match(b, /brief-check/);
  assert.match(b, /When briefing/);
  assert.doesNotMatch(b, /base prompt/);
  assert.match(b, /Promoted 2026-10-24/);
});

test("buildBlock is empty when adopted equals base", () => {
  const { base } = promotedFixture();
  assert.equal(ov.buildBlock("d", "fp", { ...base }, base, ""), "");
});

test("applyOverlay appends without touching user content, idempotent", () => {
  const d = tmp();
  const f = path.join(d, "AGENTS.md");
  fs.writeFileSync(f, "# mine\n");
  const block = "<!-- aimgr-harness:begin d@fp -->\nX\n<!-- aimgr-harness:end -->\n";
  assert.deepEqual(ov.applyOverlay(f, block).action, "applied");
  assert.ok(fs.readFileSync(f, "utf8").startsWith("# mine\n"));
  assert.deepEqual(ov.applyOverlay(f, block).action, "current");
});

test("applyOverlay refreshes on fingerprint change, strips to byte-identical", () => {
  const d = tmp();
  const f = path.join(d, "AGENTS.md");
  fs.writeFileSync(f, "# mine\n");
  const b1 = "<!-- aimgr-harness:begin d@fp1 -->\nX\n<!-- aimgr-harness:end -->\n";
  const b2 = "<!-- aimgr-harness:begin d@fp2 -->\nY\n<!-- aimgr-harness:end -->\n";
  ov.applyOverlay(f, b1);
  assert.deepEqual(ov.applyOverlay(f, b2).action, "refreshed");
  assert.match(fs.readFileSync(f, "utf8"), /fp2/);
  assert.deepEqual(ov.applyOverlay(f, "").action, "removed");
  assert.equal(fs.readFileSync(f, "utf8"), "# mine\n");
});

test("applyOverlay creates AGENTS.md when missing", () => {
  const d = tmp();
  const f = path.join(d, "AGENTS.md");
  const r = ov.applyOverlay(f, "<!-- aimgr-harness:begin d@fp -->\nX\n<!-- aimgr-harness:end -->\n");
  assert.deepEqual(r.action, "applied");
  assert.ok(fs.existsSync(f));
});

test("readMarker validates names, rejects traversal", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, ov.MARKER), "nightly-brief\n");
  assert.equal(ov.readMarker(d), "nightly-brief");
  fs.writeFileSync(path.join(d, ov.MARKER), "../../etc\n");
  assert.equal(ov.readMarker(d), null);
  assert.equal(ov.readMarker(path.join(d, "nope")), null);
});

test("maybeApply end-to-end: marker + promoted -> block; no marker cleans", () => {
  const { root } = promotedFixture();
  process.env.AI_MGR_HARNESS_WORK = root;
  try {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# ws\n");
    // no marker yet: untouched
    assert.deepEqual(ov.maybeApplyHarnessOverlay(ws).reason, "no-marker");
    assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), "# ws\n");
    // opt in: delta-only block applied
    fs.writeFileSync(path.join(ws, ov.MARKER), "nightly-brief");
    const r = ov.maybeApplyHarnessOverlay(ws);
    assert.equal(r.reason, "applied");
    const body = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
    assert.ok(body.startsWith("# ws\n"));
    assert.match(body, /brief-check/);
    // unknown domain: skipped, never throws
    fs.writeFileSync(path.join(ws, ov.MARKER), "nope-domain");
    assert.deepEqual(ov.maybeApplyHarnessOverlay(ws).reason, "not-promoted");
    // marker removed: stale block cleaned
    fs.writeFileSync(path.join(ws, ov.MARKER), "nightly-brief");
    ov.maybeApplyHarnessOverlay(ws);
    fs.unlinkSync(path.join(ws, ov.MARKER));
    assert.deepEqual(ov.maybeApplyHarnessOverlay(ws).reason, "cleaned");
    assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), "# ws\n");
  } finally {
    delete process.env.AI_MGR_HARNESS_WORK;
  }
});

test("kill switch disables everything", () => {
  process.env.AI_MGR_HARNESS_OVERLAY = "0";
  try {
    assert.deepEqual(ov.maybeApplyHarnessOverlay(tmp()).reason, "killed");
  } finally {
    delete process.env.AI_MGR_HARNESS_OVERLAY;
  }
});
