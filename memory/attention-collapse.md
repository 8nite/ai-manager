---
name: attention-collapse
description: Needs Attention shelf + dashboard feed collapse/expand (2026-10-27)
date_modified: 2026-10-27
tags: [frontend, attention-shelf, app.js, app.css, index.html, e2e]
links: [[attention-dismiss]], [[ui-chrome-cleanup]], [[split-screen]]
---

# Needs Attention collapse/expand

The sidebar Needs Attention shelf header and the dashboard
`AGENTS AWAITING HUMAN INPUT` feed share one persisted collapsed flag.
Collapsed keeps the header (with the waiting count) and hides the cards.

Design (all frontend-local — no server change):
- `state.attentionCollapsed: bool` + `localStorage ai-manager.attentionCollapsed`
  (`"1"`/`"0"`); `loadAttentionCollapsed()` runs in `boot()` before the
  first `refresh()`, alongside `loadDismissedAttention()`.
- `toggleAttentionCollapsed()` flips + saves + repaints shelf and dashboard
  synchronously (no poll wait).
- Shelf: `.shelf-header` div became `button.shelf-toggle` (caret + count,
  `aria-expanded`, focus-visible ring); `renderAttentionShelf()` sets
  `.collapsed` on the shelf and early-returns before card render; CSS
  `.attention-shelf.collapsed .shelf-card { display:none }` is belt-and-braces.
- Dashboard: static header title div became `button#dashAttentionToggle`
  (`aria-controls="dashAttentionList"`); `renderDash()` toggles
  `#dashAttentionSection.collapsed` + syncs `aria-expanded`; wired once in
  `boot()` with a null guard.
- Toggle visuals follow the workspace-group pattern (`.caret` rotate -90deg).

Guards: `tests/attention-collapse.test.js` (6 static-contract tests);
`scripts/e2e-web-defaults.sh` "Needs Attention shelf collapses + expands"
(10 checks: toggle present + starts expanded → collapse hides card, header
keeps count, persisted → reload stays collapsed → expand restores).

E2E idiom verified: agent-browser `eval` prints JSON-encoded output, so
`python print(json.load(sys.stdin))` round-trips back to raw JSON text and
`grep '"key":value'` on the parsed var matches. Grepping the RAW capture
works identically; do not "simplify" the pipe (the parse also validates).
