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
  // the completion block (widened 6000→8000 when the lane landed, 8000→8600
  // for the stuck-gate try/finally, 2026-10-27; the asserts below unchanged).
  const win = js.slice(i, i + 8600);
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

test("switch-speed: seamless opencode switch syncs window tabs and verifies warm routes without reload", () => {
  // Regression: opencode's client message store (y.run("session.message:" + hid))
  // is a one-shot cache (and SSE session.created marks new chats complete), so
  // switching back to a visited chat or to a newly created chat makes ZERO
  // repeat /message fetches. Waiting only for a new /message fetch timed out
  // after 6s, fell through to paintPane, and spawned a brand-new <iframe>
  // (quitting + re-initializing the opencode window).
  assert.ok(js.includes("function syncOpencodeTabs()"), "syncOpencodeTabs helper must exist");
  assert.ok(js.includes("opencode.window.browser.dat:tabs"), "must seed opencode window tabs store");
  assert.ok(js.includes("opencode.window.browser.dat:tabs.info"), "must seed opencode window tabs.info store");
  assert.ok(js.includes("function isSpaRoutedTo("), "DOM/resource route verifier must exist");
  assert.ok(js.includes("data-titlebar-tab-slot") && js.includes("data-slot=\"tab-link\""),
    "must use opencode's native tab-link + active-tab slot for warm switches");
  const pp = js.slice(js.indexOf("function paintPane"), js.indexOf("function isFrameCached"));
  assert.ok(pp.includes("clientSwitchFrame(p, s)"),
    "paintPane must reuse a live same-port frame instead of creating a second iframe");
  const vf = js.slice(js.indexOf("function visibleWebFrame"), js.indexOf("function clientSwitchFrame"));
  assert.ok(vf.includes("pane._frameCache"), "visibleWebFrame must recover cached frame after PTY detour");
});

test("switch-speed: fresh chats fast-accept without the 6s verify", () => {
  // New-session pain: a just-created chat was never fetched in the live
  // document and has no tab link yet, so strict-only verify (fresh fetch /
  // active tab) burned the full ~6s and fell back to a second document —
  // the blank-iframe + loader gap. clientSwitchSession must detect the fresh
  // case (zero prior resource entries for the hid) and settle-accept on
  // route-hold + mounted chat well under the strict deadline.
  const i = js.indexOf("async function clientSwitchSession");
  assert.ok(i !== -1, "missing clientSwitchSession");
  const win = js.slice(i, js.indexOf("function retargetFrameCache"));
  assert.ok(win.includes("isFresh"), "fresh-chat lane missing");
  assert.ok(/seen === 0 && seenSess === 0/.test(win), "fresh must mean zero prior fetches for the hid");
  assert.ok(win.includes("freshDeadline"), "fresh lane needs its own shorter cap");
  assert.ok(win.includes("settled"), "fresh accept must sustain across a short settle (stale panels swap out)");
  assert.ok(win.includes("Unrecognised route!"), "fresh settle must still reject bad routes");
  assert.ok(win.includes("session-chat-panel") && win.includes("session-composer-dock"),
    "fresh settle must require a mounted chat view");
  // Strict lane intact for visited chats: full timeout + fetch/tab-link verify.
  assert.ok(/Date\.now\(\) > \(isFresh \? freshDeadline : deadline\)/.test(win),
    "visited chats must keep the full strict deadline");
  assert.ok(win.includes("isSpaRoutedTo(w, hid, seen, seenSess)"), "strict fetch/tab-link verify must stay");
});
