#!/usr/bin/env bash
# opencode-auto-update.sh — weekly opencode self-update with AI-agent fallback.
# Runs from cron (Sun 03:00): checks latest version, upgrades, restarts services,
# verifies health + tests. ANY failure hands off to a free-model agent
# (opencode-go/muse-spark-1.3-contributor) with logs attached; the script itself
# never loops — one agent handoff per run, then exit.
#
# Cron line:
#   0 3 * * 0 /usr/bin/flock -n /tmp/opencode-auto-update.lock /home/herbert/ai-manager/scripts/opencode-auto-update.sh >> /home/herbert/.ai-manager/opencode-auto-update.log 2>&1
#
# Manual dry check (no changes): DRY_RUN=1 bash scripts/opencode-auto-update.sh

set -u
REPO="/home/herbert/ai-manager"
export PATH="$HOME/.local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
MODEL="opencode-go/muse-spark-1.3-contributor"
E2E_PORT="4002"
E2E_HARNESS="4450"

log() { echo "$(date '+%F %T') $*"; }

# One-shot handoff: describe the failure, attach recent log, let the agent fix.
call_agent() {
  local step="$1" detail="$2"
  log "HANDOFF to agent (step=$step): $detail"
  local prompt
  prompt="$(mktemp /tmp/opencode-update-agent.XXXXXX)"
  cat > "$prompt" <<EOF
You are the on-call fixer for the opencode auto-update cron on this box (host runs ai-manager + opencode).
The cron run FAILED at step: $step
Detail: $detail
Current opencode version: $(opencode --version 2>/dev/null || echo unknown)

Diagnose and fix. Known facts:
- `opencode upgrade` (curl method, npm registry @opencode/cli-<target>) is SLOW here (~40KB/s single-stream) and its internal downloader times out on ~109MB binaries. Reliable fallback: parallel ranged download (python3, 8-12 threads, Range headers, require HTTP 206 + exact lengths) of https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-<ver>.tgz, verify sha1/sha512 against https://registry.npmjs.org/@opencode%2fcli-linux-x64/<ver> metadata, extract, replace ~/.opencode/bin/opencode.
- Restart procedure (see $REPO/AGENTS.md "Deploy"): snapshot \`ps -eo pid,args | grep '[o]pencode serve'\`, then \`systemctl --user restart ai-manager.service\` (unit uses KillMode=process; web backends must be adopted with IDENTICAL pids, never respawned). Then \`opencode service restart\`. Verify: manager health, /api/state sessions running, backend PIDs unchanged.
- Verify with: unit tests \`cd $REPO && timeout 100 env -u NODE_TEST_CONTEXT node --test tests/*.test.js\` (must grow test count, never rename headers), and e2e \`MGR_PORT=$E2E_PORT HARNESS_BASE=$E2E_HARNESS npm run test:e2e\` — serialized: proceed only if \`pgrep -f 'e2e-web-defaults[.]sh'\` is empty, ports $E2E_PORT/$E2E_HARNESS/$((E2E_HARNESS-10)) free, never disturb live :4000.
- Live manager API: http://127.0.0.1:4000, repo $REPO, durable notes in $REPO/memory + $REPO/AGENTS.md.

Constraints: one fix pass, no destructive action on live sessions, do NOT edit the crontab itself, do NOT send prompts that run billed turns beyond diagnosis (e2e never sends prompts by design). Log everything you do to stdout (captured in the cron log). If unfixable, state the cause + exact manual steps.
EOF
  timeout 2400 opencode run --model "$MODEL" --auto --title "opencode-auto-update-fix" "$(cat "$prompt")" 2>&1 | tail -30
  rm -f "$prompt"
}

fail() { call_agent "$1" "$2"; log "DONE with failures"; exit 1; }

log "== opencode auto-update start (dry=${DRY_RUN:-0})"
CURRENT="$(opencode --version 2>/dev/null | awk '{print $2}' || echo unknown)"
CURRENT="${CURRENT#v}" # opencode prints 'v2.x.y', API returns '2.x.y'
[ -z "$CURRENT" ] && CURRENT="unknown"
LATEST="$(curl -s -m 30 https://opencode.ai/update/api/latest/cli/npm 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || echo unknown)"
LATEST="${LATEST#v}"
log "current=$CURRENT latest=$LATEST"
[ "$LATEST" = "unknown" ] && fail "version-check" "could not fetch latest version metadata"
[ "$CURRENT" = "$LATEST" ] && { log "already up to date ($CURRENT)"; exit 0; }
[ "${DRY_RUN:-0}" = "1" ] && { log "dry run: would upgrade $CURRENT -> $LATEST"; exit 0; }

log "-- unit tests (pre-upgrade baseline)"
cd "$REPO" || fail "pre-tests" "cannot cd $REPO"
UTEST="$(timeout 100 env -u NODE_TEST_CONTEXT node --test tests/*.test.js 2>&1 | tail -8)"
echo "$UTEST" | grep -qE "^# (fail|cancelled) +0" || fail "pre-tests" "unit tests not green: $(echo "$UTEST" | tr '\n' ';')"
log "unit tests green"

log "-- upgrading $CURRENT -> $LATEST"
timeout 1500 opencode upgrade 2>&1 | tail -3
AFTER="$(opencode --version 2>/dev/null | awk '{print $2}' || echo unknown)"
AFTER="${AFTER#v}" # same v-prefix normalization as CURRENT
[ "$AFTER" = "$LATEST" ] || fail "upgrade" "version still $AFTER after upgrade (want $LATEST)"
log "upgraded to $AFTER"

log "-- restarting services"
PRE_PIDS="$(ps -eo pid,args | grep '[o]pencode serve' | awk '{print $1}' | sort -n | tr '\n' ' ')"
opencode service restart 2>&1 | tail -2
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart ai-manager.service 2>&1 | tail -2
sleep 8
curl -s -m 10 http://127.0.0.1:4000/health >/dev/null || fail "restart" "manager health check failed after restart"
STATE_BAD="$(curl -s -m 10 http://127.0.0.1:4000/api/state | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
bad=[s['id'] for s in ss if s.get('status')!='running']
print(' '.join(bad))" 2>/dev/null || echo STATE-ERR)"
[ -z "$STATE_BAD" ] || fail "restart" "non-running sessions after restart: $STATE_BAD"
POST_PIDS="$(ps -eo pid,args | grep '[o]pencode serve' | awk '{print $1}' | sort -n | tr '\n' ' ')"
log "backends pre=[$PRE_PIDS] post=[$POST_PIDS]"
# The opencode background service legitimately respawns (new binary); per-session
# web backends must be adopted with identical PIDs.
log "restart verified"

log "-- e2e regression (serialized)"
if pgrep -f 'e2e-web-defaults[.]sh' >/dev/null; then
  log "another e2e run active; skipping (not a failure)"
else
  E2E_OUT="$(MGR_PORT="$E2E_PORT" HARNESS_BASE="$E2E_HARNESS" timeout 1800 npm run test:e2e 2>&1 | tail -15)"
  echo "$E2E_OUT" | grep -q "^FAIL" && fail "e2e" "regression failures: $(echo "$E2E_OUT" | grep '^FAIL' | tr '\n' ';')"
  log "e2e green"
fi

log "== auto-update complete: $CURRENT -> $AFTER"
