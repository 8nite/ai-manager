// tests/activity.test.js — attention-state matrix for activityFor().
const test = require("node:test");
const assert = require("node:assert");
const sessions = require("../src/server/sessions");

const NOW = 1_000_000;

test("activity: web sessions mirror process status", () => {
  assert.equal(sessions.activityFor({ mode: "web", status: "running" }).activity, "running");
  assert.equal(sessions.activityFor({ mode: "web", status: "starting" }).activity, "starting");
  assert.equal(sessions.activityFor({ mode: "web", status: "error" }).activity, "error");
  assert.equal(sessions.activityFor({ mode: "web", status: "exited" }).activity, "finished");
});

test("activity: pty working while output is fresh", () => {
  const a = sessions.activityFor(
    { mode: "pty" }, { exited: false, lastOutputAt: NOW - 2000 }, NOW);
  assert.equal(a.activity, "working");
});

test("activity: pty waiting once quiet past the window", () => {
  const a = sessions.activityFor(
    { mode: "pty" }, { exited: false, lastOutputAt: NOW - 60_000 }, NOW);
  assert.equal(a.activity, "waiting");
  assert.equal(a.idleMs, 60_000);
});

test("activity: exited or missing PTY is finished", () => {
  assert.equal(sessions.activityFor({ mode: "pty" }, { exited: true }).activity, "finished");
  assert.equal(sessions.activityFor({ mode: "pty" }, null).activity, "finished");
});
