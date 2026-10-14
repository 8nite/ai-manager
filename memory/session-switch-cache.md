---
name: session-switch-cache
description: Fast session switching via per-pane iframe cache + server liveness cache (2026-10-10)
date_modified: 2026-10-12
tags: [ai-manager, frontend, sessions, performance]
links: [[split-screen]], [[harness-lifecycle]], [[opencode-v2-web]]
---

# Fast session switching (keep a few views in memory)

Switching sessions used to cost seconds: `POST /ensure` ran TCP probe +
`/api/info` + harness-chat verify + title sync SEQUENTIALLY before
responding (adopted backends have no child handle, so EVERY switch
re-probed), `touch` waited behind it, and the pane's single iframe got a
new `src` (full opencode SPA reload) on every web→web switch.

## Server (`src/server/sessions.js`, `index.js`)

- `_aliveAt` liveness cache (`ALIVE_TTL_MS = 30000`): any verified backend
  contact (adopt, `startWeb`, `ensureHarnessSession`, `getWebActivity`)
  marks the session; `ensureSession` returns the store record with zero I/O
  while fresh. Unbound opencode chats still fall through to backfill.
  Cleared on exit/unreachable/kill. Exported `markAlive`,
  `isRecentlyAlive`, `_clearAliveForTest`.
- `_ensureInflight` dedupe: concurrent ensures for one id share a promise
  (rapid A→B→A clicks).
- `POST /ensure` responds FIRST, title sync runs after — switches never
  wait on it (8s poll converges titles anyway). E2E: repeated ensure
  45ms (was seconds).
- The 8s `/api/state` poll refreshes `_aliveAt` via `getWebActivity`, so
  the TTL window self-heals; a backend that died inside the window is
  restarted by the background ensure + iframe reload (pid-change detect).

## Frontend (`src/public/app.js`)

- Per-pane iframe cache (`FRAME_CACHE_N = 3`, `p._frameCache` Map):
  `paintPane` reuses/shows, hides siblings, evicts oldest (never active).
  LRU refresh on reuse. Static `.pane-frame` stays hidden/src-less once
  the cache takes over (counts in `querySelectorAll` — budget asserts
  use 1..3).
- Instant path in `setPaneSession`: cached + locally `running` → paint
  now, no loader, ensure+touch in BACKGROUND (parallel); reload only
  when `backendPid` changed. Slow path runs ensure+touch in parallel and
  force-reloads (`forceFrameReload`) when `wasDead`/pid-changed.
- `purgeSessionFrames(id)` on sidebar-minus + workspace-delete; `refresh()`
  prune loop purges vanished ids too (background-poll deletes).
- E2E (no-prompt section, reuses web SESS2 — no extra 60s boot):
  A→B→A keeps the SAME element (`data-cache-mark`), delete purges it.

## Follow-up 2026-10-12 — switching/initiating felt "very slow"

Measured on an isolated scratch rig (2 sessions, clean browser profile) +
live API timing; server was already fast (`/api/state` ~80ms, cached ensure
~1ms), the pain was elsewhere:

- **2s adopt tax on every create** (`sessions.js tryAdoptBackend`): the
  pre-spawn probe retried a refused port for the full 2s timeout — on a
  fresh port nothing could ever answer (spawn happens after). Fix:
  `probePortOnce` single-shot (~ms on refused); the retry loop stays only
  for post-spawn boot waits. Measured `POST /api/sessions` 3.1s → 0.8s.
  Same tax also hit every adopted-backend respawn / first switch after a
  manager restart (now ~10ms: probe + 2 API calls).
- **Instant path always won** (`app.js setPaneSession`): `isFrameCached`
  ran AFTER `paintPane`, but painting a miss creates + connects the new
  frame — so every cold switch took the "instant" branch and the loader
  path was dead code (blank frame, zero feedback). Fix: snapshot
  `wasCached` BEFORE paint; cold misses get loader + awaited ensure, warm
  hits stay instant (verified in-page: cold `show@7 connecting → show@28
  loading → hide@~700 on real load`; warm = single sync hide, no loader).
- **Blank-load killed the loader** (`attachFrameListeners` + static pane
  listener): appending a fresh iframe fires `load` for `about:blank`
  (~10ms), which hid the pill before content arrived. Both handlers now
  ignore `about:blank` commits (same-origin readable; unreadable falls
  through to legacy handling).
- **Dead-click creates** (`quickCreateSession`): the boot-blocking POST ran
  with no feedback (`status()` is a no-op) plus a blocking `refresh()`
  before activate. Now shows `starting <harness>…` first, merges the POST
  result into `state.sessions` directly, refreshes in the background.
- **Narrate race from the above** (`observeActivePane`): the slow path
  observed at the END, so its buffer-clear wiped feeds between click and
  ensure resolution (e2e caught it: "focused feed missing"). Now observes
  synchronously with the switch intent (right after paint); the completion
  block must NOT re-observe — the iframe load handler re-targets on commit.
- **Poll robustness** (`index.js /api/state`, `/api/sessions`): title sync
  + activity sync now run concurrently (`Promise.all`) so one slow backend
  stalls the poll once, not twice.

Guards: `tests/switch-speed.test.js` (wasCached ordering, blank guard,
quick-create shape, sync observe + no late re-observe);
`sessions.test.js` (closed-port adopt <1000ms, probe true/false); e2e
switch section ("cold switch takes the loader path", "loader clears after
switch-back"). Full loop green 2026-10-12: unit 128/128, e2e 138 PASS /
0 FAIL. Live deploy: `systemctl --user` restart, all 10 backend PIDs
identical pre/post, 12/12 `running`.

## E2E serialization (learned 2026-10-10)

- NEVER run two e2e concurrently: even with per-run `AGENT_BROWSER_PROFILE`
  (already in script) and distinct ports, CPU contention flakes timing
  asserts (first attempt died on a pre-existing rename curl under load).
  Guard: `pgrep -f 'e2e-web-defaults[.]sh'` (bracket trick so the guard
  never matches itself), proceed only at zero.
- Default `HARNESS_BASE=4300` is HELD by a live backend → scratch
  `allocPort` picks it and `tryAdoptBackend` ADOPTS THE LIVE BACKEND.
  Use `MGR_PORT=4002 HARNESS_BASE=4450` (both verified free first).
