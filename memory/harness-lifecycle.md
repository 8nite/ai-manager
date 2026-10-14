---
name: harness-lifecycle
description: ai-manager session/workspace lifecycle fixes (dedup, droid fallback, shutdown, restart semantics) 2026-10-09
date_modified: 2026-10-11
tags: [ai-manager, sessions, droid, agy, workspaces, shutdown, systemd, deploy]
links: [[manager-proxy-remote]], [[prod-web-testing]], [[harness-switch]]
---

# Harness lifecycle fixes (2026-10-09 E2E)

## Workspace dedupe (`sessions.js createWorkspace`)

Opening the same folder twice created duplicate workspace groups (found live:
two `aimgr-e2e` groups). Fix: return the existing workspace when resolved path
matches. Verified: re-POST returns the original id.

## droid resume fallback (`sessions.js startPty` + `pty.js onExit` hook)

`droid resume --last` exits instantly (`No sessions found`, code 1) when the
folder holds no droid conversations — after every manager restart both droid
sessions were dead (`finished`). Fix: `pty.spawn` accepts `opts.onExit`; droid
resume-exits with that message respawn once with plain interactive args (lands
on the device-auth wall, but alive and actionable). Loop-guarded (fallback has
no hook). Tested with a self-contained fake-droid script.

## droid auth wall (environment, NOT a bug)

`droid doctor`: access token expired 2026-10-03, refresh fails → `not logged
in`. New launches print `https://auth.factory.ai/device` + code and wait.
Completing it needs a user browser + Factory account; automation stops here.
Manager mechanics around it all verified: PTY spawn, SSE stream, POST input,
`waiting`/`finished` activity, kill/delete.

## Old droid session (pre-existing)

`sess_02619e68bfaf` was already dead before testing (resume with no history in
that folder). Fallback now keeps it alive at the auth wall like the others.

## Restart semantics (learned 2026-10-10 — agent shell killed by own deploy)

An agent restarting the manager from inside a manager-hosted session got
`(no output) Killed by SIGTERM` mid-command. Root cause: the agent's shell
runs in the unit cgroup (`.../app.slice/ai-manager.service`, parent chain
bash → `opencode serve` backend → manager node), and the unit used systemd's
default `KillMode=control-group` — stop/restart SIGTERMs every process in
the cgroup, including the invoking shell. Worse, it also SIGTERMed the web
backends `shutdown()` deliberately leaves alive: after one UI-only restart
all 4 `opencode serve` backends had NEW PIDs (respawned, in-flight turns
interrupted), even though `restoreAll` reported them `running`.

Fixes (AGENTS.md "Deploy" two-path rule + unit flag):

- Unit sets `KillMode=process`: only the main node process is signaled.
  Verified live 2026-10-10: chained restart completed (shell survived), all
  4 backend PIDs identical pre/post (adopted, not respawned), 4/4 sessions
  `running`. Guard: `tests/deploy-unit.test.js` asserts the flag.
- UI-only changes (`src/public/*`) skip the restart entirely —
  `express.static` serves per request, so workers are untouched by
  construction; verify live bytes via curl instead. Only `src/server/*`
  needs a restart (+ pre/post backend-PID comparison, not just statuses).
- PTY workers (droid/dsh) are still reaped by `shutdownAll()` on every
  restart by design — no KillMode saves them; survival would need
  don't-kill-on-shutdown + PTY reattach machinery (does not exist).
- Bonus data point: an earlier manual `SIGKILL` of the unit swept the whole
  cgroup (every hosted session died); graceful `restart` under
  `KillMode=process` no longer has that collateral.
- Scratch e2e can't cover systemd-unit behavior (it uses `nohup`, no cgroup
  sweep — which is exactly why its "restart adopts backend" test always
  passed while production respawned). Unit-level live PID comparison is the
  guard instead.

## agy harness (added 2026-10-11, verified live)

Antigravity CLI (`agy`, v1.3.3) as a PTY harness like droid
(`backends.js` + `sessions.js ptyArgsFor` + switch/pills/styles + e2e block).
Default `--model gemini-3.8-flash-low` (`AGY_MODEL` / `AGY_ARGS` / `AGY_BIN`
overrides mirror `DROID_*`/`DSH_*`).

- First boot in an untrusted folder stops at a trust prompt (Enter accepts;
  persisted globally in `~/.gemini/antigravity-cli/settings.json`
  `trustedWorkspaces` — no repo pollution). E2E deliberately does NOT accept
  it: the prompt banner itself proves boot, and accepting would litter global
  trust with the scratch dir.
- `--model <id>` prints a spurious `not recognized … Ignoring the flag`
  warning on 1.3.3 (both id and display-name forms) but STILL takes effect
  (status bar shows the requested model; verified Low, High-default, GPT-OSS).
- Resume: `--continue` continues the most recent conversation GLOBALLY (not
  per-folder like droid `resume --last`) — keep one agy session per
  workspace or set an explicit id (`--conversation`). A bad `--conversation`
  id degrades to a fresh session with a warning (no exit loop), so agy needs
  no droid-style onExit fallback.
- Live round-trip on flash-low works (PTY prompt → `agy-ok` reply).
- E2E agy block: API create → `agy pty running` → SSE stream contains
  `Antigravity` → delete. Never sends a prompt (no billed turn).

## Web-backend adoption across restarts (added 2026-10-10, verified live 2026-10-12)

Deploy restarts used to SIGTERM every `opencode serve` child and respawn —
interrupting in-flight turns. Now web backends survive and are adopted
(`sessions.js tryAdoptBackend`, called first in `startWeb`):

- `shutdownAll()` no longer touches web backends (PTY sessions still die —
  their stdio IS the pty). `index.js shutdown()` closes immediately, no
  graceful-wait window. Unit uses `KillMode=process`, so only the main node
  process is signaled either way.
- Spawn uses file stdio (`~/.ai-manager/backend-logs/<sess>.log`, rotated
  past 5MB) + `unref()`: a broken stdout pipe after manager exit would
  SIGPIPE the orphan, so pipes are gone (dsh token-capture handlers are
  guarded — dsh is pty-mode and never reaches `startWeb` anyway).
- Adopt rule: port answers TCP within 2s AND `/api/info` answers AND
  `GET /api/session/<hid>` is 200 → adopt (record `backendPid`), else spawn
  fresh. hid-404 with a live opencode occupant = stale orphan → SIGTERM its
  `/api/info` pid, reclaim the port. TCP-without-HTTP or non-404 errors =
  hands off (fail-open).
- `killSessionProc` also stops the recorded `backendPid` (verified against
  `/api/info` pid first — a recycled pid is never signaled). User delete
  still terminates the backend; only *shutdown* leaves them.
- Live proof 2026-10-12: `restart` → all 19 backend PIDs identical
  pre/post, 12/12 sessions `running`, in-flight `working` turn uninterrupted.
- E2E `restart adopts the live backend` block (scratch `kill` + reboot on
  the same store): asserts backend pid unchanged + status running + title
  intact. Run serialized on isolated ports (see AGENTS.md Test hygiene).
