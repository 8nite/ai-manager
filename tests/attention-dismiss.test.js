// tests/attention-dismiss.test.js — attention shelf × dismiss control.
// Static contract: each Needs-Attention card owns a dismiss button that hides
// the card without deleting the session; the dismiss re-arms on the next
// waiting turn and clears when the session is opened.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");

test("attention-dismiss: dismissed ids live in state + persist to localStorage", () => {
  assert.ok(js.includes("dismissedAttention: new Set()"), "state must own a dismissedAttention set");
  assert.ok(js.includes("ai-manager.dismissedAttention"), "dismissed ids must persist to localStorage");
  assert.ok(js.includes("function loadDismissedAttention"), "boot must load dismissed ids");
  assert.ok(js.includes("function saveDismissedAttention"), "dismiss must save dismissed ids");
});

test("attention-dismiss: shelf cards own a dismiss button that hides without deleting", () => {
  assert.ok(js.includes("shelf-dismiss"), "shelf card must render a dismiss button");
  const shelf = js.slice(js.indexOf("function renderAttentionShelf"), js.indexOf("function renderWorkspaces"));
  assert.ok(shelf.includes("visibleWaiting()"), "shelf must hide dismissed sessions");
  assert.ok(shelf.includes('card.dataset.sess = s.id'), "dismissed card must carry its session id");
  assert.ok(shelf.includes('title="Dismiss"'), "dismiss button must be titled");
  assert.ok(shelf.includes('aria-label="Dismiss attention'), "dismiss button must be labelled for AT");
  assert.ok(shelf.includes("stopPropagation"), "dismiss click must not activate the session");
  assert.ok(shelf.includes("dismissAttention(s.id)"), "dismiss click must hide the card");
  assert.ok(!shelf.includes("/api/sessions"), "dismiss must not delete the session");
});

test("attention-dismiss: dismiss repaints shelf, dashboard, and badge", () => {
  const fn = js.slice(js.indexOf("function dismissAttention"), js.indexOf("function visibleWaiting"));
  for (const token of ["dismissedAttention.add", "saveDismissedAttention", "renderAttentionShelf", "renderDash", "updateCounts"]) {
    assert.ok(fn.includes(token), `dismissAttention must ${token}`);
  }
});

test("attention-dismiss: dismiss re-arms when the session leaves waiting", () => {
  const fn = js.slice(js.indexOf("function pruneDismissedAttention"), js.indexOf("function dismissAttention"));
  assert.ok(fn.includes("activity"), "prune must compare against live waiting ids");
  assert.ok(fn.includes("dismissedAttention.delete"), "prune must drop re-armed ids");
  const refresh = js.slice(js.indexOf("async function refresh"), js.indexOf("async function health"));
  assert.ok(refresh.includes("pruneDismissedAttention()"), "refresh must prune dismissed ids on every poll");
});

test("attention-dismiss: opening the session clears its dismiss", () => {
  const fn = js.slice(js.indexOf("async function activateSession"), js.indexOf("async function setPaneSession"));
  assert.ok(fn.includes("dismissedAttention.delete(id)"), "activateSession must undismiss the opened session");
});

test("attention-dismiss: badge + dashboard follow the visible set", () => {
  const counts = js.slice(js.indexOf("function updateCounts"), js.indexOf("// Format idle"));
  assert.ok(counts.includes("visibleWaiting()"), "wait badge must count undismissed sessions only");
  const dash = js.slice(js.indexOf("function renderDash"), js.indexOf("// ---------- SPLIT-SCREEN PANES"));
  assert.ok(dash.includes("visibleWaiting()"), "dashboard attention feed must hide dismissed sessions");
});

test("attention-dismiss: dismiss button styling + touch visibility", () => {
  for (const token of [".shelf-dismiss", ".shelf-card:hover .shelf-dismiss", ".shelf-card:focus-within .shelf-dismiss"]) {
    assert.ok(css.includes(token), `missing style ${token}`);
  }
  const touch = css.slice(css.indexOf(".shelf-dismiss"));
  assert.ok(touch.includes("768px") && touch.includes(".shelf-dismiss"), "dismiss must stay visible on touch (no hover)");
});

test("attention-dismiss: keyboard on the dismiss button must not activate", () => {
  const shelf = js.slice(js.indexOf("function renderAttentionShelf"), js.indexOf("function renderWorkspaces"));
  assert.ok(shelf.includes('e.target.closest(".shelf-dismiss")'), "card keydown must ignore the dismiss button");
});

test("attention-dismiss: boot restores dismissed ids before first paint", () => {
  const boot = js.slice(js.indexOf("(async function boot()"));
  assert.ok(boot.includes("loadDismissedAttention()"), "boot must restore dismissed ids");
  assert.ok(
    boot.indexOf("loadDismissedAttention()") < boot.indexOf("await refresh()"),
    "dismissed ids must load before the first state poll paints"
  );
});
