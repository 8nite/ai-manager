---
name: client-nav-switch
description: Single live SPA per pane via opencode router navigation (2026-10-13)
date_modified: 2026-10-13
tags: [ai-manager, frontend, sessions, performance, opencode]
links: [[session-switch-cache]], [[shared-backend]], [[asset-cache]], [[opencode-v2-web]]
---

# Client-side session switching (no SPA reboot)

Even with the shared backend, every switch booted a full SPA document
(bundle re-parse, new SSE stream, ~19 API calls). Opencode's SPA owns a
client router (`/server/:key/session/:id`, TanStack), so the manager now
keeps ONE live frame per pane and navigates its route instead.

## Mechanism (`src/public/app.js`)

- `clientSwitchFrame(pane, target)` — eligible iff target is a bound web
  session with a port AND the visible frame is same-origin readable AND its
  session is on the SAME port (cross-backend targets always full-load).
- `clientSwitchSession(frame, hid)` — `history.pushState` to
  `/server/<base64url(location.origin)>/session/<hid>` + synthetic
  `popstate`; the router swaps the chat with data fetches only. Verified
  live: target message fetch appears, zero new navigations, chat content
  renders (headless probe, no reload).
- Verify loop (≤6s): fail on any new navigation, href losing the hid, or
  timeout → fall through to the full document load. Never throws.
- `retargetFrameCache` — re-keys the cache onto the shown session and
  drops every other cached document (hidden SPAs burn memory + SSE).
- `tryClientSwitch` lane in `setPaneSession` (extracted helper: the
  switch-speed structural asserts parse that function's shape). Decided
  BEFORE `paintPane` — painting a miss materializes a second document and
  defeats the lane (caught live: `frames:2` with the lane reporting
  success). Unbound targets skip the lane (no chat to route to). Backend
  pid-change also recovers via nav (same port), no reload.
- Narration re-targeted explicitly after nav (no `load` event fires).

## Gotchas

- Frame `src` attribute goes stale after nav — only `dataset.sess`
  identifies the shown session. E2E mark/purge checks match it first.
- `agent-browser eval` returns JSON-encoded output: decode via
  `python json.load` before grepping (raw grep misses through backslashes).
- Async-verify asserts must POLL (loader-clear read once at +3s flaked
  against the ≤6s verify on a loaded box).
- switch-speed.test.js parses `setPaneSession` textually (6000→8000-char
  window, no post-paint re-probe, no re-observe in completion block):
  keep lane code out of that function or extend the window with a comment.
  A comment containing the parsed literal itself breaks it (hit live).

## Verification

- Unit 142/142. Live probes: lane fires, ~400-600ms verify, correct
  target fetches through the origin session's `/s/` prefix (shared
  backend makes prefixes equivalent).
- E2E 0 failures (147 PASS): single document navigation across detour +
  return, live URL carries the target backend chat id, frame budget,
  loader show/clear, purge.
