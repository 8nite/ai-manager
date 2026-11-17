---
name: chassis-harness
description: chassis replaces lumina as a first-class web harness in ai-manager (2026-11-06)
date_modified: 2026-11-06
tags: [ai-manager, chassis, harness, web, proxy, sessions]
links: [[harness-lifecycle]], [[harness-switch]], [[shared-backend]], [[manager-proxy-remote]], [[lumina-harness]]
---

# Chassis web harness (replaces lumina, 2026-11-06)

Per explicit user call ("replace lumina with chassis"): `lumina`
(local-first harness, `/api/v1/sessions`) removed from the picker;
`chassis` (opencode fork, `chassis serve`, opencode-identical `/api/*`)
added as a **web** harness alongside opencode.

## Architecture (second opencode-family shared backend)

- One shared `chassis serve --hostname 127.0.0.1 --port <AI_MGR_CHASSIS_PORT|HARNESS_BASE-11>`
  hosts every manager chassis session (`backends.js` web mode). Same port
  offset lumina used — so the retired lumina daemon squats on it until
  retired (see below).
- Auth: stable manager-held Basic secret (`chassisAuth.js`, file
  `~/.ai-manager/chassis-password`, user `chassis`, env `CHASSIS_BIN` /
  `AI_MGR_CHASSIS_PASSWORD[_FILE]`). `backendApi` + proxy `sanitizeHeaders`
  select the secret **per port** (chassis port → chassis secret, else
  opencode secret). Verified by unit: all calls to a chassis port carry the
  chassis header, never the opencode one.
- Session lifecycle reuses the opencode code paths verbatim
  (`ensureHarnessSession`, bare-chat repair, title pull-back + first-message
  derivation, `/active` attention poll, DELETE-on-remove) via the
  `isOpencodeFamily` predicate — no chassis-specific API code remains.
- Proxy: chassis shells get the full opencode treatment (route shim +
  web-defaults seed + no-titlebar CSS + per-pane api scope). The defaults
  seed is per-harness (`webDefaultsSeedFor`: `chassis.global.dat:*` /
  `chassis-color-scheme` vs `opencode.*`) because the fork rebranded its
  localStorage namespace. Removed as dead: `isLuminaHtml` / `patchMetaCsp`
  (only lumina shipped an inline CSP meta tag).
- Frontend: `HARNESS_NAMES` = opencode/droid/chassis/agy; chassis frames use
  the session-root + route shim (no `?session=` deep-link);
  `clientSwitchFrame` allows chassis but refuses cross-harness pushes
  (same port ≠ same store); tab sync seeds both `opencode.window…` and
  `chassis.window…` namespaces.
- Stored lumina records migrate on load (`store.migrateLuminaSession`:
  harness → chassis, port/hid dropped, status starting; next ensure
  repoints + backfills). No lumina code paths remain in `src/` or `tests/`.

## Retired-daemon collision (the one live surprise)

- Symptom: after deploy, all migrated sessions stuck `starting`, pre-create
  failing with "backend session create returned no id" — the old lumina
  daemon still held :4089 and serves its SPA shell with **200 for unknown
  paths**, so `tryAdoptChassis` (TCP + 2xx check) adopted a daemon that
  speaks no API.
- Fix (`sessions.js`): `tryAdoptChassis` requires a chassis-shaped
  `/api/info` JSON object (`pid`/`version`); `_ensureSharedChassisInner`
  calls `reclaimLuminaPort` when the port is held by a foreign occupant —
  SIGTERM only to `lumina serve` processes bound to exactly that port, then
  waits for free. Unit regression: HTML-200 occupant must not adopt.
- Live heal: restart retired the lumina daemon, spawned `chassis serve`
  :4089, all 10 migrated sessions `running` + bound, proxy shell verified
  (shim + scope + chassis seed + CSP hashes).

## Verification state

- Unit: 207/207 (`node --test tests/*.test.js` green).
- E2E (`MGR_PORT=4002 HARNESS_BASE=4500`): all 12 chassis asserts PASS
  (switch offers chassis, web running, bound hid, shared port, shell
  markers ×4, rename write-through, auto-title converge, second session
  shares port, ensure keeps binding). Full run shows the same 10
  pre-existing failures documented for lumina-harness (sidebar rename,
  split commit, narrate observer) — untouched areas, same count, not
  regressed by this change.
- Live deploy done: opencode backend PIDs identical pre/post restart
  (adopted), chassis daemon :4089 fresh, lumina daemon gone.

## Stale-tab version pin (2026-11-06, post-deploy)

- Symptom: chassis button visible but unselectable — click silently did
  nothing. Fresh `app.js` selects + persists fine (browser-verified).
- Root cause: `app.js` is served immutable 1y at `?v=VERSION` and the swap
  shipped without a version bump (stayed 0.2.4). Stale tabs kept the old
  bundle, whose `HARNESS_NAMES` lacks chassis, so `setSelectedHarness`
  hit its `includes` guard and returned silently — new shell, old JS.
- Fix: bump to 0.2.5 + restart (all backend PIDs adopted, incl. chassis).
  Regression test: frontend `HARNESS_NAMES` must equal backend
  `harnessNames()` (`harness-switch.test.js`). Contributor rule added to
  AGENTS.md deploy section: every frontend change ships a version bump.
