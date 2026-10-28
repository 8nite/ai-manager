---
name: agy-turn-failures
description: Diagnosing agy "exit status 1" and silent turn failures (not a manager bug)
date_modified: 2026-10-15
tags: [agy, debugging, harness]
links: [[harness-lifecycle]]
---

# agy turn failures ("exit status 1")

`exit status 1` rendered in the agy TUI (`> exit status 1` under the prompt)
is **agy's own turn-level failure**, not a manager/PTY/tunnel kill. Proven
2026-10-15: a pasted CRA notice arrived intact, agy guessed a CRA publication
URL to verify numbers, canada.ca returned 404, the fetch tool failed, agy
rendered `exit status 1`. The PTY later exited 0 (user deleted the session).
Paste size, tunnel, and remote-vs-local were all red herrings.

## Diagnose (all on the server host, no browser needed)

1. `~/.gemini/antigravity-cli/history.jsonl` (append-only) — proves what
   prompts actually arrived: `display` (truncated), `workspace`,
   `conversationId`, `type`. Last line = most recent prompt globally.
2. `~/.gemini/antigravity-cli/conversations/<id>.db` (sqlite, query
   read-only: `sqlite3 "file:<db>?mode=ro"`) — `steps` table holds the turn:
   failed steps carry `error_details` (e.g. `Failed to fetch document
   content at <url> ... status code 404`). Live DB has a `-wal` sidecar;
   `mode=ro` reads safely through it.
3. `~/.gemini/antigravity-cli/log/cli-<date>_<time>.log` (symlinked as
   `cli.log` → newest) — per-process startup/auth/model lines. Look for
   `failed to apply model override` (fires at startup before auth completes;
   usually resolves after keyring auth — red herring unless persistent) and
   `authenticated via keyring` (headless systemd units can fail keyring
   unlock: `failed to unlock correct collection`, falls back to file token).
4. Manager side: `[pty] <key> exited code=<c>` journal lines (see
   `src/server/pty.js`) distinguish clean quits (code 0, user deleted/
   resumed) from crashes. `AI_MGR_DEBUG_PTY=1` adds paste-input previews;
   unset after use (paste contents land in the journal).

## Notes

- `agy models` lists valid ids (e.g. `gemini-3.8-flash-high`); the manager
  default lives in `src/server/backends.js` (`AGY_MODEL` overrides).
- `~/.gemini/antigravity-cli/crashes/` crash logs were 0-byte here; the
  sqlite `error_details` was the actual evidence.
