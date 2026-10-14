---
name: shared-backend
description: Single shared opencode serve backend for all manager sessions (2026-10-13)
date_modified: 2026-10-13
tags: [ai-manager, opencode, sessions, performance, architecture]
links: [[session-switch-cache]], [[opencode-v2-web]], [[harness-lifecycle]], [[manager-proxy-remote]]
---

# Shared opencode backend (one serve, many chats)

Per-session `opencode serve` processes (~200-600MB RSS each; 8 live + 11
orphans ≈ 6.4GB) were the perf problem: slow creates (full boot per
session), N× `/active` polls, heavy browser load. Now ONE backend
(`sharedPort()` = `HARNESS_BASE-10`, live `:4090`) hosts every manager
opencode session as a chat (`POST /api/session` per session).

## Verified live before building (2026-10-13)

- Chats are backend-agnostic (global DB `~/.local/share/opencode`): a chat
  created on `:4101` is GET-able from `:4100`, AND a tiny prompt POSTed via
  `:4100` executed (assistant turn completed <5s, readable via `:4100`).
  Throwaway chat deleted after.
- Execution (`/active` drain) is backend-LOCAL: `:4100` showed its running
  turn while `:4101` showed `{}`. So legacy sessions repoint only when idle.

## Server (`src/server/sessions.js`)

- `sharedPort()` — `AI_MGR_SHARED_PORT` override else `HARNESS_BASE-10`
  (live 4090; e2e `HARNESS_BASE=4300` → 4290). `allocPort` never collides
  (starts at `BASE_PORT`). `AI_MGR_SHARED_PORT` is read dynamically so unit
  tests can pin it per-test.
- `ensureSharedBackend(cwdHint)` — adopt-or-spawn with `_sharedStarting`
  dedupe; stamps `backendPid` on all shared-port sessions (frontend
  pid-change reload detect keeps working). No per-session `_procs` entry.
- `createSession` (opencode) assigns the shared port, no `allocPort`.
- `startSession` / `_ensureInner` route opencode to shared + backfill chat;
  legacy ports go through `migrateToShared`.
- `migrateToShared(id)` — idle-gated repoint: checks old backend
  `/api/session/active`; working turns STAY (retry next ensure); refused =
  old backend gone = safe. Reclaims the old backend only when unreferenced,
  and only our own handle/pid (verified via `/api/info`) — never a
  port-probe kill, so a scratch manager can never SIGTERM live backends.
- `syncAllWebActivity` — one `/active` per PORT (8 sessions → 1 fetch);
  `getWebActivity(id, to, activeData)` accepts the injected map (direct
  callers unchanged). Refused shared port marks its sessions exited (no
  per-session handle), next ensure revives via shared respawn + backfill.
- `killSession` (shared) — best-effort `DELETE /api/session/<hid>`, drops
  the record, never touches the shared proc. `killSessionProc` no-ops for
  shared sessions. `restoreAll` boots shared once, then backfills.
- Proxy/frontend UNCHANGED (`sess.port` now identical; `/s/:id` + apiScope
  still disambiguate panes).

## Numbers (live 2026-10-13)

- Deploy restart: 9/9 sessions migrated idle → `:4090`, all `running`,
  all 9 chats `GET 200` on shared. Zero interrupted turns (pre-checked
  `/active` empty everywhere).
- Serve RSS 6.4GB → 0.7GB (9 session backends reclaimed at migrate + 10
  verified-idle orphans SIGTERMed by pid; user's `:3030` + `--service`
  untouched). Manager cgroup 7.2G → 5.6G.
- Unit 139/139 (sessions 33: 6 new + 2 bodies adapted, headers intact);
  e2e 0 failures incl. new asserts (all opencode on one port, third create
  fast + same port).

## Gotchas

- Unit tests MUST pin `AI_MGR_SHARED_PORT` to the stub around any
  ensure/start/create with an opencode record (`_resetSharedForTest`
  before/after) — unpinned, adopt fails on the real port and the test
  spawns a live `opencode serve` (2026-10-13: two strays on `:4090`,
  caught by post-suite port check). Pre-existing "concurrent ensures" test
  needed the same pin.
- E2E gates `MGR_PORT` + `HARNESS_BASE` + `HARNESS_BASE-10` free; the base
  itself is no longer allocated for opencode, only the shared derivation.
- Scratch managers leave their shared backend alive by design (web
  backends survive); completed e2e now leaves `:4290`-style orphans —
  reclaim by pid after `/active` + store checks, same as any orphan.
- Known ceiling: no pid-match check after shared spawn (parity with
  `startWeb`); a foreign process holding the shared port with our password
  would be adopted. Disjoint ports by construction; revisit if multi-tenant.
