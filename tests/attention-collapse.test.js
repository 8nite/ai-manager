// tests/attention-collapse.test.js — Needs Attention collapse/expand.
// Static contract: the sidebar shelf header + dashboard attention feed share
// one persisted collapsed flag; collapsed keeps the header (with count) and
// hides the cards; the flag restores before the first paint.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "src", "public", "index.html"), "utf8");

test("attention-collapse: collapsed flag lives in state + persists to localStorage", () => {
  assert.ok(js.includes("attentionCollapsed: false"), "state must own an attentionCollapsed flag");
  assert.ok(js.includes("ai-manager.attentionCollapsed"), "collapsed flag must persist to localStorage");
  assert.ok(js.includes("function loadAttentionCollapsed"), "boot must load the collapsed flag");
  assert.ok(js.includes("function saveAttentionCollapsed"), "toggle must save the collapsed flag");
  assert.ok(js.includes("function toggleAttentionCollapsed"), "a shared toggle must flip the flag");
});

test("attention-collapse: shelf header is a toggle button with count + caret", () => {
  const shelf = js.slice(js.indexOf("function renderAttentionShelf"), js.indexOf("function renderWorkspaces"));
  assert.ok(shelf.includes("shelf-toggle"), "shelf header must be a toggle control");
  assert.ok(shelf.includes("<button"), "shelf header must render as a button for keyboard/AT");
  assert.ok(shelf.includes('aria-expanded'), "toggle must expose aria-expanded");
  assert.ok(shelf.includes('class="caret"'), "toggle must render a caret like workspace groups");
  assert.ok(shelf.includes("Needs Attention (${waiting.length})"), "collapsed header must keep the waiting count");
  assert.ok(shelf.includes("toggleAttentionCollapsed()"), "header click must flip the flag");
});

test("attention-collapse: collapsed shelf hides cards but keeps signalling", () => {
  const shelf = js.slice(js.indexOf("function renderAttentionShelf"), js.indexOf("function renderWorkspaces"));
  assert.ok(shelf.includes("attentionCollapsed"), "shelf render must respect the collapsed flag");
  assert.ok(shelf.includes('classList.toggle("collapsed"'), "shelf must carry a collapsed class");
  assert.ok(shelf.includes("if (state.attentionCollapsed) return"), "collapsed shelf must skip card render");
  assert.ok(css.includes(".attention-shelf.collapsed .shelf-card"), "collapsed shelf must hide cards by style");
  assert.ok(css.includes(".attention-shelf.collapsed .caret"), "collapsed shelf must rotate the caret");
});

test("attention-collapse: toggle repaints shelf + dashboard and persists", () => {
  const fn = js.slice(js.indexOf("function toggleAttentionCollapsed"), js.indexOf("function visibleWaiting"));
  for (const token of ["attentionCollapsed = !state.attentionCollapsed", "saveAttentionCollapsed", "renderAttentionShelf", "renderDash"]) {
    assert.ok(fn.includes(token), `toggleAttentionCollapsed must ${token}`);
  }
});

test("attention-collapse: dashboard feed collapses on the same flag", () => {
  assert.ok(html.includes('id="dashAttentionToggle"'), "dashboard feed needs a toggle control");
  assert.ok(html.includes('aria-controls="dashAttentionList"'), "dashboard toggle must own the feed list");
  const dash = js.slice(js.indexOf("function renderDash"), js.indexOf("// ---------- SPLIT-SCREEN PANES"));
  assert.ok(dash.includes("attentionCollapsed"), "dashboard render must respect the collapsed flag");
  assert.ok(dash.includes('classList.toggle("collapsed"'), "dashboard section must carry a collapsed class");
  assert.ok(dash.includes("dashAttentionToggle"), "dashboard render must sync the toggle state");
  assert.ok(css.includes("#dashAttentionSection.collapsed #dashAttentionList"), "collapsed feed must hide the grid");
  assert.ok(css.includes("#dashAttentionSection.collapsed .caret"), "collapsed feed must rotate the caret");
});

test("attention-collapse: boot restores the flag before first paint", () => {
  const boot = js.slice(js.indexOf("(async function boot()"));
  assert.ok(boot.includes("loadAttentionCollapsed()"), "boot must restore the collapsed flag");
  assert.ok(
    boot.indexOf("loadAttentionCollapsed()") < boot.indexOf("await refresh()"),
    "collapsed flag must load before the first state poll paints"
  );
  assert.ok(boot.includes("dashAttentionToggle"), "boot must wire the dashboard toggle");
});
