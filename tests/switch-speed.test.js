// tests/switch-speed.test.js — session switching + creation must feel instant.
//
// Root causes fixed (2026-10-12, all verified against the isolated rig):
//   1. setPaneSession checked isFrameCached AFTER paintPane — but painting a
//      cache miss creates + connects the new frame, so the "instant" branch
//      always won and the loader path was dead code (cold switches showed a
//      blank frame with zero feedback). The check is now snapshotted BEFORE
//      paint (wasCached).
//   2. A fresh iframe fires load for its about:blank document (~10ms),
//      which hid the stage loader long before the backend document arrived.
//      Load handlers now ignore about:blank commits.
//   3. quickCreateSession awaited a blocking refresh() after the (slow,
//      backend-booting) POST with no click feedback. It now shows the stage
//      loader first, merges the POST result directly, and refreshes in the
//      background.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");

function fnBody(name) {
  const i = js.indexOf(`function ${name}(`);
  assert.ok(i !== -1, `missing function ${name}`);
  // Slice to the next top-level function is overkill; callers below bound
  // their searches to generous but finite windows instead.
  return { i };
}

test("switch-speed: instant path uses a pre-paint cache snapshot", () => {
  const { i } = fnBody("setPaneSession");
  const win = js.slice(i, i + 3000);
  const snap = win.indexOf("wasCached");
  const paint = win.indexOf("paintPane(pane)");
  const branch = win.indexOf("wasCached && s.status");
  assert.ok(snap !== -1 && paint !== -1 && branch !== -1, "wasCached snapshot + paint + branch must exist");
  assert.ok(snap < paint, "cache snapshot must precede paintPane (post-paint checks always hit)");
  assert.ok(paint < branch, "instant branch must run after paint");
  assert.ok(!/isFrameCached\(pane, id\) && s\.status/.test(win), "instant branch must not re-probe the cache after paint");
});

test("switch-speed: iframe load handlers ignore about:blank commits", () => {
  const { i } = fnBody("attachFrameListeners");
  const win = js.slice(i, i + 1500);
  assert.ok(win.includes("about:blank"), "cache-frame load handler must guard about:blank");
  assert.ok(win.includes("hideStageLoader"), "handler must still hide the loader on real loads");
});

test("switch-speed: quick-create shows progress, merges, refreshes in background", () => {
  const { i } = fnBody("quickCreateSession");
  const win = js.slice(i, i + 2500);
  const show = win.indexOf("showStageLoader");
  const post = win.indexOf('"/api/sessions"');
  const merge = win.indexOf("state.sessions.unshift(s)");
  const bg = win.indexOf("refresh();");
  const blocking = win.indexOf("await refresh()");
  assert.ok(show !== -1 && post !== -1 && show < post, "loader must show before the boot-blocking POST");
  assert.ok(merge !== -1 && merge > post, "POST result must merge into state directly");
  assert.ok(bg !== -1, "refresh must still run to converge the rest");
  assert.ok(blocking === -1, "refresh must not block activation (background it)");
});

test("switch-speed: narration observes synchronously, never after awaited work", () => {
  // Regression (narrate e2e "focused feed missing"): the slow path observed
  // at the END, so its buffer-clear wiped content fed between click and
  // ensure resolution. Observe must run synchronously with the switch
  // intent; the iframe load handler re-targets on the real document commit.
  const { i } = fnBody("setPaneSession");
  // Window covers the whole switch flow incl. the client-side nav lane and
  // the completion block (widened 6000→8000 when the lane landed, 2026-10-13;
  // the asserts below are unchanged).
  const win = js.slice(i, i + 8000);
  const early = win.indexOf("observeActivePane();\n\n  const s = state.sessions.find");
  assert.ok(early !== -1, "setPaneSession must observe right after paint, before session lookup");
  const firstAwait = win.indexOf("await ");
  assert.ok(early < firstAwait, "observe must precede the first await");
  const tail = win.lastIndexOf("if (!stale()) {");
  assert.ok(tail !== -1, "completion block must exist");
  assert.ok(!win.slice(tail, tail + 600).includes("observeActivePane"),
    "completion block must not re-observe (would wipe feeds buffered mid-switch)");
});

test("switch-speed: cold same-backend nav runs before ensure resolves", () => {
  // Regression (opencode-desk comparison): the client-side nav lane ran only
  // AFTER the awaited ensure, so every cold same-backend switch paid ensure
  // latency before any visual change. The fast lane must attempt the SPA
  // route push first while ensure heals in the background; the post-ensure
  // lane stays for bindings ensure just backfilled (guarded by navTried so a
  // failed verify never burns a second ~6s poll).
  const i = js.indexOf("async function setPaneSession");
  assert.ok(i !== -1, "missing setPaneSession");
  const win = js.slice(i, js.indexOf("// POST terminal input", i));
  assert.ok(win.includes("Fast nav lane"), "fast nav lane block missing");
  const firstNavAwait = win.indexOf("await tryClientSwitch(pane, s, id, stale)");
  const ensureAwait = win.indexOf("fresh = await ensureP");
  assert.ok(firstNavAwait !== -1 && ensureAwait !== -1, "both lanes must exist");
  assert.ok(firstNavAwait < ensureAwait, "client nav must precede the awaited ensure on the cold path");
  assert.ok(win.includes("navTried"), "post-ensure lane must skip when the fast lane already tried");
  assert.ok(win.includes("forceFrameReload(f, id)"), "background ensure must reload on backend pid change");
});

test("switch-speed: sidebar reconciles rows without wholesale rebuild", () => {
  // The 8s poll + every switch/focus rebuilt #wsList via el.innerHTML = "",
  // destroying rename inputs, hover-button click targets, and flickering the
  // active row. Groups + rows must now be keyed (data-ws / data-sess),
  // reordered in place, and skipped via signatures when unchanged.
  const i = js.indexOf("function renderWorkspaces()");
  assert.ok(i !== -1, "missing renderWorkspaces");
  const win = js.slice(i, js.indexOf("function startRename", i));
  assert.ok(!win.includes('el.innerHTML = "";'), "wholesale sidebar clear must be gone");
  assert.ok(win.includes("dataset.ws") && win.includes("dataset.sess"), "groups + rows must be keyed");
  assert.ok(win.includes("insertBefore"), "reconcile must reorder nodes in place");
  assert.ok(win.includes("_sig"), "unchanged rows/headers must skip via signature");
  assert.ok(win.includes("updateSessRow") && win.includes("wireSessRow"), "row update + one-time wiring helpers must exist");
  // Same-structure updates must patch text nodes, never rebuild the row.
  const u = js.slice(js.indexOf("function updateSessRow"), js.indexOf("function updateSessRow") + 3000);
  assert.ok(u.includes("childElementCount"), "fresh rows must still build content");
  assert.ok(/querySelector\(":scope > \.lbl"\)/.test(u), "label updates must patch in place");
});

test("switch-speed: row-click switch skips the optimistic paint when the nav lane is eligible", () => {
  // Regression (e2e "detour missed second chat"): activateSession painted
  // optimistically before setPaneSession, materializing a blank iframe that
  // the fast nav lane then navigated instead of the live app (6s verify on
  // a document about to be replaced, switch stalled). The paint must be
  // skipped when clientSwitchFrame already qualifies; setPaneSession paints
  // on every lane that needs a document (warm cache, full load).
  const i = js.indexOf("async function activateSession");
  assert.ok(i !== -1, "missing activateSession");
  const win = js.slice(i, js.indexOf("async function setPaneSession", i));
  assert.ok(win.includes("clientSwitchFrame(pane, pre)"), "activateSession must probe lane eligibility pre-paint");
  assert.ok(win.includes("if (!navFirst) paintPane(pane)"), "optimistic paint must be skipped for the nav lane");
});
