---
name: session-title-sync
description: Backend auto-title pull-back + rename write-through (2026-10-10)
date_modified: 2026-10-10
tags: [frontend, rename, opencode, title-sync, app.js]
links: [[sidebar-rename-race]], [[opencode-v2-web]]
---

# Session title sync (backend ⇄ manager)

Symptom (2026-10-10): creating a session then prompting in the iframe never
updated the left-panel name — it kept the stale creation title
(`opencode · <ws>`) forever.

Root cause: opencode runs a hidden title agent that renames the **backend**
chat after the first prompt (`PATCH /api/session/:id {title}`, verified 204),
but the manager pre-created that chat with its own title and never pulled the
change back. The manager's `session.title` was write-once at creation.

Fix (all in `src/server/`, no frontend change — the 8s `refresh()` poll
repaints the sidebar on its own):

- `sessions.js syncSessionTitle(id)` — `GET /api/session/:hid` (2.5s
  timeout), adopt when non-empty + different (truncate to 120). Skips pty /
  unbound sessions; never throws (backend down → keep local title).
- Fallback (2026-10-10, v2.0.26: the backend title agent does NOT always
  rename — a bound chat with user "hi" + assistant replies kept the default
  title, verified live): when the backend title is stale (empty or still the
  creation default) AND the local title is still default-like
  (`defaultTitleFor` exact match or `opencode · ` prefix), derive from the
  earliest user message via `GET /api/session/:hid/message`
  (`type === "user"`, sort by `time.created`, trim/collapse/truncate 120)
  for LOCAL display only. The derivation is NEVER pushed back (2026-10-10
  fix: pushing planted a non-default title on the backend and pre-empted
  opencode's own title agent — backend titles were exactly first-messages
  truncated to 120 instead of smart summaries). Likewise a stale backend
  default never reverts a local derived/custom title; a later real backend
  title always wins on pull. Custom local titles are never derived
  over — converged custom titles return after 1 backend hit, no message
  fetch. No messages → default kept as-is.
- `sessions.js syncAllSessionTitles()` — concurrent `Promise.allSettled`
  batch over bound opencode chats. Awaited (best-effort) by
  `GET /api/state`, `GET /api/sessions`, and `POST …/ensure`.
- `sessions.js pushTitleToHarness(id)` — `PATCH` write-through after every
  manager rename, so a later pull-back can't revert the user's rename to the
  stale backend copy. `PATCH /api/sessions/:id` route awaits it
  (best-effort, logs on failure).
- `backendApi` gained an optional 5th `timeoutMs` arg (default 10000 —
  existing callers unchanged).

Verification without a billed turn: the e2e simulates the title agent with an
out-of-band backend `PATCH` (Basic auth from
`~/.ai-manager/opencode-password`), then polls `/api/state` for adoption +
sidebar repaint. The manager→backend direction is asserted by reading the
backend chat back after the `e2e-renamed` PATCH.

Regression coverage:

- `tests/sessions.test.js` (+5): adopt, no-op/skip, unreachable-never-throws,
  PATCH write-through, concurrent batch.
- Fallback (+3, updated 2026-10-10 for local-only semantics): derive-from-
  first-user-message with NO push-back, no-revert-of-derived-to-backend-
  default (0 message fetch), backend-smart-title-wins-over-local-derivation.
- `scripts/e2e-web-defaults.sh`: write-through + auto-title-adopted +
  sidebar-paints-auto-title + no-prompt-keeps-default guard (derivation
  itself is stub-tested — e2e never sends a prompt / billed turn).
