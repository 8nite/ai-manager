// tests/split.test.js — split-screen panes in the main window.
// Static contract: toolbar + grid + per-pane views + proxy api scoping.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");

test("split: toolbar owns vertical/horizontal split + close", () => {
  for (const id of ["paneBar", "paneGrid", "paneCount", "btnSplitCols", "btnSplitRows", "btnClosePane"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const bar = html.indexOf('id="paneBar"');
  const grid = html.indexOf('id="paneGrid"');
  assert.ok(bar !== -1 && grid !== -1 && bar < grid, "toolbar must sit above the pane grid");
});

test("split: frontend pane engine (render/focus/split/close)", () => {
  for (const fn of ["renderPanes", "paintPane", "updatePaneHeaders", "updateEmptyOverlay",
    "focusPane", "addSplitPane", "closePane", "openInSplit", "setPaneSession",
    "attachPaneTerm", "syncLegacyActive", "ensurePane", "savePaneLayout", "restorePaneLayout"]) {
    assert.ok(js.includes(fn), `missing ${fn}`);
  }
  // Sidebar rows + palette can open aside; per-pane views are independent.
  assert.ok(js.includes("sess-split-hover"), "sidebar split-open control missing");
  assert.ok(js.includes("openInSplit"), "openInSplit missing");
  assert.ok(js.includes("pane-frame"), "per-pane iframe missing");
  assert.ok(js.includes("pane-term"), "per-pane terminal missing");
  // No single-view singletons: concurrent panes replaced the shared stage.
  assert.ok(!js.includes('("webview")') && !js.includes("('webview')"), "shared #webview singleton must be gone");
  assert.ok(!js.includes('("termWrap")') && !js.includes("('termWrap')"), "shared #termWrap singleton must be gone");
  assert.ok(!js.includes("state.mainTerm") && !js.includes("state.mainFit"), "shared mainTerm must be per-pane now");
});

test("split: layout persists across reloads", () => {
  assert.ok(js.includes("ai-manager.panes"), "pane layout must persist to localStorage");
  assert.ok(js.includes("ai-manager.layout"), "split direction must persist to localStorage");
});

test("split: pane styles + mobile stacking", () => {
  for (const token of ["#paneGrid", ".pane", ".pane.focused", ".pane-header",
    ".pane-select", ".pane-body", ".pane-frame", ".pane-term", ".pane-empty",
    ".pane-bar", ".pane-btn", ".sess-split-hover"]) {
    assert.ok(css.includes(token), `missing style ${token}`);
  }
});

test("split: proxy api scope keeps concurrent web panes on their backends", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "server", "proxy.js"), "utf8");
  for (const token of ["apiScopeBodyFor", "injectApiScope", "scopeSessionId", "aimgr-api-scope"]) {
    assert.ok(src.includes(token), `proxy.js missing ${token}`);
  }
});

test("split: sidebar switch targets the focused pane, not the newest", () => {
  // Clicks inside a web iframe never bubble pointerdown to the outer
  // document, so focus must track the iframe element itself — otherwise the
  // focused pane stays stuck on the newest split and activateSession (which
  // resolves via getActivePane) lands there instead of the clicked window.
  // Web views live in the per-pane frame cache: every cached frame is wired
  // via attachFrameListeners, and the window blur handler covers the rest.
  assert.ok(js.includes("const pane = getActivePane()"), "activateSession must resolve the focused pane");
  assert.ok(js.includes("function attachFrameListeners"), "frame-cache listener hook missing");
  assert.ok(js.includes('frame.addEventListener("focus"'), "cached frames must move pane focus");
  assert.ok(js.includes('window.addEventListener("blur"'), "window blur must re-check iframe focus");
  assert.ok(js.includes("activeElement"), "blur handler must read document.activeElement");
  assert.ok(js.includes("IFRAME"), "blur handler must only adopt iframe focus");
});

test("split: focused pane drives left-panel selection", () => {
  // focusPane must repaint rows AND the attention shelf so the selected
  // session is always the active window's session.
  const fn = js.slice(js.indexOf("function focusPane"), js.indexOf("function addSplitPane"));
  assert.ok(fn.includes("syncLegacyActive"), "focusPane must sync activeSessionId");
  assert.ok(fn.includes("renderWorkspaces"), "focusPane must repaint sidebar rows");
  assert.ok(fn.includes("renderAttentionShelf"), "focusPane must repaint attention shelf");
});

test("split: sidebar switch focuses the pane already showing the session", () => {
  // Clicking a session that is live in another pane must focus that pane
  // instead of duplicating the view into the focused pane.
  const fn = js.slice(js.indexOf("async function activateSession"), js.indexOf("async function setPaneSession"));
  assert.ok(fn.includes("p.sessionId === id"), "activateSession must detect the live pane");
  assert.ok(fn.includes("focusPane(live.pid)"), "activateSession must focus the live pane");
});

test("split: web views stay cached per pane for instant switch-back", () => {
  // paintPane must keep a few live iframes per pane (show/hide) instead of
  // reloading one shared iframe on every switch.
  for (const token of ["FRAME_CACHE_N", "_frameCache", "purgeSessionFrames", "isFrameCached", "forceFrameReload", "attachFrameListeners"]) {
    assert.ok(js.includes(token), `app.js missing frame-cache helper ${token}`);
  }
  const pp = js.slice(js.indexOf("function paintPane"), js.indexOf("function isFrameCached"));
  assert.ok(pp.includes("cache.get(p.sessionId)"), "paintPane must reuse the cached iframe");
  assert.ok(pp.includes("FRAME_CACHE_N"), "paintPane must evict beyond the keep-N budget");
  assert.ok(pp.includes('classList.remove("hidden")'), "paintPane must show the cached view");
  // Deleted sessions must drop their cached documents everywhere.
  assert.ok(js.includes("purgeSessionFrames(s.id)") || js.includes("purgeSessionFrames(gid)"), "session delete must purge cached frames");
});

test("split: cached healthy sessions skip the loader + blocking ensure", () => {
  const fn = js.slice(js.indexOf("async function setPaneSession"), js.indexOf("// POST terminal input"));
  assert.ok(fn.includes("isFrameCached(pane, id)"), "setPaneSession must detect the cached view");
  assert.ok(fn.includes("hideStageLoader"), "instant path must clear the loader immediately");
  assert.ok(fn.includes("prevPid"), "switch must reload only when the backend pid changed");
  assert.ok(fn.includes("forceFrameReload"), "stale documents must reload after a backend restart");
  assert.ok(fn.includes("ensureP") && fn.includes("touchP"), "slow path must run ensure + touch in parallel");
});

test("split: PTY switch attaches exactly one terminal stream (no EventSource leak)", () => {
  // paintPane already opens the terminal + SSE stream when !p.term, so the
  // PTY branch must not call attachPaneTerm a second time: the overwritten
  // pair leaks an EventSource per switch (regression: N switches left N
  // streams open and only the last tracked).
  const branch = js.slice(js.indexOf("// Overlap for PTY too"), js.indexOf("// POST terminal input"));
  assert.ok(branch.includes("paintPane(pane)"), "PTY branch must paint (single attach point)");
  assert.ok(!branch.includes("attachPaneTerm(pane, id)"), "PTY branch must not re-attach after paintPane");
});

test("split: pane dropdown syncs on switch completion, not next poll", () => {
  // setPaneSession must repaint the per-pane <select> when the switch lands
  // (instant + slow paths) — otherwise the dropdown shows the previous
  // session until the 8s background refresh rebuilds it.
  const fn = js.slice(js.indexOf("async function setPaneSession"), js.indexOf("// POST terminal input"));
  const n = fn.split("updatePaneHeaders()").length - 1;
  assert.ok(n >= 2, `setPaneSession must sync pane headers on both completion paths (found ${n})`);
});

test("split: alternating iframe taps move focus every time (activeElement poll)", () => {
  // Regression: taps inside a web iframe never bubble pointerdown outward,
  // and iframe-to-iframe moves fire neither window blur nor a focus event on
  // the iframe element (verified live: outer activeElement moves silently).
  // The blur/focus listeners cover only the first switch (outer -> iframe);
  // every later alternating tap got stuck. A poll must adopt whichever pane
  // owns document.activeElement.
  const i = js.indexOf("Iframe-to-iframe taps");
  assert.ok(i !== -1, "activeElement poll block missing");
  const block = js.slice(i, js.indexOf("}, 250);", i));
  assert.ok(block.includes("setInterval"), "focus adoption must poll on a timer");
  assert.ok(block.includes("document.activeElement"), "poll must read document.activeElement");
  assert.ok(block.includes("IFRAME"), "poll must only adopt iframe focus");
  assert.ok(block.includes("focusPane(pid)"), "poll must move pane focus to the iframe owner");
});

test("split: programmatic focus sticks despite stale iframe DOM focus", () => {
  // focusPane from outer chrome (sidebar row, palette) must blur a stale
  // iframe holding DOM focus in another pane otherwise the activeElement
  // poll drags focus back within a tick (regression: sidebar selection
  // flipped back after a row click while DOM focus sat in the other web
  // view). Real iframe taps are untouched: the blur is skipped when the
  // target pane owns the focused iframe.
  const fn = js.slice(js.indexOf("function focusPane"), js.indexOf("function addSplitPane"));
  assert.ok(fn.includes('tagName === "IFRAME"'), "focusPane must inspect the focused element");
  assert.ok(fn.includes("ae.blur()"), "focusPane must release stale iframe focus");
  assert.ok(fn.includes("ownerPid !== pid"), "blur must spare the target pane's own iframe");
});
