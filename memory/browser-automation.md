---
name: browser-automation
description: Browser automation notes for this machine (agent-browser vs browser-harness)
date_modified: 2026-10-09
tags: [agent-browser, browser-harness, cdp, testing]
links: [[prod-web-testing]]
---

# Browser automation notes

- `browser-harness` (CDP `127.0.0.1:9222`) is unusable here: local Chrome runs via
  chrome-remote-desktop without remote debugging, and the one-time "Allow remote
  debugging" click can't be done from a non-interactive shell. Don't retry in a loop.
- `agent-browser` (own Playwright daemon) works headless. Key commands used:
  `open`, `snapshot -i`, `click/fill` via `@refs` (re-snapshot after every nav),
  `eval`, `cookies set`, `network requests [--clear|--filter]`.
- `eval` quoting: single-line simple expressions inline; anything with nested
  quotes/IIFE → `eval --stdin <<'EVALEOF'`.
- `network requests` was decisive for the `/api/event` 404 diagnosis (fetch + status).
- `history.replaceState` probe reminder: signature is `(state, title, url)` —
  2-arg call silently changes nothing.
- In-page `fetch(..., {redirect:'manual'})` + header dump distinguishes manager
  vs upstream status (dsh 401-with-Express-headers proved the token never got
  appended — led to the `oc_locale` poisoning find).
- `eval` returns JSON-quoted strings: `location.href` comes back wrapped in
  `"..."` — strip quotes before reusing as a URL (`tr -d '"'`, else
  ERR_NAME_NOT_RESOLVED).
- First Send-click in opencode web flaked once (draft still in box after 25s;
  re-click submitted, reply `E2E-OK …` genuine). If a prompt looks unsent,
  check message count via eval before assuming model hang.
- `eval` result is always a JSON string of `String(result)`: JS boolean
  `true` comes back as `"true"` (quoted), which parses to lowercase `true`
  — NOT Python `True`. Compare e2e assertions accordingly (burned once in
  `e2e-web-defaults.sh` rename check). Pipe through `tail -1`, JS booleans
  via ternary (`... ? true : false`) still arrive as `"true"`/`"false"`.
- Sidebar `@refs` go stale on every 8s `refresh()` re-render: re-snapshot
  immediately before `click`, or drive flows via in-page synthetic events
  (`dispatchEvent` click/click/dblclick on `.lbl`) + DOM polling instead.
- Headless `agent-browser` matches `(hover: none)` even at desktop width
  (verified 2026-10-10: `hoverNone:true, hoverHover:false` at 1280px), so
  touch-only CSS must use `(max-width: 768px)`. First attempt with
  `(hover: none)` broke the desktop `display:none` e2e assertions.
- Synthetic in-page events are NOT faithful for focus behavior: `el.click()`
  via eval never moves `document.activeElement`, and `iframe.focus()` fires a
  focus event that real iframe→iframe taps never produce (verified: real
  cross-iframe taps move activeElement with zero outer events). Focus bugs
  must be reproduced/covered with REAL mouse input (`agent-browser click` on
  the iframe element lands inside its content like a user tap); synthetic
  flows then need the app to tolerate stale iframe focus (see
  [[split-screen]] gated blur).
