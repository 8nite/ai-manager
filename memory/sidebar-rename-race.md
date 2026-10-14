---
name: sidebar-rename-race
description: Left-panel rename vs session activation render/focus race (2026-10-10)
date_modified: 2026-10-10
tags: [frontend, rename, race, app.js]
links: [[browser-automation]]
---

# Sidebar rename vs activation race

Symptom (2026-10-10): renaming a session in the left panel "doesn't work" —
the edit box flashes and dies, name unchanged, no error. Repro: double-click
an **inactive** row (two `activateSession` clicks + `startRename`).

Two killers, both in `src/public/app.js`:

1. `activateSession`'s post-`ensure`/`touch` `renderWorkspaces()` rebuilt the
   list unconditionally, destroying the just-opened rename `<input>`.
   `refresh()` already skipped re-renders while `state.renamingId` is set;
   `activateSession` didn't. Fix: `if (!state.renamingId) renderWorkspaces();`
   (session-bar render left unconditional — harmless to the sidebar input).
2. `attachMainTerm` ended with `state.mainTerm.focus()`, stealing focus off
   the rename input → `blur` → `commitRename` with unchanged text → silent
   cancel. Fix: `if (!state.renamingId) state.mainTerm.focus();`.

Blur-commit design note: destroying the focused input fires `commitRename`,
which early-returns only when `renamingId` was already cleared. Clicking another row
mid-rename therefore *commits* the partial text to the correct session
(consistent with click-away blur-commit); switching sessions does not strand
the edit. The sibling hazard (session-bar rename committed to the *new*
`activeSessionId` after a mid-edit switch) is pre-existing, unreported, left
alone — see `commitBarRename`.

Regression coverage:

- `tests/sessions.test.js`: `renameSession` trim/collapse/persist + rejections
  (unknown/empty/overlong). (Backend PATCH was always fine; bug was frontend.)
- `scripts/e2e-web-defaults.sh`: API 400-on-empty + browser dblclick-race —
  synthetic click/click/dblclick on `[data-sess] .lbl`, input must survive 5s
  past the activation round-trip, Enter commits, `/api/state` + sidebar agree.
