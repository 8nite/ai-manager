---
name: web-attention
description: opencode web working/waiting attention model via backend polling (2026-10-10)
date_modified: 2026-10-12
tags: [ai-manager, opencode, attention, activity, polling]
links: [[opencode-v2-web]], [[harness-lifecycle]], [[attention-dismiss]], [[session-title-sync]]
---

# Web attention: opencode working/waiting via backend polling

**Problem (2026-10-10):** the attention shelf never fired for opencode
sessions. `activityFor()` mapped every `running` web session to `"running"`
("we can't see inside the iframe"), and the shelf only lists `"waiting"`.

## Backend signals (`sessions.js getWebActivity`, per own-port backend)

- `GET /api/session/active` → `{data: {ses_id: {type:"running"}}}` lists the
  foreground drains owned by THAT backend process. Membership of our
  `harnessSessionId` = agent generating → `working`.
- `GET /api/session/<hid>/message?limit=1&order=desc` → newest message:
  - none → `running` (fresh chat, available — not attention).
  - assistant WITHOUT `time.completed` → `working` (streaming race).
  - user newer than `PICKUP_GRACE_MS` (15s) → `working` (pickup race).
  - else (assistant completed, `idle` outcome msg, stale user) → `waiting`
    with `idleMs = now - (completed || created)`.
- `GET …/permission` + `GET …/form` (only when active): non-empty overrides
  `working` → `waiting` — the turn is blocked on the user even while the
  backend owns the drain.
- Any probe failure fails OPEN to `null` (falls back to process status —
  never false attention). Only TCP-refused + no live child handle is
  recorded (`_webUnreachable`) so `syncAllWebActivity` can flip the session
  to `exited` (adopted backends have no exit event; see [[harness-lifecycle]]
  adoption).

## Plumbing

- Pure decision `webActivityFromSnapshot(snap, now)` — unit-tested matrix in
  `tests/activity.test.js` (no backend needed).
- `syncAllWebActivity(1500)` refreshes the `_webActivity` cache ahead of
  every `GET /api/state` + `GET /api/sessions` (alongside the title sync);
  `activityFor()` reads the cache, falls back to process status on miss.
- Frontend unchanged: shelf, `waiting` filter/counts, palette `ATTN` items
  and dashboard feed all key off `activity === "waiting"`.
- Verified live 2026-10-10: background done sessions → `waiting` with
  `idleMs`, in-flight turn → `working`, fresh chats → `running`.
