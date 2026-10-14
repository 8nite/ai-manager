---
name: split-screen
description: Main-window split-screen panes for concurrent multi-session views (2026-10-10)
date_modified: 2026-10-10
tags: [ai-manager, split-screen, proxy, frontend]
links: [[manager-proxy-remote]], [[opencode-v2-web]], [[harness-switch]]
---
# Split-screen panes (main window)

View multiple sessions at the same time in `#center`: a `#paneBar` toolbar
(Split ║ / Split ═ / Close pane, `#paneCount` pill) above `#stage`, with a
`#paneGrid` of up to 4 `.pane` cards. Each pane owns its session view —
web sessions get their own `<iframe class="pane-frame" src="/s/:id/">`,
pty sessions (droid/dsh) their own xterm + SSE stream — plus a header
`<select class="pane-select">` to assign any session and a close button.
Single empty pane shows the Mission Control dashboard overlay (`#emptyStage`);
splitting hides it and each empty pane shows a placeholder instead.
Layout (panes + cols/rows direction) persists to localStorage
(`ai-manager.panes`, `ai-manager.layout`) and restores on boot.

## Opening sessions aside

- Sidebar rows: hover `⧉` button (`.sess-split-hover`, always visible on
  touch via the 768px rule) calls `openInSplit(id)` — focuses the pane if
  the session is already open, else splits.
- Sidebar/dblclick/Enter still target the focused pane via `activateSession`.
- Palette: session/attention items carry `sessId`; Shift+Enter opens aside.
  Three new ACT actions cover split/unsplit by name.

## Concurrent web correctness (proxy.js `injectApiScope`)

Two live iframes share one cookie jar, so root-absolute backend calls
(`/api/*`, `/_assets/*`, WS `api/pty/.../connect`) from pane B would land on
pane A's backend via the old `aimgr_active` fallback. Fix: every session-root
document embeds its manager session id (`apiScopeBodyFor`, sanitized
`[A-Za-z0-9_-]`) and a pre-app patch rewrites all same-origin
fetch / XHR.open / EventSource / WebSocket URLs to `/s/:id/*`
(`explicitMiddleware` routes them, no cookie needed). Already-prefixed URLs
pass through; cross-origin untouched. Own CSP sha256 via `shimCspHeaders`
(served HTML now carries 4 hashes). Assets are identical across same-version
backends, so scoping them too is harmless. Legacy single-view singletons
(`#webview`, `#termWrap`, `state.mainTerm/es`) are gone — per-pane
`{term, fit, es, seq}` with a global `activateSeq` for staleness.

## Gotchas

- Split buttons must ALWAYS add a pane, even from an empty single pane —
  an early "nothing to split with" guard broke the natural flow (split
  first, assign sessions after) and failed e2e (`panes:1` after Split click).
- E2E second session: use a droid PTY (fast spawn), not a second opencode
  web backend (~60s boot). Assign pane 1 explicitly first — a fresh page
  boots with empty panes, so "first pane keeps its session" needs setup.
- `renderPanes` reuses pane DOM nodes keyed by `data-pane` so typing/scroll
  survive sidebar polls; `updatePaneHeaders` repaints only dropdowns.

## Focus tracking (sidebar switch targets the focused pane, not the newest)

Clicks inside a web iframe never bubble `pointerdown` to the outer page, so
pane `pointerdown` alone leaves `activePanePid` stuck on the newest split and
sidebar/palette switches land there instead of the clicked window. Worse:
iframe-to-iframe moves fire NEITHER `window blur` NOR a `focus` event on the
iframe element (verified live 2026-10-10 with real mouse clicks — outer
`document.activeElement` moves silently: `IFRAME#fA` → `IFRAME#fB` with an
empty event log). So the `focus` listener + `blur` handler cover only the
first switch (outer → iframe); every alternating tap after it stays stuck.
Fix: a 250ms `setInterval` adopts whichever pane owns `activeElement`
(only `IFRAME`; `focusPane` early-returns when already active, so steady
state is one property read per tick). `activateSession` resolves via
`getActivePane()`; a session already live in another pane focuses that pane
instead of duplicating. E2E: focus the VISIBLE cached frame, assert
`.focused` moved, then sidebar-switch a fresh session and assert
`[newId, oldId]` pane-select order.

Companion fix in `focusPane`: a stale iframe may hold DOM focus while outer
chrome (sidebar row, palette) moves pane focus elsewhere — programmatic
`.click()` never moves focus the way a real mousedown does, so the poll
dragged focus back within a tick (sidebar selection flipped back after a row
click). `focusPane` now blurs a stale iframe owned by ANOTHER pane
(`ae.blur()` resets outer focus to BODY — verified); skipped when the target
owns the focused iframe, so real taps keep typing focus. No-op for all real
flows (real mousedown moves outer focus before handlers run).

## E2E lessons (2026-10-10)

- Pane dropdowns only offer sessions from the last 8s `/api/state` poll:
  assigning a just-created session id sets value `""` and the change handler
  clears the pane instead. Wait for the `<option>` (poll `[...sel.options]`)
  before `dispatchEvent(change)` — applies to every programmatic assign.
- With the frame cache, web views live in dynamic iframes; the static
  `.pane-frame` stays hidden/src-less. E2E must select the VISIBLE frame
  (`find(!hidden)`), never `[0]` — stale index reads nothing and `.focus()`
  on the hidden node silently fails (cascades: focus check → wrong-pane
  switch → sidebar assertions).
- `JSON.stringify` arrays have no space after commas: grep `"a","b"`, not
  `"a", "b"` (failed the focus-switch assertion deterministically).
- `AGENT_BROWSER_PROFILE=$TMP/browser-profile` per run: the shared default
  profile gets driven concurrently (parallel dev browser use steals
  tabs/focus/localStorage and flakes unrelated sections). Auto-removed by
  the EXIT trap's `rm -rf $TMP`.
- Alternating-tap coverage needs TWO web sessions (iframe→iframe is the
  broken path; PTY panes use the `pointerdown` path that always worked) and
  REAL mouse clicks (`agent-browser click` on the visible iframe element
  lands inside its content like a user tap). Programmatic `f.focus()` fires
  a focus event and passes even without the fix — it cannot cover this bug.
  Tag visible frames first (`dataset.tap`), then click `tap0/tap1/tap0/tap1`
  asserting `.focused` index each time (retry ×3, poll needs ~250ms).
- Second web session costs one more ~60s opencode boot; create + DELETE it
  inside the section so later assertions see a stable set.
