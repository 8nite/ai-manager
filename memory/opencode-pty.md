---
name: opencode-pty
description: opencode harness runs as a PTY TUI (2026-10-14); web embedding retired, resume by chat id, chat-id backfill, shared-serve retirement
date_modified: 2026-10-14
tags: [opencode, pty, harness, migration, backends, sessions]
links: [[shared-backend]], [[client-nav-switch]], [[manager-proxy-remote]], [[harness-lifecycle]], [[web-attention]], [[session-title-sync]]
---

# opencode as a PTY harness (2026-10-14)

The `opencode` harness changed `web` → `pty` (`src/server/backends.js`):
one TUI per session in node-pty/xterm, like droid/agy. Prompt traffic is PTY
bytes — the `Transport: Failed to fetch` class and the `Select an agent and
model` config-fetch failures (both tunnel-only, web-embedding-only) are gone
by construction.

## Mechanism

- `args(resumeId)`: `["--session", id]` continues that exact chat (the TUI
  shares the old serve backend's session store — verified live: `opencode
  session list` shows serve-created chats, incl. manager sessions).
  Unbound (re)spawns stay plain `opencode`: no global `--continue` (would
  resume another workspace's chat), matching the droid `resume --last`
  caution in `ptyArgsFor`.
- Migration is the existing mode-change branch in `startSession`
  (dsh web→pty precedent): legacy `web` records keep `harnessSessionId`,
  drop `port`, spawn the TUI onto their chat. Zero conversation loss
  (13/13 live sessions migrated running, hids intact).
- `maybeRetireSharedBackend()`: kills our own shared-serve handle once no
  `web`-mode opencode sessions remain. Adopted backends (no handle) are left
  alone — reaped by hand after verifying zero port refs.
- `backfillOpencodeHarnessId()` (fired fire-and-forget from `/api/state` +
  `/api/sessions`): a fresh TUI owns no server chat until its first prompt,
  so claim it lazily via `opencode session list --format json` (newest-first;
  match `directory === ws.path`, `created >= sess.createdAt - 5s`,
  unclaimed by other sessions). Adopts a real backend title only while the
  local title is still default-like (one-way rule, mirrors
  [[session-title-sync]]). Converges to zero work (hid-less sessions only).

## What went away (behavior)

- No serve processes per session, no shared backend, no ports for opencode.
- Title/activity HTTP sync (`syncSessionTitle`, `syncAllWebActivity`,
  `prewarmSessionConfig`) no-op for pty (guarded by mode/port) — activity
  is the PTY idle heuristic (`working` < 8s else `waiting`).
- The whole web-embedding stack is unreachable with no web harnesses left
  (proxy `/s/*`, route shim, api-scope, frame cache, client-nav lane,
  narration transcript observer): slated for deletion as phase 1b.
- E2E rewritten to the PTY model (boot/stream asserts, respawn-with-binding
  across restart, row-switch stream asserts, PTY death on delete, keyed-row
  preservation). Deleted web-only coverage (served HTML/CSP, defaults seed,
  config pre-warm, client-nav/frame-budget, third-nav stall).

## Gotchas learned

- Third consecutive client-side nav stalled pre-migration: repeat visits hit
  the SPA's solid-query cache (no `.../message` fetch), so the nav-verify
  loop (keyed on a fresh fetch) always timed out; hidden frames could also go
  stale via the SPA's tab sync. Moot now (no iframes), but the lesson stands
  if web embedding ever returns: verify on URL+settled-DOM, and re-validate
  cached views before showing them. See [[client-nav-switch]].
- Shelf-card shadowing: a waiting session owns an attention-shelf card
  *above* the sidebar in DOM order, so bare `[data-sess]` selectors hit the
  card (rebuilt every poll) instead of the keyed row. Scope e2e/browser
  selectors to `#wsList` (cards have no `.lbl`/`.sess-del-hover` either).
- Narrate e2e on a chatty TUI: backlog replay + repaint frames flood
  `narrateFeed` (evicting test text) and the noise filter drops TUI bytes
  (empty queue). Feed quiet droid PTYs in e2e; read the buffer atomically in
  the feed eval; settle fresh sessions to stable `waiting` before feeding
  (birth transitions preempt content by design).
- `node --test` silently skipping everything (`run() called recursively`)
  means a leaked `NODE_TEST_CONTEXT=child-v8` in the shell env (leftover of
  an interrupted run) — `env -u NODE_TEST_CONTEXT` the test command.

Related: [[shared-backend]] (retired), [[client-nav-switch]] (dead lane),
[[manager-proxy-remote]] (dead proxy), [[harness-lifecycle]] (pty spawn
policy), [[web-attention]] (superseded by idle heuristic for opencode).

Graph note (2026-10-14): this file's semantic fragment was extracted via the
no-key host-agent path and cached, and the manifest is stamped — but
`graphify-out/graph.json` was NOT rebuilt (no LLM backend key on this box,
and the CLI's cache fingerprint didn't hit the host-agent entries). Next
keyed `--update` re-extracts normally; until then the markdown here is the
source of truth.
