---
name: attention-dismiss
description: Attention shelf per-card dismiss × (2026-10-11)
date_modified: 2026-10-11
tags: [frontend, attention-shelf, app.js, app.css, e2e]
links: [[ui-chrome-cleanup]], [[split-screen]], [[session-switch-cache]]
---

# Attention shelf dismiss ×

Each Needs-Attention card owns an × (`shelf-dismiss`) that hides the card
**without deleting the session** (dismiss ≠ sidebar minus, which is
`DELETE /api/sessions/:id`).

Design (all frontend-local — no server change; activity is derived per poll):
- `state.dismissedAttention: Set` + `localStorage ai-manager.dismissedAttention`.
- `visibleWaiting()` filters it; shelf header count, wait badge
  (`updateCounts`), and dashboard attention feed all read the visible set so
  the numbers agree everywhere.
- `pruneDismissedAttention()` runs in `refresh()`: ids that leave `waiting`
  (or vanish) are dropped, so the next waiting turn re-arms the card.
- `activateSession()` clears the id (opening = seen) and repaints
  shelf/dash/counts synchronously.
- `boot()` calls `loadDismissedAttention()` before the first `refresh()`.
- Card `keydown` ignores events from `.shelf-dismiss` (same guard pattern as
  sidebar rows); button click `stopPropagation`s so dismiss never activates.
- CSS mirrors the row hover buttons (`display:none` until
  `:hover/:focus-within`, forced visible under `max-width: 768px` for touch).

Guards: `tests/attention-dismiss.test.js` (9 static-contract tests);
`scripts/e2e-web-defaults.sh` "attention shelf card owns a dismiss ×" (10 checks:
waiting → card+× → dismiss hides card, row+session survive, persisted →
open re-arms).

E2E lesson: opening a PTY session redraws its terminal (resize → fresh PTY
output → activity reads `working` for ~8s), so post-open assertions must
**poll** (15×2s) for the card's return, not single-shot. Same flapping
applies to any e2e that opens an idle PTY session and immediately asserts
`waiting` UI.
