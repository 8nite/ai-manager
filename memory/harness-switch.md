---
name: harness-switch
description: Top-bar harness switch owns the new-session default; one-click create, no modal (2026-10-10)
date_modified: 2026-10-10
tags: [frontend, harness, app.js, app.css, index.html]
links: [[ui-chrome-cleanup]], [[harness-lifecycle]]
---

# Top-bar harness switch (new-session default)

Shipped 2026-10-10: the harness picker moved out of the New Session modal
into a segmented switch in the top-right (`#harnessSwitch`, before the New
Session button), so creating a session no longer asks which harness to use.

Follow-up 2026-10-10 (no modal popup): the "Launch New AI Session" modal
(`#modal`, workspace picker + title + hidden `#fHarness` + suggestion chips)
is deleted entirely. Every New Session entry point one-click creates via
`quickCreateSession(workspaceId?)` in `app.js`:

- Workspace resolves explicit (sidebar `+` / dashboard card) > active
  session's workspace > first workspace; no workspaces -> `openFolderModal()`.
- Harness comes from `getSelectedHarness()` (top-bar switch, localStorage
  persisted, default `opencode`); backend assigns its default title
  (`<harness> · <ws>`), so no title prompt. `dsh` one-shot title guard is
  gone with the modal — quick-create sends no title and the backend default
  becomes the task.
- Wired: `#btnNewSessionTop`, `#btnHeroNewSession`, sidebar `+`, dashboard
  `+ Session`, palette "Launch New Session…" action. Esc handler and path
  autocomplete now cover only `#folderModal` / `#fPath`.
- Dead CSS removed: `.suggestion-chips` / `.suggestion-chip`, `.h-pick-grid`
  / `.h-card*` (picker leftovers).

Guards: `tests/harness-switch.test.js` (switch placement + options, no modal
remains, JS persistence/quick-create wiring, CSS rules);
`scripts/e2e-web-defaults.sh` "top-bar harness switch owns new-session
default (one-click create, no modal)" (browser: placement, select droid,
localStorage, top-bar button creates a droid session directly with count+1,
`#modal` absent + `quickCreateSession` present, pick survives reload, reset
to opencode). Unit 71/71 + e2e 0 failures.

Related: [[ui-chrome-cleanup]] (same modal/topbar surface),
[[harness-lifecycle]] (harness modes).
