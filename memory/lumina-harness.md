---
name: lumina-harness
description: lumina replaces dsh as a first-class web harness in ai-manager (2026-10-31)
date_modified: 2026-10-31
tags: [ai-manager, lumina, harness, web, proxy, sessions]
links: [[harness-lifecycle]], [[harness-switch]], [[shared-backend]], [[manager-proxy-remote]]
---

# Lumina web harness (replaces dsh, 2026-10-31)

`dsh` (DeepSeek one-shot CLI) removed from the picker; `lumina` (local-first
AI harness) added as a **web** harness alongside opencode — per explicit user
call ("use the web ui dont use the tui").

## Architecture (mirrors opencode shared backend)

- One shared `lumina serve --host 127.0.0.1 --port <AI_MGR_LUMINA_PORT|HARNESS_BASE-11>`
  hosts every manager lumina session (`backends.js` web mode, `LUMINA_TOKEN`
  cleared so loopback needs no auth). Adopt-or-spawn across restarts
  (`ensureSharedLumina`/`tryAdoptLumina`: TCP + `GET /api/v1/sessions` 200).
- Each manager session pre-creates one lumina chat (`ensureLuminaSession`:
  `POST /api/v1/sessions {workspace_dir, title}`, verify/recreate on 404).
- Iframe deep-link: `frameSrcFor` → `/s/:id/?session=<hid>`; lumina web
  honors `?session=` on load (one-shot `deepLinked` effect in
  `~/lumina/web/src/App.tsx`, rebuilt dist + `bin/lumina` installed to
  `~/.local/bin`). No client-router push possible (lumina SPA is stateless
  w.r.t. URL) — `clientSwitchFrame` gated to `harness === "opencode"`, lumina
  switches take the full cached-frame path.

## Proxy policy per harness (`proxy.js`)

- opencode session roots: route shim + web-defaults seed + no-titlebar CSS +
  api scope. Lumina roots: **api scope only** (its SPA has no routes to shim;
  would wipe `?session=`; owns its chrome).
- CSP: lumina serves no `script-src` (header + inline `<meta>` tag), so scope
  hashes land in `default-src` (`shimCspHeaders` fallback + `patchMetaCsp` for
  the meta tag; `isLuminaHtml` gate on `lumina-color-scheme`).
- Removed: `withToken`/`hasBackendCookie`/`harnessToken` plumbing, dsh
  `?token=` redirect (all dsh-only). `sanitizeHeaders` unconditional now
  (opencode Basic inject; lumina ignores the extra header on loopback trust).
- Vite `/assets/<name>-<hash>.js|css` added to immutable-asset caching.

## Title + activity (`sessions.js`)

- `syncSessionTitle`/`pushTitleToHarness` handle both shapes: opencode
  `{data:{title}}` + `/api/session/…`, lumina flat `{title}` + `/api/v1/sessions/…`.
  First-message derivation stays opencode-only (lumina transcript shape differs)
  — default-titled lumina backends keep the local default.
- Activity: lumina reports `running` when bound (no lumina-native
  working/waiting poll exists yet — never lands on the Needs Attention shelf).
  Lumina exposes no session-delete endpoint: `killSession` drops the manager
  record only (chat row stays in lumina's SQLite store).

## Verification state

- Unit: 176 → 189 (`node --test tests/*.test.js` green).
- API live (scratch 4010/4510): lumina create ~2s, shared port, bound hid,
  served shell (marker + scope, no shim), rename write-through both
  directions, second session shares daemon.
- Headless `chrome --dump-dom`: manager shell boots (4 harness buttons, no
  uncaught JS); lumina `?session=` auto-selects the bound chat (title in DOM).
- Full browser e2e **NOT green on 2026-10-31**: every `agent-browser` tab
  stuck at `about:blank` from first paint while the standing-ops gate held its
  lock (concurrent-run contention per Test hygiene) plus a wedged daemon;
  API sections of the same run passed. Re-run `MGR_PORT=4003 HARNESS_BASE=4490
  npm run test:e2e` (lumina API block included) in a quiet window before
  calling this fully green.
- Live deploy **done 2026-10-31**: unit 189/189 → `systemctl restart`;
  shared opencode backend PID identical pre/post (adopted), lumina session
  test-created live (`sess_45bd3977258d`, daemon :4089, shell verified via
  proxy). No stale dsh sessions existed. Browser e2e re-run still pending.

## Stale-hid healing (2026-11-01)

- Symptom: 7/9 manager lumina sessions held short-form hids (`06b7f976`,
  …) that `GET /api/v1/sessions/<hid>` answered **404** — the lumina
  daemon had moved to UUID chats (old rows gone) while the manager still
  pointed at them. Iframes loading `?session=<gone>` never selected a chat.
- Root cause: `_ensureInner` (the `POST /ensure` reconnect path) only
  called `ensureHarnessSession`/`ensureLuminaSession` when **no** hid was
  stored. A dangling hid skipped verification forever. (`startSession`
  already called them unconditionally, so only the switch/reconnect path
  was blind — same bug for opencode, less visible because its DB persists.)
- Fix (`src/server/sessions.js`): both shared-backend branches of
  `_ensureInner` now call the ensure helper **unconditionally** — it
  GET-verifies and recreates on 404 (one extra loopback GET on the slow
  path only; the alive-cache fast path still skips all I/O). Opencode
  keeps its verify+repair via `ensureHarnessSession` (separate
  `repairBareHarnessSession` block removed as redundant).
- Live heal: `POST /ensure` on each stale session recreated its chat
  (7/7 new UUIDs, verified `200` on the daemon + `200` via proxy).
- Tests: 2 new unit (`ensureSession heals dangling lumina/opencode hid`)
  → `node --test` 202/202; e2e lumina block + new `ensure reconnect keeps
  the bound chat` assert all PASS. Full e2e still shows 10 unrelated
  failures (sidebar rename, split commit, narrate observer) in areas this
  change doesn't touch — pre-existing/flaky, not regressed by this fix.
