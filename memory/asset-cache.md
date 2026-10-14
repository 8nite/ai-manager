---
name: asset-cache
description: Immutable proxy caching for opencode bundle assets (2026-10-13)
date_modified: 2026-10-13
tags: [ai-manager, proxy, performance, tunnel]
links: [[shared-backend]], [[manager-proxy-remote]], [[session-switch-cache]]
---

# Immutable bundle-asset caching (tunnel switch speedup)

Cold switches loaded ~160 hashed `/_assets/*` files with `Cache-Control:
no-cache`, each paying ~250-800ms WAN RTT through the gateway + tunnel —
tens of seconds per switch remotely. Server-side initiate/switch was
already fast (create 113ms, ensure 3ms, doc 3ms), so this was purely a
browser-fetch problem.

## Fix (`src/server/proxy.js`)

- `isImmutableAsset(subPath, method)` — GET-only, `/_assets/<file>` with no
  slashes/dotfiles (blocks `/_assets/../secret` games). Hashed filenames
  are content-addressed, so a year-long cache is safe.
- Non-shim 200s matching it get `Cache-Control: public, max-age=31536000,
  immutable` + `pragma`/`expires` stripped. API/HTML/SSE untouched (unit
  asserts `/api/event` keeps `no-cache`).
- Applies to all three proxy entries (`explicitMiddleware`, fallback,
  `apiBackendMiddleware`) since they share `proxyRequest`.
- After first load a switch costs doc + API only; repeat asset requests
  never leave the browser.

## Verification

- Unit 140/140 (`proxy.test.js` 29: predicate matrix + through-`proxyRequest`
  header asserts). Live: header confirmed on `:4000`, 9/9 sessions running,
  shared backend PID identical across restart.
- E2E: asserts for asset immutable, API not immutable, config MISS→HIT,
  and create-pre-warm HIT (the MISS-first expectation had to go once
  create warmed the cache — a passing test that contradicts the new
  behavior is a bug in the test). Full run 0 failures.

## Gotcha

- E2E serialization guard must NOT live in the same `bash -c` as the run:
  the wrapper cmdline contains the literal script name and `pgrep -f`
  self-matches → false ABORT. Pre-check in a separate call, then launch.

## Follow-up: workspace config GET cache (same run)

Waterfalling a real switch (iframe resource timing) showed opencode's SPA
refetches per-workspace config on EVERY switch: `/api/project|model|
provider|integration|config|location|vcs|shell` (~5-6KB each, ~7 sequential
RTTs ≈ seconds over the tunnel; `/api/model` is 96KB raw). Same
`?location[directory]=` answers identically for every session in a
workspace, so the proxy now caches them: allowlist-only, full-URL key, 30s
TTL, 200-entry LRU, global clear on any `/api` mutation, `x-aimgr-cache:
HIT|MISS` observability. Per-session state (messages, permission, active,
SSE) never cached — `/api/event` verified header-free and streaming.
Full-history fetch (`qD`, 200/page to exhaustion) is only the export-to-JSON
flow, not switch — opencode's own switch logic (20 recent messages) needed
no replacement.

Browser-cache counterpart: the server HIT only saves backend ms, but the
tunnel RTT is the real cost — so allowlisted paths also carry
`Cache-Control: private, max-age=30` (HIT and MISS): repeats within TTL
cost ZERO requests from disk cache. `private` keeps it out of shared
gateway caches. Opencode's client sets no fetch `cache:` mode and the
backend sends no validators, so default-mode fetch honors it.

## Remote measurement (prod, real browser, 2026-10-13)

Self-service login rebuilt from scratch (software WebAuthn P-256
fmt=`none` + `kubectl pending approve` of own device only; gotchas:
CBOR map must restore integer keys, DER assertion signature). One billed
micro-prompt on a throwaway session, deleted after. 5s-poll upper bounds:
create→row ≤5s, open→interactive (composer + models) ≤5s, send→reply
≤5s (model itself 1-3s of that).

Verdict vs the 2s bar: NOT met remotely. Floor analysis: each stage needs
2-4 sequential tunnel RTTs (measured 250-800ms, jittery) ≈ 2-3.5s even
with everything cached — message/permission/active can never be cached,
and the model takes 1-3s by itself. Sub-2s remote needs protocol-level
change (or the CLI path: droid PTY streams text, no bundle/waterfall).

Re-run variance (same flow, days later): send→reply ≈25s with an apparent
duplicate POST under a tunnel stall (two user prompts, one still Pending)
— p50 ~5s, p95+ ~25s+. The variance itself is the verdict: stalls, not
backend speed, dominate the tail. Possible tunnel retry/duplication hazard
under stall recycle; not chased (transport forensics from outside).
