---
name: prod-web-testing
description: How ai-manager prod web (ai-manager.nexvision.cc) was tested end-to-end via browser automation
date_modified: 2026-10-23
tags: [ai-manager, prod, webauthn, gateway, agent-browser, testing]
links: [[opencode-v2-web]], [[manager-proxy-remote]], [[browser-automation]]
---

# Prod web testing (2026-10-09)

Prod URL `https://ai-manager.nexvision.cc` requires gateway passkey login.
Self-service flow used by automation:

1. `POST /auth/register/begin {deviceName}` → `{options, challengeId}`
2. Software WebAuthn ceremony (P-256, fmt `none`, no hardware needed) → `POST /auth/register/finish`
3. `kubectl -n nexvision exec deploy/ai-manager-gateway -- gateway-admin pending approve <deviceId>`
4. WebAuthn login (`/auth/login/begin` + `/auth/login/finish`) → `opencode_sid` cookie (30d)
5. `agent-browser cookies set opencode_sid <v> --url https://ai-manager.nexvision.cc/ --httpOnly --secure --sameSite Strict`

## Gotchas (all hit live)

- simplewebauthn v13 (`k8s/ai-gateway`) requires **minimal-length CBOR** in
  authenticator data (`0x58+len`, not `0x59+u16`); non-minimal fails with
  "Leftover bytes detected while parsing authenticator data".
- v13 `verifyAuthenticationResponse` expects the assertion signature in **DER**,
  not raw R||S ("Too big integer" otherwise). Registration attestation itself is unaffected.
- **Approve only your own deviceId.** On 2026-10-09 an unrelated pending device
  (`318081f5… "K · Chrome"`, Android UA) existed; it was left pending.
- Login consumes a credential counter: must exceed stored (starts 0 after registration).
- Scratch scripts lived in `/tmp/opencode/` (ephemeral, not committed).

## Thoughtful loop (2026-10-09, all green)

New manager session (`sess_2f87e48e393c`, port 4107) → model picker checked →
PONG prompt → `PONG-ok-4107 /home/herbert/ai-manager 11` (cwd proof this host)
→ switched to another opencode session and back (same
`/server/<k>/session/ses_edd0ff1…` URL, response persisted) → same checks on
prod: manager UI + `/s/<id>/` loaded OpenCode remotely, test chat persisted
with identical response. "no-picker verify" session repeated the create→chat
landing after the [[manager-proxy-remote]] §4 fix; its reply also confirmed a
live model round-trip. Browser test sessions were deleted afterwards;
opencode-side chats (`ses_edd0…`) remain in the shared DB (harmless).

## Automated prod timing (2026-10-14, green)

`scripts/prod-session-timing.sh` (+ `scripts/prod-webauthn.mjs`, promoted
from `/tmp` with env-overridable paths): ms timers, prod login with
one-shot WebAuthn refresh, isolated (or `PROD_PROFILE`-persistent) browser,
create → interactive (composer + models call) → send-with-retry until the
prompt is server-observed → reply → delete. First green run (cold profile):
login 0.5s, page 11.5s, created 17s, interactive 27.6s, sent 33.9s, reply
39.9s (fast-turn). Cold numbers are bundle-download dominated; warm runs
via `PROD_PROFILE` skip that.

Script bugs fixed along the way (all test-side, product held):
- `agent-browser eval` output is JSON-encoded (often double): decode fully
  before matching; `.get` on a still-encoded str throws (page was fine).
- Reply check must be server-side (message counts + `working`→`waiting`
  activity), not text echo — a plain "hi" reply need not quote the prompt.
  Fast turns outrun the 5s poll: measure message-count growth against a
  PRE-SEND baseline or completions read as "never started".
- Baseline/message-fetch failures must abort loudly, never default to a
  passing comparison (`0 > -1` false-success).
- Send retries consult server delivery (user msg persisted) and stop —
  blind retries pile duplicate prompts under tunnel stall (observed live).
- Promise text into page JS is whitelisted (no quotes/backticks/`$`).
- Failure paths dump pane/iframe diagnostics (binding, frames,
  readyState, resource count, model-call, composer, URL).
- Environment, not product: the agent-browser side is profile-singleton —
  concurrent runs/probes on different profiles corrupt each other (lost
  cookies, phantom login walls); serialize everything browser-driving.

## Login wall reappeared (2026-10-09 E2E)

Prod redirected to `/login` mid-session: the agent-browser profile lost its
`opencode_sid` cookie (fresh daemon state). Gateway + tunnel stayed healthy
(`health`: ok, `tunnelConnected: true`). Prod-browser checks need the §flow
above whenever the profile is fresh — treat as environment, not product bug.
Local proxy matrix (§6) all green without login: `/harness/:id/api/info` 200,
root `/api/event` SSE proxied with cookie, direct backends 401, opencode via
proxy 200.

## Public gateway smoke check (no login, 2026-10-23)

Lightweight regression for `https://ai-manager.nexvision.cc` — needs no
passkey, safe to run anytime (add to any e2e/regression pass touching prod):

1. `curl -s -m 10 -o /dev/null -w "%{http_code}" https://ai-manager.nexvision.cc/` → 200
2. `curl -s -m 10 https://ai-manager.nexvision.cc/health` → JSON with
   `"status":"ok"`, `"tunnelConnected":true`, `tunnels >= 1` (active tunnel
   `ready:true`). `scripts/ai-tunnel-health.sh` does the raw fetch; assert
   the two fields rather than eyeballing.
3. Cert: `openssl s_client -connect ai-manager.nexvision.cc:443
   -servername ai-manager.nexvision.cc | openssl x509 -noout -dates`
   (LE, renewed ~quarterly).
4. If unhealthy: `journalctl --user -u ai-manager-tunnel.service` (flapping
   `handshake timed out / DOWN (1006)` = gateway unreachable, client is fine)
   + `kubectl -n nexvision get pods -l app=ai-manager-gateway`.

## Transient TLS stall (2026-10-23, self-recovered)

~07:19–07:22 EDT: TCP:443 connected but no ServerHello (curl `000` after
10s on both :80 and :443); tunnel client logged repeated `Opening
handshake has timed out / DOWN (1006)`; `kubectl` to the VPS `:6443` also
TLS-timed-out. Recovered on its own — `tunnel UP` 07:22:30, gateway
`/health` green (`tunnelConnected:true`), pod `Running` (13d, 1 restart).
Sibling `opencode.nexvision.cc` (same VPS IP) answered 200 mid-incident, so
not a full host outage — treat as transient ingress/network-path blip.
Regression rule: a lone failed probe means nothing; only two consecutive
failures ≥60s apart (plus tunnel journal showing flaps) count as prod-down.
