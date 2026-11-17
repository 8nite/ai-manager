#!/usr/bin/env bash
# rollout-gateway.sh — safe ai-manager-gateway rollout with verification.
#
# Best practices encoded here (see memory/manager-proxy-remote.md §15):
#   - ConfigMap code changes need pod restart (no reloader) — this script
#     rebuilds, restarts, and verifies in one audited flow.
#   - Never roll out while an e2e run is in flight (it reads the script
#     family mid-run) or while a prod browser test drives the gateway;
#     deploy when the remote user is idle (restart windows 502 briefly).
#   - Verify post-deploy via /health (tunnelConnected, inFlight sane) and
#     roll back (`rollout undo`) when verification fails.
#
# Usage:
#   bash scripts/rollout-gateway.sh           # full rollout + verify
#   bash scripts/rollout-gateway.sh check      # verify only (no changes)
#   Env: NS (default nexvision), HEALTH_URL
#        (default https://ai-manager.nexvision.cc/health),
#        INFLIGHT_MAX (default 50), WAIT_SECS (default 120).
set -uo pipefail
NS="${NS:-nexvision}"
DEPLOY="ai-manager-gateway"
HEALTH_URL="${HEALTH_URL:-https://ai-manager.nexvision.cc/health}"
INFLIGHT_MAX="${INFLIGHT_MAX:-50}"
WAIT_SECS="${WAIT_SECS:-120}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "FAIL: missing $1"; exit 2; }; }
need kubectl; need curl; need python3

health() { curl -s -m 15 "$HEALTH_URL" 2>/dev/null; }

# Prints: ok|NG + details. Never fails the caller (exit 0); decision is the text.
verify() {
  local h ok why
  h="$(health)" || { echo "NG health unreachable"; return 0; }
  ok="$(echo "$h" | python3 -c '
import json,sys
try:
  d = json.load(sys.stdin)
  tun = d.get("tunnelConnected") is True and (d.get("tunnels") or 0) >= 1
  infl = d.get("inFlight")
  print("tun=%s inflight=%s" % (tun, infl))
except Exception as e:
  print("parse-error %s" % e)
' 2>/dev/null || echo parse-error)"
  echo "$ok" | grep -q "^tun=True" || { echo "NG $ok"; return 0; }
  local n
  n="$(echo "$ok" | grep -oE 'inflight=[0-9]+' | cut -d= -f2)"
  if [ -n "$n" ] && [ "$n" -gt "$INFLIGHT_MAX" ] 2>/dev/null; then
    echo "NG $ok (over max $INFLIGHT_MAX — stuck SSE upstreams?)"
    return 0
  fi
  echo "ok $ok"
}

if [ "${1:-}" = "check" ]; then
  R="$(verify)"
  echo "verify: $R"
  case "$R" in ok*) exit 0;; *) exit 1;; esac
fi

# --- guard: refuse while an e2e run holds the browser/drives deploys ---
if pgrep -f 'e2e-web-defaults[.]sh' >/dev/null 2>&1; then
  echo "FAIL: e2e-web-defaults.sh is running — roll out after it finishes (mid-run deploys corrupt parsing and flake timing asserts)"
  exit 1
fi

# --- preflight snapshot (compare after) ---
PRE="$(verify)"; echo "pre: $PRE"
kubectl -n "$NS" rollout history "deploy/$DEPLOY" 2>/dev/null | tail -2 || true

# --- rebuild + apply code, restart, wait for rollout ---
bash "$SCRIPT_DIR/build-gateway-configmap.sh" apply || exit 1
kubectl -n "$NS" rollout restart "deploy/$DEPLOY" || exit 1
kubectl -n "$NS" rollout status "deploy/$DEPLOY" --timeout="${WAIT_SECS}s" || {
  echo "FAIL: rollout did not finish — rolling back"
  kubectl -n "$NS" rollout undo "deploy/$DEPLOY" || true
  exit 1
}

# --- settle: new pod boots, tunnel client reconnects (backoff), browsers re-fan ---
echo "waiting for tunnel reconnect + settle (up to ${WAIT_SECS}s)…"
OK=""
for _ in $(seq 1 "$((WAIT_SECS / 5))"); do
  sleep 5
  R="$(verify)"
  case "$R" in ok*) OK="$R"; break;; *) echo "  … $R";; esac
done
if [ -z "$OK" ]; then
  echo "FAIL: gateway unhealthy after rollout ($R) — rolling back"
  kubectl -n "$NS" rollout undo "deploy/$DEPLOY" || true
  kubectl -n "$NS" rollout status "deploy/$DEPLOY" --timeout=120s || true
  POST="$(verify)"; echo "post-rollback: $POST"
  exit 1
fi
echo "verify: $OK (was: $PRE)"
echo "DONE: gateway rolled out and healthy"
