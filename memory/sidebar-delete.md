---
name: sidebar-delete
description: Sidebar minus deletes a session with no confirm dialog (2026-10-12)
date_modified: 2026-10-12
tags: [frontend, sidebar, delete, app.js]
links: [[sidebar-rename-race]]
---

# Sidebar minus deletes with no confirm

Decision (2026-10-12, user request): the left-panel hover minus
(`.sess-del-hover`, "Remove session from workspace") deletes on a single
click — no `confirm()` dialog. Rationale: removing a session from the panel
is one click by design; the native dialog stalled headless input and annoyed.

Kept confirms (destructive scope is larger):

- Workspace delete (`Remove workspace … and delete its N session(s)?`).
- Session-bar kill button (`Delete session …?`).

Implementation: `src/public/app.js` `delSessBtn.onclick` — bare
`DELETE /api/sessions/:id` + pane teardown + `refresh()`. UI-only change:
`express.static` serves it per request, no manager restart needed (verify
live bytes: `curl …/app.js | grep -c "No confirm: removing a session"`).

Regression coverage:

- `scripts/e2e-web-defaults.sh`: throwaway session → headless click on
  `[data-sess] .sess-del-hover` → `/api/state` loses the id + sidebar row
  gone, no dialog. (Placed after the SESS2 guard block, before the mobile
  block; uses default ports via `MGR_PORT`/`HARNESS_BASE` overrides.)
