---
name: ui-chrome-cleanup
description: Removed sessionBar, statusline, shortcut-tip, sidebar-heading (2026-10-10)
date_modified: 2026-10-10
tags: [frontend, ui-cleanup, app.js, app.css, index.html]
links: [[sidebar-rename-race]], [[session-title-sync]]
---

# UI chrome cleanup (sessionBar / statusline / shortcut-tip / sidebar-heading)

Removed 2026-10-10 as low-value chrome: the center `sessionBar`
(breadcrumb + status/harness/idle badges + Rename/Resume/Terminate/Open-Tab),
the bottom `statusline` (status text + host pill + shortcut hints), the
sidebar `shortcut-tip` (Ctrl+K/Esc hints), and the `WORKSPACES & SESSIONS`
`sidebar-heading`.

Why safe (no functional loss):
- Rename lives in the left panel (dblclick / F2 / hover pencil) + palette.
- Terminate = left-panel hover minus (`DELETE /api/sessions/:id`, no confirm).
- Resume is implicit: `activateSession` already `POST /ensure` on every switch,
  so the explicit Resume button was redundant.
- Open-Tab has no replacement (open `/s/:id/` manually if ever needed).
- `status()` is kept as a **no-op stub** so ~15 existing call sites stay
  harmless without a 15-site diff (marked `ponytail:`).
- Sidebar count pill (`sidebarCountPill`) deliberately kept — `updateCounts()`
  and the sidebar header need the target.

Guards: `tests/proxy.test.js` "ui-cleanup" asserts the tokens are absent from
`index.html` / `app.js` / `app.css`; `scripts/e2e-web-defaults.sh` "removed
chrome stays gone" asserts the same in a live browser (9 checks) + count pill kept.

E2E flake lesson (same day): two red runs were environmental, not the change —
a runaway scratch-backend `opencode` burning ~80% CPU starved the scratch
manager (empty `/api/state`, missing sidebar rows). An aborted e2e also leaves
an orphaned scratch manager squatting on 4001/4300. Before re-running:
`ss -tln | grep 4001/430x`, kill only PIDs with
`AI_MGR_DATA=/tmp/aimgr-e2e.*` (never the live `:4000` service PID), confirm
ports free, re-run when the box is quiet. Fourth run: 0 failures.
