#!/usr/bin/env bash
# prod-session-timing.sh — timed prod Wechsel test for ai-manager.nexvision.cc:
# timer starts, loads the prod site, opens a new opencode session (any
# workspace), keeps (re)trying to send the prompt until it goes through,
# waits for the reply, deletes the session, prints stage timers.
#
# Usage: bash scripts/prod-session-timing.sh
#   Env: PROD_URL (default https://ai-manager.nexvision.cc)
#        PROD_COOKIE_FILE (default /tmp/opencode/prod-cookie.txt)
#        PROD_CRED_FILE   (default /tmp/opencode/prod-cred.json, for refresh)
#        PROMPT_TEXT      (default "hi")
# Requires: node, curl, python3, agent-browser on PATH; a registered +
#   kubectl-approved device for the cookie refresh path (see
#   scripts/prod-webauthn.mjs and memory/prod-web-testing.md).
# Sends ONE billed micro-prompt on a throwaway session (deleted afterwards).

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
PROD_URL="${PROD_URL:-https://ai-manager.nexvision.cc}"
COOKIE_FILE="${PROD_COOKIE_FILE:-/tmp/opencode/prod-cookie.txt}"
CRED_FILE="${PROD_CRED_FILE:-/tmp/opencode/prod-cred.json}"
PROMPT_TEXT="${PROMPT_TEXT:-hi}"
# The prompt is interpolated into page JS: restrict to safe chars (no
# quotes/backticks/$/backslash) or the send eval breaks.
if ! [[ "$PROMPT_TEXT" =~ ^[A-Za-z0-9\ .,!?-]+$ ]]; then
  echo "RESULT ok=false error=\"PROMPT_TEXT has unsafe chars (allowed: A-Za-z0-9 .,!?-)\""; exit 2
fi
SEND_RETRIES="${SEND_RETRIES:-5}"
# Optional persistent browser profile (warm disk cache across runs).
# Default is an isolated temp profile (hermetic, but every run pays the
# cold first load: bundle + API over the tunnel).
PROD_PROFILE="${PROD_PROFILE:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "RESULT ok=false error=\"missing $1\""; exit 2; }; }
need node; need curl; need python3; need agent-browser

T_START="$(date +%s%3N)"
ms_since() { echo $(( $(date +%s%3N) - T_START )); }
stage() { echo "RESULT stage=$1 ms=$(ms_since)"; }

TMP="$(mktemp -d /tmp/aimgr-prod-timing.XXXXXX)"
if [ -n "$PROD_PROFILE" ]; then
  mkdir -p "$PROD_PROFILE"
  export AGENT_BROWSER_PROFILE="$PROD_PROFILE"
else
  mkdir -p "$TMP/browser-profile"
  export AGENT_BROWSER_PROFILE="$TMP/browser-profile"
fi
SESS_FILE="$TMP/sess.txt"
cleanup() {
  if [ -f "$SESS_FILE" ] && [ -f "$COOKIE_FILE" ]; then
    curl -s -m 20 -X DELETE "$PROD_URL/api/sessions/$(cat "$SESS_FILE")" \
      -H "Cookie: opencode_sid=$(cat "$COOKIE_FILE")" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

api_state() {
  curl -s -m 20 "$PROD_URL/api/state" -H "Cookie: opencode_sid=$(cat "$COOKIE_FILE" 2>/dev/null)" 2>/dev/null
}

# ---- login (refresh once via software WebAuthn when the cookie is stale) ----
if ! api_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "sessions" in d' 2>/dev/null; then
  echo "cookie stale, refreshing via software WebAuthn…" >&2
  if [ ! -f "$CRED_FILE" ]; then
    echo "RESULT ok=false error=\"no cookie and no $CRED_FILE (register + kubectl approve first, see scripts/prod-webauthn.mjs)\""; exit 2
  fi
  PROD_COOKIE_FILE="$COOKIE_FILE" PROD_CRED_FILE="$CRED_FILE" \
    node "$SCRIPT_DIR/prod-webauthn.mjs" login >&2 || { echo "RESULT ok=false error=\"webauthn refresh failed\""; exit 2; }
  api_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "sessions" in d' 2>/dev/null \
    || { echo "RESULT ok=false error=\"still locked after refresh\""; exit 2; }
fi
stage "login_ok"

# ---- load prod site in an isolated browser profile ----
agent-browser cookies set opencode_sid "$(cat "$COOKIE_FILE")" \
  --url "$PROD_URL/" --httpOnly --secure --sameSite Strict >/dev/null 2>&1 || true
agent-browser open "$PROD_URL/" >/dev/null 2>&1
sleep 8
NROWS=0
for _ in $(seq 1 24); do
  PAGESTATE="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({ login: !!document.querySelector('#login'), rows: document.querySelectorAll('[data-sess]').length }))()
EOF
)"
  # eval output is JSON-encoded (often double: a JSON string holding JSON):
  # decode fully before matching — raw grep misses through backslashes and
  # .get on a still-encoded str throws (the page was fine all along).
  DECODED="$(echo "$PAGESTATE" | python3 -c 'import json,sys; d=json.load(sys.stdin); d=json.loads(d) if isinstance(d,str) else d; print(json.dumps(d))' 2>/dev/null || echo '{}')"
  NROWS="$(echo "$DECODED" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("rows",0))' 2>/dev/null || echo 0)"
  ISLOGIN="$(echo "$DECODED" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("login",True))' 2>/dev/null || echo True)"
  [ "${NROWS:-0}" -gt 0 ] 2>/dev/null && break
  if [ "$ISLOGIN" = "True" ]; then
    # Daemon dropped the cookie mid-run: re-set and reload (see
    # memory/prod-web-testing.md §44 — treat as environment, not product).
    agent-browser cookies set opencode_sid "$(cat "$COOKIE_FILE")" \
      --url "$PROD_URL/" --httpOnly --secure --sameSite Strict >/dev/null 2>&1 || true
    agent-browser open "$PROD_URL/" >/dev/null 2>&1
    sleep 8
  fi
  sleep 5
done
[ "${NROWS:-0}" -gt 0 ] 2>/dev/null || { echo "RESULT ok=false error=\"prod page never listed sessions\""; exit 2; }
stage "page_loaded"

# ---- open a new session (first workspace = any workspace) ----
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => {
  var b = document.querySelector('#harnessSwitch .hs-btn[data-harness="opencode"]');
  if (b && !b.classList.contains('sel')) b.click();
  window.__ids = [...new Set([...document.querySelectorAll('[data-sess]')].map(r => r.dataset.sess))];
  window.__t0 = performance.now();
  document.getElementById('btnNewSessionTop').click();
  return "clicked";
})()
EOF
UNIQ="probe-$(date +%s)"
for _ in $(seq 1 24); do
  sleep 5
  CAND="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var cur = [...new Set([...document.querySelectorAll('[data-sess]')].map(r => r.dataset.sess))]; return cur.filter(x => !window.__ids.includes(x)).join(','); })()
EOF
)"
  # eval output is JSON-encoded: strip quotes/backslashes for the id match.
  # Rows can render twice for one session: take the first id and validate
  # its shape (a "id,id" blob breaks selectors and API paths downstream).
  CAND_CLEAN="$(echo "$CAND" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null | tr ',' '\n' | head -1 || true)"
  [[ "$CAND_CLEAN" =~ ^sess_[0-9a-f]+$ ]] || CAND_CLEAN=""
  if [ -n "$CAND_CLEAN" ]; then echo "$CAND_CLEAN" > "$SESS_FILE"; break; fi
done
[ -s "$SESS_FILE" ] || { echo "RESULT ok=false error=\"no new session row within 120s\""; exit 2; }
stage "session_created"
SESS="$(cat "$SESS_FILE")"

# ---- open it, wait until the prompt can be sent (composer + models) ----
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => { var row = document.querySelector('[data-sess="$SESS"]'); if (row) row.click(); return "opened"; })()
EOF
for _ in $(seq 1 36); do
  sleep 5
  READY="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => {
  var p = document.querySelectorAll('#paneGrid .pane')[0];
  var vis = p && [...p.querySelectorAll('.pane-frame')].find(f => !f.classList.contains('hidden'));
  if (!vis) return "0";
  try {
    var w = vis.contentWindow, d = vis.contentDocument;
    var modelCall = w.performance.getEntriesByType('resource').some(r => r.name.indexOf('/api/model') !== -1);
    return (d.querySelector('textarea, [contenteditable="true"]') && modelCall) ? "1" : "0";
  } catch (e) { return "0"; }
})()
EOF
)"
  echo "$READY" | grep -q '"1"' && break
done
echo "$READY" | grep -q '"1"' || {
  # Diagnostics first: a bare timeout hides whether the pane never got the
  # session, the iframe never booted, or just the models call hung.
  DIAG="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => {
  var panes = [...document.querySelectorAll('#paneGrid .pane')];
  var p = panes[0];
  var frames = p ? [...p.querySelectorAll('.pane-frame')] : [];
  var vis = frames.find(f => !f.classList.contains('hidden'));
  var o = { panes: panes.length, sess: p && p.querySelector('.pane-select').value, frames: frames.length };
  try {
    var w = vis.contentWindow;
    o.readyState = vis.contentDocument.readyState;
    o.nRes = w.performance.getEntriesByType('resource').length;
    o.navs = w.performance.getEntriesByType('navigation').length;
    o.modelCall = w.performance.getEntriesByType('resource').some(r => r.name.indexOf('/api/model') !== -1);
    o.composer = !!vis.contentDocument.querySelector('textarea, [contenteditable="true"]');
    o.href = w.location.href.slice(-60);
  } catch (e) { o.err = String(e).slice(0, 60); }
  return JSON.stringify(o);
})()
EOF
)"
  echo "RESULT ok=false error=\"composer/models never ready within 180s\" diag=$DIAG"; exit 2; }
stage "interactive"

# ---- message + activity probes (proxied API: manager auth injection
# covers the backend — still black-box prod over the tunnel) ----
HID="$(api_state | python3 -c '
import json,sys
ss = json.load(sys.stdin)["sessions"]
print(next((s.get("harnessSessionId","") for s in ss if s["id"] == sys.argv[1]), ""))' "$SESS" 2>/dev/null || true)"
msg_counts() {
  curl -s -m 15 "$PROD_URL/s/$SESS/api/session/$HID/message?limit=10&order=desc" \
    -H "Cookie: opencode_sid=$(cat "$COOKIE_FILE")" 2>/dev/null | python3 -c '
import json,sys
try:
  ms = json.load(sys.stdin)["data"]
  u = sum(1 for m in ms if m.get("type") == "user")
  a = sum(1 for m in ms if m.get("type") == "assistant" and ((m.get("time") or {}).get("completed") or 0) > 0)
  print(f"{u} {a}")
except Exception:
  print("-1 -1")'
}
session_activity() {
  api_state | python3 -c '
import json,sys
ss = json.load(sys.stdin)["sessions"]
s = next((x for x in ss if x["id"] == sys.argv[1]), None)
print(s.get("activity", "?") if s else "gone")' "$SESS" 2>/dev/null || echo "?"
}

# ---- keep trying to send until it goes through ----
# Server-side baseline is captured BEFORE the first attempt: the send loop
# itself can deliver (its SU>U0 shortcut), so a baseline taken afterwards
# would already contain the message and phase 1 could never see growth.
TEXT="$PROMPT_TEXT $UNIQ"
read -r U0 N0 <<< "$(msg_counts)"
[[ "$U0" =~ ^[0-9]+$ && "$N0" =~ ^[0-9]+$ ]] || { echo "RESULT ok=false error=\"message baseline unreadable (backend/API down?)\""; exit 2; }
SENT=""
for _ in $(seq 1 "$SEND_RETRIES"); do
  agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => {
  var vis = [...document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame')].find(f => !f.classList.contains('hidden'));
  var d = vis.contentDocument;
  var ce = d.querySelector('[contenteditable="true"]');
  ce.focus();
  document.execCommand.call(d, 'insertText', false, '$TEXT');
  var btn = [...d.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Send');
  if (btn && !btn.disabled) btn.click();
  return "attempted";
})()
EOF
  for _ in $(seq 1 6); do
    sleep 5
    STATE="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => {
  var vis = [...document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame')].find(f => !f.classList.contains('hidden'));
  var d = vis.contentDocument;
  var t = d.body.innerText;
  var ce = d.querySelector('[contenteditable="true"]');
  var inTranscript = t.indexOf('$UNIQ') !== -1;
  var cleared = !ce || ce.innerText.indexOf('$UNIQ') === -1;
  return (inTranscript && cleared) ? "1" : "0";
})()
EOF
)"
    if echo "$STATE" | grep -q '"1"'; then SENT=1; break 2; fi
    # Server-side delivery proof: the POST reached the backend even if the
    # browser render lags — stop retrying (retries under stall pile up
    # duplicate prompts) and go wait for the reply instead. Baseline U0
    # predates the first attempt (captured above), so any growth is ours.
    read -r SU NU <<< "$(msg_counts)"
    if [[ "$SU" =~ ^[0-9]+$ ]] && [ "$SU" -gt "$U0" ] 2>/dev/null; then SENT=1; break 2; fi
  done
done
[ -n "$SENT" ] || { echo "RESULT ok=false error=\"prompt never went through after $SEND_RETRIES attempts\""; exit 2; }
stage "prompt_sent"

# ---- wait for the reply: delivery proof, then turn-start/done ----
# (msg_counts/session_activity defined above, reused here; U0/N0 baseline
# predates the first send attempt, so growth here is the reply/delivery.)
# Phase 1 (60s): delivery (user msg persisted) → turn picked up (working)
# → or already completed (assistant msg) when the turn outruns the 5s poll.
DELIVERED=""; ACT="?"
for _ in $(seq 1 12); do
  sleep 5
  read -r U N <<< "$(msg_counts)"
  ACT="$(session_activity)"
  [ "$N" -gt "$N0" ] 2>/dev/null && { stage "reply_received"; echo "RESULT ok=true total_ms=$(ms_since) note=\"fast-turn\""; exit 0; }
  [ "$U" -gt "$U0" ] 2>/dev/null && DELIVERED=1
  [ "$ACT" = "working" ] && break
done
[ -n "$DELIVERED" ] || { echo "RESULT ok=false error=\"prompt never delivered (activity=$ACT)\""; exit 2; }
[ "$ACT" = "working" ] || { echo "RESULT ok=false error=\"delivered but turn never ran (activity=$ACT)\""; exit 2; }
stage "turn_working"
# Phase 2 (180s): turn completes.
for _ in $(seq 1 36); do
  sleep 5
  ACT="$(session_activity)"
  [ "$ACT" = "waiting" ] && break
done
[ "$ACT" = "waiting" ] || { echo "RESULT ok=false error=\"no reply within 180s (activity=$ACT)\""; exit 2; }
stage "reply_received"

echo "RESULT ok=true total_ms=$(ms_since)"
