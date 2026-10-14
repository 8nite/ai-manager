# AGENTS.md — ai-manager contributor rules

## Fix loop (the order, every time)

Every change or fix follows this loop — no step skipped, no step reordered:

1. Change + unit tests: implement the fix; extend `tests/*.test.js`
   (append new tests, never rename headers — see Test hygiene).
   `timeout 100 node --test tests/*.test.js` must be green.
2. Deploy via the two-path rule (see Deploy): UI-only changes skip the
   restart; server changes restart + verify adoption.
3. E2E covering the change: if `scripts/e2e-web-defaults.sh` doesn't assert
   the new behavior, extend it FIRST, then `npm run test:e2e`.
   On failure: fix, back to step 1, repeat until green.
   (systemd-unit behavior isn't coverable by the nohup-based scratch e2e —
   verify live with pre/post backend-PID comparison instead.)
4. Memory, only on green: distill durable findings into `./memory/`
   (see Durable memory). If the fix taught a new contributor lesson,
   record it in this file too.

## Deploy (two paths — UI-only skips the restart)

`src/public/*` (HTML/JS/CSS) is served per request via `express.static`,
so UI-only changes take effect with NO restart and workers are untouched by
construction. Only `src/server/*` (loaded once at boot) needs one:

- UI-only: no restart. Verify the live bytes instead, e.g.
  `curl -s http://127.0.0.1:4000/app.js | grep -c <marker>` (and
  `index.html` / `app.css` as touched). Browsers revalidate on reload
  (default maxAge 0 + ETag), so a refresh picks it up.
- Server (`src/server/*`, `package.json`, unit file): unit tests green
  first, then `systemctl --user restart ai-manager.service`. The unit uses
  `KillMode=process`, so only the main node process is signaled: web
  backends stay alive and are adopted with identical PIDs — snapshot
  `ps -eo pid,args | grep '[o]pencode serve'` pre-restart and confirm the
  same PIDs post-restart (respawned PIDs = interrupted turns, investigate).
  PTY sessions are still reaped by `shutdownAll()` by design. Then verify
  health + `/api/state` statuses (opencode sessions `running`; dsh
  auth-wall states pre-existing).

Do not ask before deploying — deploy + verify, then report. Restarting from
a shell inside a manager session is safe (only the main process is
signaled, not your shell).
Non-login shells have no user bus: prefix every `systemctl --user` with
`export XDG_RUNTIME_DIR=/run/user/$(id -u)` (else `Failed to connect to
bus: No medium found`).

## E2E (embedded web UI)

Unit tests use stub backends. Any change to proxied HTML/JS/CSS or the
embedded opencode behavior must also pass the real end-to-end test, which
boots an isolated scratch manager + real backend and drives a real headless
browser:

```
npm run test:e2e   # == bash scripts/e2e-web-defaults.sh
```

It covers: served-HTML markers (route shim, defaults seed, no-titlebar) +
CSP hashes; fresh-browser seeds (queue, dark) + dark boot; explicit user
choices (steer/light) preserved on reload; no router crash. It deliberately
never sends a prompt (that would run a billed agent turn) — the delivery
rewrite is covered by stub-level tests in `tests/proxy.test.js`.
Env overrides: `MGR_PORT`, `HARNESS_BASE`. Requires `agent-browser`.
Multi-session coverage (split-screen): use a droid PTY as the second session
(fast spawn) instead of a second opencode web backend (~60s boot), and assign
pane 1 explicitly first — a fresh page boots with empty panes.

## Test hygiene (learned 2026-10-09)

- Never replace a `test("name"…` header to "add" a test — append new tests at
  end-of-file, then `grep -c '^test('` to confirm the count grew.
- A failing async proxy test that never closes its stub server hangs
  `node --test` — always `srv.close()` on every path.
- Proxy changes: assert through `proxyRequest` against stub backends, not just
  pure helpers — CLI/direct-port passes hid proxy-path bugs before.
- Browser checks: `browser-harness` CDP is unusable on this box;
  use headless `agent-browser`. Never disturb the live manager (port 4000) —
  verify proxy/HTML changes against an isolated instance
  (`AI_MGR_PORT` + `AI_MGR_DATA` + `AI_MGR_HARNESS_BASE_PORT` overrides).
- Headless `agent-browser` reports `matchMedia('(hover: none)') === true`
  even at 1280px wide — never gate desktop-only CSS on `(hover: none)`;
  use `(max-width: 768px)` so desktop e2e `display:none` assertions hold.
- An aborted e2e run orphans its scratch manager on 4001/4300+ (next run
  fails `port in use`; a spinning orphan backend can also flake late-stage
  browser blocks). Before re-running: `ss -tln | grep -E '4001|430'`, kill
  only PIDs with `AI_MGR_DATA=/tmp/aimgr-e2e.*` in `/proc/<pid>/environ`
  (never the live `:4000` service PID), confirm ports free, re-run.
- Never run two e2e concurrently (per-run browser profiles don't save it:
  CPU contention flakes timing asserts). Serialize via
  `pgrep -f 'e2e-web-defaults[.]sh'` (bracket trick so the guard never
  matches itself), proceed only at zero. Run the guard in a SEPARATE call
  before launching: embedded in the same `bash -c` as the run, the wrapper
  cmdline contains the literal script name and pgrep self-matches (false
  ABORT, learned 2026-10-13).
- Shared-backend pin (2026-10-13): any unit test driving
  `ensureSession`/`startSession`/`createSession` with an opencode record
  must pin `AI_MGR_SHARED_PORT` to its stub + `_resetSharedForTest()`
  around it — unpinned, shared adopt fails on the real port and the test
  spawns a live `opencode serve` mid-suite. After the suite, the shared
  port (default 4090) must be free.
- E2E ports: with opencode on PTY there is no shared backend — only
  `MGR_PORT` and `HARNESS_BASE` must be free (the script gates both; the old
  `HARNESS_BASE-10` shared-port gate is gone).
- `node --test` silently skipping everything (`run() called recursively`)
  means a leaked `NODE_TEST_CONTEXT=child-v8` in the shell env (leftover of
  an interrupted run) — always run the suite as
  `env -u NODE_TEST_CONTEXT node --test ...` (learned 2026-10-14).
- Default `HARNESS_BASE=4300` is held by a LIVE backend, so a scratch
  manager's `allocPort` picks it and `tryAdoptBackend` adopts the live
  backend into the scratch run. Prefer `MGR_PORT=4002 HARNESS_BASE=4450`
  (verify both free with `ss -tln` first).
- Pane switches: `paintPane` owns the PTY attach (terminal + SSE stream when
  `!p.term`) — never call `attachPaneTerm` again after it in the same branch
  (second call orphans an EventSource per switch). `setPaneSession` must call
  `updatePaneHeaders()` on every completion path or the pane dropdown lags
  the stage until the next poll.
- Never `pkill -f` a server cmdline pattern: the pattern matches your own
  invoking shell too (self-SIGTERM, "Killed"). Kill scratch managers by PID
  (`ss -tlnp` → `kill <pid>`), never by name match.

## Durable memory

Distill durable findings into `./memory/` (index: `memory/MEMORY.md`),
then refresh the graph so the next session queries fresh state:

```
graphify ./memory --update   # incremental; docs need semantic extraction —
                             # a backend key if set, else host-agent inline
                             # extraction per the graphify skill
```

Key notes: `manager-proxy-remote` (proxy fixes), `opencode-v2-web`
(`opencode serve` facts), `harness-lifecycle`, `browser-automation`.
- No-key graph refresh: this graph's node `source_file`s are bare basenames
  (`narrate-mode.md`, matching `*_stem` IDs), so dispatch the Part-B
  subagent with a basename FILE_LIST (files read from `memory/`) and stamp
  the manifest directly (`save_manifest` subset, `scan_corpus=None`) —
  `_stamped_manifest_files` can't resolve bare names against the repo root
  and would re-queue every file forever.
