---
name: client-nav-switch
description: Single live SPA per pane via opencode router navigation (2026-10-13, seamless 2026-10-15)
date_modified: 2026-10-24
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

## Follow-up 2026-10-15 — seamless switch (no quit/reinit)

Switching back to a visited chat (or to an SSE-created chat) still quit +
reinited the opencode window. Root cause: opencode's client message store
(`y.run("session.message:"+hid)`, `solid-*.js`) is a one-shot cache, and the
`session.created` SSE event marks new chats complete — so warm switches make
ZERO repeat `/message` fetches. The old verify (wait for a NEW
`/api/session/<hid>/message` fetch) timed out after 6s, fell through to
`paintPane`, and spawned a second iframe.

- `syncOpencodeTabs()` seeds opencode's window-tab store
  (`opencode.window.browser.dat:tabs` + `tabs.info`) from manager state —
  all opencode chats plus workspace dirs — on `refresh()`, `paintPane()`,
  and every `clientSwitchSession`. Warms `m.session.info[id]` incl.
  `location.directory`, so `<Show when={directory}>` in
  `TargetSessionRouteContent` never unmounts the session view tree.
- `isSpaRoutedTo()`: fresh fetch for the hid OR active tab-link
  (`[data-titlebar-tab-slot][data-active="true"] a[data-slot="tab-link"]`)
  + mounted chat (`session-chat-panel` / `session-composer-dock` /
  `data-session-title`) OR mounted chat with no tab bar at all (titlebar
  hidden via CSS). Verify loop polls 25ms ×4 then 100ms; dispatches the
  native tab-link `mousedown` before `pushState` + `popstate`.
- `retargetFrameCache` re-keys BEFORE verify (rollback on failure), so
  concurrent paints and the iframe's dynamic api-scope prefix see the target
  mid-verify. `paintPane` reuses a live same-port frame (route it) instead
  of materializing a second iframe. `visibleWebFrame` recovers the cached
  frame after a PTY detour and rejects `about:blank`. `clientSwitchFrame`
  needs only mode + port (unbound targets still nav).
- `forceFrameReload` always reloads via `/s/:id/` `src` (proxy re-injects
  route shim + defaults + api-scope); bare `location.reload()` would serve
  the unshimmed fallback path.
- Proxy (`src/server/proxy.js`): api-scope reads
  `frameElement.dataset.sess` dynamically (`GP()`) instead of the baked boot
  prefix; `explicitMiddleware` falls back to the `aimgr_active` backend for
  sub-resources on a deleted boot-session prefix (reconnecting SSE).

## Verification

- Unit 142/142. Live probes: lane fires, ~400-600ms verify, correct
  target fetches through the origin session's `/s/` prefix (shared
  backend makes prefixes equivalent).
- E2E 0 failures (147 PASS): single document navigation across detour +
  return, live URL carries the target backend chat id, frame budget,
  loader show/clear, purge.
- 2026-10-15: unit 149/149, e2e 0 failures on isolated scratch
  (`MGR_PORT=4002 HARNESS_BASE=4450`). Pre-run: the prior e2e's shared
  orphan still held :4440 (`/active {}` + live store all on :4090) —
  reclaimed by pid before reuse, per [[shared-backend]].

## Follow-up 2026-10-16 — new sessions stay in the SPA (fast-accept fresh lane)

Creating a new opencode session felt much slower than switching: the button
showed a blank iframe + loader for seconds while server creates were instant
(measured live: manager POST 23ms, backend chat 18-94ms, ensure 2-3ms). Root
cause: a just-created chat was never fetched in the live document and had no
tab link yet, so the strict-only verify (fresh fetch / active tab) burned the
full ~6s and parked the loader on the 15s fallback (~21s total).

- `clientSwitchSession` (`src/public/app.js`) detects the fresh case locally
  (`seen === 0 && seenSess === 0`, i.e. zero prior resource entries for the
  hid) and settle-accepts once the route holds the hid with a chat view
  mounted across 5 consecutive polls (~200-500ms). Stale previous-chat panels
  swap out within frames of `popstate`, so the settle is safe; bad routes
  still fail via the navigation + href + `Unrecognised route!` guards, on a
  shorter 2s cap. Visited chats keep the full 6s strict lane unchanged.
- Workspace switch is free: `syncOpencodeTabs` runs before the route push and
  already seeds the new chat's `directory` from manager state, so
  `TargetSessionRouteContent` never unmounts on cross-workspace creates.
- Unit (`tests/switch-speed.test.js`, appended): fresh detection, shorter cap,
  settle + route guards, strict lane intact. E2E (new block after the routed-
  target assert): clicks the real top-bar New Session button and asserts the
  live view lands on the new chat with no new document and a prompt loader
  clear. Result: `new session inits client-side (2s, one document, on new
  chat)`; full loop 2026-10-16: unit 153/153, e2e 157 PASS / 0 FAIL.

## E2E assert hardening (2026-10-24, also in AGENTS.md)

- Same-document asserts: a reloaded/new iframe document also reports
  `navigation.length == 1`, so `navs==1` alone never proves "no reboot".
  Prove it with monotonic signals instead: pre-existing resource entries
  for the OLD chat surviving the switch (a reload wipes them) +
  loader-clear timing with a bound far from both outcomes (~2-4s fixed vs
  ~21s broken). Frame counts include the static skeleton (budget 1..3,
  not exactly 1).
- Never leave the pane on a session you then delete: restore a live
  session first (switch back + brief settle) or later switch/purge asserts
  cascade into unrelated failures.
