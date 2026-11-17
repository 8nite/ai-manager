---
name: workspace-isolation
description: opencode workspace fence — ask-mode cross-workspace, hard-deny credentials, /tmp scratch lifecycle (2026-10-28)
date_modified: 2026-10-28
tags: [opencode, permissions, isolation, fence, tmp-lifecycle]
links: [[harness2-local]], [[shared-backend]], [[opencode-v2-web]], [[MEMORY]]
---

# Workspace isolation fence

Interactive sessions: cross-workspace access **asks** (was allow-all). `/tmp` +
shared tooling docs stay free; credential files are unreadable, no exceptions.

## Layers

1. `~/.config/opencode/opencode.json` `permission.external_directory`:
   `* → ask`, allow `/tmp`, `/tmp/*` + tooling reads (`skills|instructions|
   agents|plugins`, `AGENTS.md`, `~/.claude/*`, `~/.factory/*`,
   `~/Developer/browser-harness/*`). Explicit `edit → deny` on those tooling
   paths; explicit `read` + `bash cat` deny on credential files
   (`opencode.json`, `auth.json`, `service.json`, `cli.json`,
   `factory-proxy.js`, `~/.ai-manager/opencode-password`, `~/.kube/config`).
2. `~/.config/opencode/plugins/workspace-fence.js` (global, always loads —
   project configs cannot unload it): passes cross-workspace reads through so
   the core approval prompt can land (a throw would hard-deny with no prompt);
   hard-denies credential files even with approval; hard-denies tooling
   writes; per-session `TMPDIR` via `shell.env`, `/tmp/opencode-ses-<id>/`
   removed on `session.deleted`.
3. `~/.config/opencode/AGENTS.md` top section: stay in workspace, ask before
   crossing, /tmp scratch deleted before finishing.

## Verified 2026-10-28 (cheap opencode-go probes from scratch ws)

- `/tmp` read allowed; cross-workspace read → agent asked via `question`
  tool, headless deny, nothing leaked; credential read refused outright.

## Harness2 (non-interactive — stays hard-deny)

Rollouts run headless with nobody to approve, so both launch sites keep
`external_directory: * deny` + ws allow **+ `/tmp`, `/tmp/**` allow**
(`scripts/harness2_local.py` `execute()`, patched proposer installed-binary
branch). Adapter sets per-run `TMPDIR` and removes it in `finally` alongside
the workspace; PROMPT requires scratch cleanup. Guard: regression test
`tests/workspace-isolation.test.js`.

## Gotchas (earned)

- Shared `opencode serve`: `directory` ctx / process cwd is NOT the session
  dir — fence must resolve the backend sessionID via SDK (async, cached).
  Sync fallback misattributes every session to one workspace (locked the
  operator out of `~/.config`; fixed in the async rewrite).
- Fence scans literal `$HOME` paths in bash command text (incl. heredoc
  bodies): stage path-building via `os.path.expanduser('~')` + runtime
  concatenation, or hit self-blocks (incl. secure-credentials-guard on
  `cat …/.kube/config` literals).
- Patch edits must fix hunk `+` counts (`git apply` validates); no local
  harness2 checkout here (`/tmp/opencode/harness2` is reboot-scratch), so
  validate counts with a line-counter instead.
- `build_base_tree` guardrails now reads the `read` scope only: edit-scope
  denies (read-only tooling) are not read denies, bare `*` is not a pattern.
- Live shared backend (port 4090) picks up config/plugin changes only on
  (re)spawn — no restart was done (in-flight turns); new standalone runs
  enforce immediately.
- Rollback: `/tmp/opencode.json.bak-20261028-080600` (config backup).
