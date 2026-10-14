---
name: manager-proxy-remote
description: ai-manager tunnel-proxy fixes for remote web harnesses (2026-10-09)
date_modified: 2026-10-10
tags: [ai-manager, proxy, tunnel, regression-tests]
links: [[opencode-v2-web]], [[prod-web-testing]]
---

# Manager proxy fixes (remote web harnesses)

Two bugs blocked opencode web UI through the tunnel (`/s/:id/`, `/harness/:id/`).
Both reproduced only via the proxy path — direct-port local iframes always worked.

## 1. `/api/*` swallowed by manager 404

Backend clients call root-absolute `/api/*` (`/api/event` SSE). `index.js` 404'd all
of `/api/` before the asset fallback. Fix: `proxy.apiBackendMiddleware`, mounted
**before** `express.json()` (bodies stream intact), proxies non-manager paths to the
`aimgr_active` backend. Manager-owned paths matched by `isManagerApiPath`
(state, workspaces, sessions±ensure/touch, consoles, pty stream/input/resize).

## 2. Route shim for SPA boot

Backend served at a foreign subpath → client router crash. For session-root HTML
docs via explicit prefixes, proxy injects
`<script>/*aimgr-route-shim*/history.replaceState(null,"","/")</script>` after
`<head>` and appends its sha256 to `script-src` (see [[opencode-v2-web]] CSP).
Details that bit: 3-arg `replaceState` (2-arg is a silent no-op); hash must cover
the exact inline text incl. comment; force identity encoding for surgery; delete
upstream `transfer-encoding` when setting `content-length` (strict tunnel parsers
fail on both present); injection is idempotent via marker comment.

## 3. Stable upstream auth (auto-connect, no server picker)

v2 `serve` mandates Basic auth with a random per-process password → every iframe
401'd into a manual server picker. Fix (`src/server/opencodeAuth.js`, new):
single manager-held secret, `~/.ai-manager/opencode-password` (generated once,
0600; override `AI_MGR_OPENCODE_PASSWORD`). Deliberately **ignores**
`$OPENCODE_SERVER_PASSWORD` — inside opencode-hosted shells that var holds the
*outer* server's per-process password; reusing it flips secrets across restarts.
`backends.js` launches opencode with `OPENCODE_SERVER_PASSWORD=<secret>`;
`proxy.js sanitizeHeaders` strips browser auth and injects
`Authorization: Basic …` upstream (HTTP and WS upgrade); `app.js` routes all web
iframes through `/s/:id/` (never direct `127.0.0.1:port`, which would prompt).

## 4. Pre-created chat bound to workspace (no project picker)

Opencode projects are global (shared DB), so a fresh UI always asks which
project — even though ai-manager already picked the workspace. Fix
(`src/server/sessions.js` `ensureHarnessSession`, exported for tests):
after backend port opens, `POST /api/session {location: {directory: ws.path}}`;
stored as `harnessSessionId`; verified on ensure (`GET`, recreate on 404,
keep on transient); 5xx retried 5×1s (backend answers TCP before its API is
ready — one live 503 seen). `explicitMiddleware` passes the id as
`shimSessionId`; the shim then `replaceState`s to
`/server/<base64url(location.origin)>/session/<id>` computed **in-browser**
(origin differs local vs tunnel, so it can't be baked server-side) with a
per-script CSP hash (`shimBodyFor`/`hashForBody`; legacy `/` body+hash unchanged).
dsh sessions (no chat id) keep the `/` shim. Result 2026-10-09: 8/8 opencode
sessions bound; new UI-created session landed directly in chat (prompt box, no
`Add project`/chips), verified via agent-browser incl. prod tunnel (see
[[prod-web-testing]]).

## Regression coverage (`tests/proxy.test.js`)

- `isManagerApiPath` manager/backend split.
- Shim predicate/injection/CSP unit tests + `proxyRequest` shim end-to-end.
- Wiring test with isolated store (`store._resetForTest` + tmp file) and stub
  backend: pinned root returns shimmed HTML + focus cookie, assets pass through,
  `/api/event` reaches backend (401, not 404), manager routes/cookieless fall through.
- Auth injection: stub echoes `authorization` → equals `opencodeAuth.authHeader()`.
- Session deep-link: `shimBodyFor` (legacy body for null/empty; session route +
  `btoa(location.origin)` + sanitized id; payload chars stripped), per-body CSP
  hash, `explicitMiddleware` end-to-end asserts the chat id in session-root HTML.
- `ensureHarnessSession` against stub backend: pre-create POST carries workspace
  dir, GET-verify avoids recreate, dangling id (404) recreates.
- `backends.test.js`: opencode env pins `OPENCODE_SERVER_PASSWORD` to the
  manager secret.
- Test-process hygiene: a failing async proxy test that never closes its stub
  server hangs `node --test` past the 120s tool timeout — always `srv.close()`
  on every path (or assert before listen resolves); run single files with
  `timeout 60 node --test tests/<f>.test.js` to isolate.
- Test-editing hygiene (bit twice 2026-10-09): NEVER replace a `test("name"…`
  header line to "add" a test — it renames/deletes an existing one. Append new
  tests at end-of-file with full anchored context, then `grep -n "^test("` to
  confirm the count grew by exactly the addition.
- Self-contained fakes: the droid-fallback test once depended on a hand-made
  `/tmp/fake-droid.sh` and broke after `/tmp` cleanup — generate fakes inside
  the test (`os.tmpdir()` + `fs.chmodSync 0o755`).

## 5. dsh token flow (2026-10-09, four layered bugs)

dsh `web --port` prints `http://127.0.0.1:<p>/?token=<tok>` and 401s without it.
Fix chain (`sessions.js` capture + `proxy.js` injection), each layer found by
experiment:

1. **Cold start > 20s**: first `npx` downloads heavy deps (libreoffice wasm);
   `waitForPort` timed out. Fix: per-harness `bootTimeoutMs` (dsh 120s) +
   `--no-open` default arg.
2. **Token capture**: stdout tapped at spawn (`_dshOut` ring buffer), regex
   `[?&]token=([A-Za-z0-9_-]{8,})`, 15s window; stored as `harnessToken`,
   cleared on respawn (tokens rotate per boot).
3. **Cookie stripping**: proxy used to delete ALL upstream `set-cookie` → dsh
   303 handshake looped forever. Fix: `stripAimgrCookie` forwards backend
   cookies, strips only `aimgr_active`.
4. **Single-phase token**: repeating `?token=` WITH the session cookie
   re-triggers the handshake (303 loop). Fix: `hasBackendCookie` gates
   `withToken` — token only until the `dsh-auth-*` cookie exists. It MUST match
   that prefix: an early generic version counted `oc_locale`/`aimgr_active` as
   backend cookies, skipped the token, and dsh 401d (found via in-page fetch
   returning 401 + Express headers).
5. **Forwarded-host poisoning**: dsh validates its cookie against perceived
   host; `X-Forwarded-Host` (manager origin) broke verification → 303 loop.
   Fix: skip forwarded headers for token-authed sessions (opencode keeps them;
   its server-key depends on manager origin).
6. **Foreign Basic header**: cookie + token + opencode `Authorization` →
   re-challenge 303 (verified by matrix). Fix: `skipAuth` for token-authed
   sessions (`sanitizeHeaders` opts object).
7. **SPA reads token from browser URL**: shell rendered "authentication
   required" until `?token=` was in the address bar. Fix: `explicitMiddleware`
   302-redirects dsh session roots once to `?token=` (no backend cookie yet).

Cookie matrix that pinned it (all direct, current token): none+token→303,
dsh-cookie-only→200, token+cookie→303, +Basic→303, +X-Forwarded→(masked).
Result: dsh loads authenticated locally ("DeepSeek Harness", workspace
chooser is dsh-internal). dsh has no chat pre-create (no harnessSessionId).

## 5b. Stale cookies across restarts (verified 2026-10-09, no change needed)

Open question was whether pre-restart `dsh-auth-*` cookies die with token
rotation. Matrix post-restart (token rotated YES): old cookie alone → 200
(auth state is persistent, not boot-bound); old cookie + new token → 303;
stale bookmark (`?token=new` + old cookie, followed) → 200. Via proxy with
old cookie → 200 (token correctly skipped). Every path converges — recorded
edge case, nothing to fix.

## 6. Graceful shutdown (orphan backends)

`shutdownAll` SIGTERMs but `process.exit` could precede the 3s SIGKILL
fallback → orphaned dsh (pid 706389 held 4111 after a restart, PPID reparented
to systemd). Fix: `sessions.webProcCount()` (prunes reaped) + `index.js`
shutdown waits bounded 5s for zero before `server.close`. Verified post-fix:
every `41xx` listener maps to a live session.

## Testing lesson (2026-10-09)

CLI (`opencode run`) and local direct-port flows cannot stand in for the prod
proxy path. A "pass" on those hid both bugs. The wiring test above exists so the
proxy↔browser contract is asserted without a browser.

## Graph note (2026-10-09, verified)

The route-shim↔CSP-hash link is explicit in `src/server/proxy.js`
(`crypto.createHash("sha256").update(ROUTE_SHIM_BODY)` — hash recomputed live and
matched). Model it as an EXTRACTED `shares_data_with` edge, confidence 1.0, not INFERRED.

## 7. Opencode follow-up default: queue instead of steer (2026-10-10)

Follow-ups sent while a session is busy steered the active turn (opencode
default). There is **no server-side knob**: `https://opencode.ai/config.json`
schema has no follow-up key, and the composer always sends an explicit
`delivery` (`route-*.js`: `delivery:()=>e.working()?e.behavior():\`steer\``,
`behavior` = `followUpBehavior` setting). The setting is per-browser
localStorage `opencode.global.dat:settings.v3` (JSON, schema-decoded with
defaults — partial blobs safe), default `steer` (verified in v2.0.26 bundle
`runtime-*.js`). API: `POST /api/session/:id/prompt|command {delivery?}`,
`PATCH .../inbox/:id {delivery}` (`steer|queue`).

Fix (`src/server/proxy.js`, two layers, "queue default, steer allowed"):

1. `withQueueDefault(method, upstreamPath, body)` in `proxyRequest`: fills
   `delivery:"queue"` on `POST /api/session/*/prompt|command` only when
   missing/null/""; explicit values pass through byte-identical; fail-open on
   non-JSON. Covers API callers; browser traffic always sends explicit values
   so this never fires for it (by design).
2. `WEB_DEFAULTS_SEED_BODY` + `injectWebDefaults(html)` on session-root
   HTML docs (same gate as the route shim, own CSP sha256 via
   `shimCspHeaders`): seeds client defaults **only when absent** — fresh
   browsers default to queue, an explicit user choice (even steer) is never
   overwritten, Settings toggle keeps working. (Supersedes the earlier
   same-day `QUEUE_SEED_BODY`/`aimgr-queue-seed` iteration; renamed when dark
   mode joined the seed — old blobs preserved, verified.)

Verified: 4 new tests (`tests/proxy.test.js`, 40/40 full suite); live stub
served both scripts with matching CSP hashes; headless `agent-browser`
against an isolated scratch manager (port 4001, store + backend ports
separate — live 4000 untouched): fresh origin got exactly
`{"general":{"followUpBehavior":"queue"}}`, app booted fully on the partial
blob, pre-existing steer blob survived reload byte-identical. Scratch
torn down (session deleted → backend reaped, manager SIGTERM, /tmp cleaned).
Caveat: browsers that already saved Steer keep it until flipped in
Settings → General → Follow-up behavior (indistinguishable from an explicit
choice — deliberate). `browser-harness` CDP unusable on this box (see
[[browser-automation]]); `agent-browser` headless worked.

## 8. Dark-mode default via the same seed (2026-10-10)

Opencode theme storage (v2.0.26 bundle `index-*.js` + preload script in `/`):
`opencode-theme-id` (default `oc-2`), `opencode-color-scheme`
(`system`|light|`dark`, default `system` = follow OS), cached
`opencode-theme-css-<light|dark>`. Settings → General has theme + colorScheme
rows; `setColorScheme` writes the key. Folded into `WEB_DEFAULTS_SEED_BODY`:
seeds `opencode-color-scheme="dark"` when absent (same guard semantics as
queue). Verified headless on the scratch manager: pre-existing profile got
`dark` + `dataset.colorScheme==="dark"` + `#080808` background; explicit
`light` survived reload and booted `#fafafa`. Old queue-only blob from the
earlier iteration preserved (rename is backward compatible).

## 9. Hidden top titlebar in embedded views (2026-10-10)

Opencode has no hide-tabs setting (only `appearance.tabLayout:
horizontal|vertical`, default horizontal). First iteration hid only the tabs
strip (`[data-slot="titlebar-tabs"]`); per owner instruction, the **whole
titlebar** goes instead — the manager owns all of its jobs (switching,
new sessions, status). Fix (`src/server/proxy.js`): `NO_TITLEBAR_CSS` +
`injectNoTitlebar(html)` on session-root HTML docs —
`header[data-slot="titlebar-v2"],div[data-session-title]{display:none!important}`
using the app's stable attrs, not hashed classes. The second selector is the
in-chat session header (`<div data-session-title class="pointer-events-none
sticky top-0 ...">` with the `opencode · <ws>` title + context/session buttons);
without it the embedded view kept a redundant top bar after opencode moved the
chrome. Inline `<style>` needs no CSP edit
(backends serve `style-src 'self' 'unsafe-inline'`).
Verified: unit + e2e tests (full suite 42/42 green); headless
`agent-browser` on scratch manager (strip iteration: computed `display:none`,
screenshot clean; titlebar iteration: unit/e2e). Scratch torn down as usual.
Deployed via service restart per AGENTS.md (restart also survived by the
agent session itself; 14/14 opencode backends recovered on identical ports,
2 pre-existing dead dsh adopted to pty-finished by design).
2026-10-10 follow-up: `div[data-session-title]` added to the same rule (full
suite 43/43, e2e 16/16 incl. new "session header hidden" assertion).

## 10. E2E script for embedded-UI changes (2026-10-10)

`scripts/e2e-web-defaults.sh` (`npm run test:e2e`, documented in AGENTS.md):
isolated scratch manager (own port/store/harness ports) + real opencode
session + headless `agent-browser`. Asserts served-HTML markers + CSP hashes,
fresh-browser seeds (queue/dark), dark boot, titlebar/session-header/tabs
hidden, no router crash, explicit choices preserved. Never sends a prompt (would run a billed
agent turn); delivery rewrite covered by stub tests. First run caught 2
script bugs (JSON-quoted eval output; child of `display:none` still reports
own `display`) — both fixed, 15/15 green at the time; session-header
assertion added later (§9 follow-up), 16/16 green 2026-10-10.

## 11. Tunnel stall → opencode `Transport: Timed out` (2026-10-12)

Symptom: remote browsers showed `ClientError: Transport: Timed out waiting
for the server to respond` (thrown from opencode web `runtime-*.js`, which
aborts any non-`/api/event` fetch with no response headers in 60s).
Gateway logs showed tunneled requests taking 20–100s+ (ingress upstream
106s) while local loopback was 1–100ms.

Root cause: the tunnel WS TCP upload stalled — `ss` showed 3.3MB in Send-Q
to `ai-manager.nexvision.cc:443` on the tunnel pid, ping jitter 68–622ms
(mdev 190ms). Single-TCP multiplexing = head-of-line blocking for all
in-flight; requests hung until the gateway 5min timeout. Neither endpoint
noticed: the client had no keepalive/send-stall detection (no close event
on a half-open socket), and the gateway only pings after 60s silence.

Diagnosis shortcut: `ss -tnp '( dst 172.93.53.224:443 )'` Send-Q on the
tunnel pid; gateway `/health` `inFlight` climbing with `← … 3000xxms
request timeout` cleanups. Immediate relief: `systemctl --user restart
ai-manager-tunnel.service` (gateway 502s the stale in-flight, browsers
auto-reconnect; backends untouched, PIDs identical).

Fix (this note's change set):
- `scripts/ai-tunnel.js`: 10s watchdog recycles the socket when
  `bufferedAmount > 1MB` sustained 30s or no inbound frame for 90s
  (`shouldRecycleTunnel`, pure + unit-tested in
  `tests/tunnel-watchdog.test.js`); boot section guarded by
  `require.main === module` so tests can require it. Terminate feeds the
  existing close→backoff→reconnect path.
- `k8s/ai-gateway/deploy.yaml` ingress: `proxy-next-upstream:
  "error timeout http_502 http_503 http_504"`, tries 3, timeout 30 —
  transparently retries the reconnect-window 502s (single replica = same
  pod). Applied via `kubectl apply -f` (Deployment unchanged, no rollout).
- Note: opencode frontend concurrency/timeout internals (`limit 4`,
  `headersTimeoutMs 60s`, `POST /api/worktree` 600s) live in its bundled
  `runtime-*.js`; bump asset name per opencode release when grepping.
