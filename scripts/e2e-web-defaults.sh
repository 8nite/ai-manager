#!/usr/bin/env bash
# e2e-web-defaults.sh — end-to-end test for manager-embedded opencode UI
# defaults (queue follow-ups, dark mode, hidden titlebar).
#
# Spins an ISOLATED scratch manager (own port/store/harness ports — never the
# live :4000), creates a real opencode session, then asserts through a real
# headless browser (agent-browser):
#   1. served session HTML carries the route shim + defaults seed + no-titlebar
#      style, with matching CSP hashes;
#   2. fresh browser state gets queue + dark seeded and the app boots dark;
#   3. explicit user choices (steer/light) survive reload untouched;
#   4. titlebar hidden, app functional.
#
# Deliberately does NOT send a prompt: that would run a billed agent turn.
# The proxy delivery rewrite is covered by stub-level tests
# (tests/proxy.test.js "withQueueDefault"/"unspecified prompt delivery").
#
# Usage: bash scripts/e2e-web-defaults.sh
#   Env overrides: MGR_PORT (default 4001), HARNESS_BASE (default 4300).
# Requires: node, curl, python3, agent-browser on PATH.

set -eu
# NOTE: no pipefail. Under load the headless browser CLI intermittently fails
# (tab death on heavy SPA iframe loads, CDP hiccups); with pipefail a single
# flaky `agent-browser ... | tail -1` aborts the whole run before its summary.
# Without it the failure degrades to an empty/EVAL-ERR probe, the assert
# fails, and the run continues to completion so every section still reports.

export PATH="$HOME/.local/bin:$PATH"
MGR_PORT="${MGR_PORT:-4001}"
HARNESS_BASE="${HARNESS_BASE:-4300}"
MGR="http://127.0.0.1:${MGR_PORT}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "FAIL: missing required command: $1"; exit 2; }; }
need node; need curl; need python3; need agent-browser

port_free() { ! (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_free "$MGR_PORT" || { echo "FAIL: port $MGR_PORT in use (set MGR_PORT=)"; exit 2; }
port_free "$HARNESS_BASE" || { echo "FAIL: port $HARNESS_BASE in use (set HARNESS_BASE=)"; exit 2; }
# Shared opencode backend defaults to HARNESS_BASE-10 (see sessions.js
# sharedPort); it must be free too, else the scratch backend can't bind.
SHARED_PORT="$((HARNESS_BASE - 10))"
port_free "$SHARED_PORT" || { echo "FAIL: port $SHARED_PORT in use (shared opencode backend; set HARNESS_BASE=)"; exit 2; }

TMP="$(mktemp -d /tmp/aimgr-e2e.XXXXXX)"
WS="$TMP/ws"; mkdir -p "$WS" "$TMP/data"
# Isolated Chrome profile: the shared default profile may be driven
# concurrently (parallel dev browser use steals tabs/focus/localStorage and
# flakes unrelated sections). A per-run profile keeps e2e hermetic and is
# removed with $TMP by the EXIT trap.
export AGENT_BROWSER_PROFILE="$TMP/browser-profile"
MGR_PID=""; SESS=""; FAILS=0

T0_E2E=$(date +%s)
tstamp() { echo "$(( $(date +%s) - T0_E2E ))s"; }
pass() { echo "PASS [$(tstamp)]: $1"; }
fail() { echo "FAIL [$(tstamp)]: $1"; FAILS=$((FAILS + 1)); }
trap 'echo "ABORT cmd failed (line $LINENO): $BASH_COMMAND (fail count: $FAILS)"' ERR

# openMgr <ready-js> <ready-msg>: open the manager shell and poll until
# <ready-js> is truthy, then pass <ready-msg>. Two headless hazards are
# handled here: (a) a dead tab (about:blank, no state) is detected via href
# and the page is re-opened; (b) restored panes auto-boot web iframes whose
# SPA load intermittently kills the tab. Prints the final snapshot on failure.
openMgr() { # $1 = js boolean expr (may reference $SESS etc.), $2 = pass message
  local expr="$1" msg="$2" mode="${3:-clear}" i raw snap quiet ready
  if [ "$mode" != "keep" ]; then
    agent-browser eval "try{localStorage.removeItem('ai-manager.panes');localStorage.removeItem('ai-manager.layout')}catch(e){}" >/dev/null 2>&1 || true
  fi
  agent-browser open "$MGR/" >/dev/null 2>&1 || true
  for i in 1 2; do
    ready=""
    for _ in $(seq 1 30); do
      raw="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { try { return JSON.stringify({ ok: !!($expr), href: location.href, sess: (typeof state !== 'undefined') ? state.sessions.length : 'nostate' }); } catch (e) { return JSON.stringify({ err: String(e).slice(0,120) }); } })()
EOF
)"
      snap="$(echo "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo EVAL-ERR)"
      case "$snap" in *'"ok":true'*) ready=1; break;; esac
      sleep 2
    done
    if [ -z "$ready" ]; then
      if [ "$mode" != "keep" ]; then
        agent-browser eval "try{localStorage.removeItem('ai-manager.panes');localStorage.removeItem('ai-manager.layout')}catch(e){}" >/dev/null 2>&1 || true
      fi
      agent-browser open "$MGR/" >/dev/null 2>&1 || true
      continue
    fi
    # Quiescence: let restored web views finish booting (or kill the tab)
    # before the section acts, so mid-section deaths get retried here instead
    # of cascading. Bounded; a wedged load just proceeds.
    for _ in $(seq 1 8); do
      quiet="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { try {
  var fr = [...document.querySelectorAll('.pane-frame')].filter((f) => f.isConnected && !f.classList.contains('hidden'));
  var settled = fr.every((f) => { try { var d = f.contentDocument; return d && d.readyState === 'complete'; } catch (e) { return true; } });
  var idle = (typeof state === 'undefined') || state.switchingIds.size === 0;
  var loaderGone = !document.getElementById('stageLoader') || document.getElementById('stageLoader').classList.contains('hidden');
  return JSON.stringify({ q: settled && idle && loaderGone, href: location.href });
} catch (e) { return JSON.stringify({ err: String(e).slice(0,80) }); } })()
EOF
)"
      echo "$quiet" | grep -q '"q":true' && break
      echo "$quiet" | grep -q 'about:blank' && break
      sleep 2
    done
    # Gate 3 (liveness): re-verify readiness after quiescence — the tab may
    # have died while we waited. Pass only on a live, ready page.
    raw="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { try { return JSON.stringify({ ok: !!($expr), href: location.href }); } catch (e) { return JSON.stringify({ err: String(e).slice(0,80) }); } })()
EOF
)"
    snap="$(echo "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo EVAL-ERR)"
    case "$snap" in *'"ok":true'*) pass "$msg"; return 0;; esac
    agent-browser open "$MGR/" >/dev/null 2>&1 || true
  done
  fail "page never ready ($msg): $snap errs: $(agent-browser errors 2>/dev/null | head -5 || true)"
  return 1
}

cleanup() {
  if [ -n "${SESS_FB:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_FB" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_PA:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_PA" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_PB:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_PB" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_AGY:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_AGY" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_FC:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_FC" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_SPLIT:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_SPLIT" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_FN:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_FN" >/dev/null 2>&1 || true
  fi
  if [ -n "$SESS" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS" >/dev/null 2>&1 || true
  fi
  if [ -n "$MGR_PID" ]; then kill "$MGR_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== boot scratch manager (port $MGR_PORT, harness base $HARNESS_BASE)"
AI_MGR_PORT="$MGR_PORT" AI_MGR_DATA="$TMP/data/manager.json" \
  AI_MGR_HARNESS_BASE_PORT="$HARNESS_BASE" \
  nohup node src/server/index.js > "$TMP/manager.log" 2>&1 &
MGR_PID=$!
for _ in $(seq 1 12); do
  curl -s -m 3 "$MGR/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -s -m 5 "$MGR/health" >/dev/null || { fail "scratch manager never came up (see $TMP/manager.log)"; exit 1; }
pass "scratch manager up"

WSID="$(curl -s -m 10 -X POST "$MGR/api/workspaces" -H 'Content-Type: application/json' \
  -d "{\"path\":\"$WS\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
echo "== create opencode session (backend boot can take ~60s)"
CREATED="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-web-defaults\"}")"
SESS="$(echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
STATUS="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next(s['status'] for s in ss if s['id']=='$SESS'))")"
[ "$STATUS" = "running" ] || { fail "session status=$STATUS (want running)"; tail -5 "$TMP/manager.log"; exit 1; }
pass "session running ($SESS)"

URL="$MGR/s/$SESS/"
echo "== served HTML + CSP"
HTML="$(curl -s -m 20 "$URL")"
CSP="$(curl -s -m 20 -D - -o /dev/null "$URL" | tr -d '\r' | grep -i '^content-security-policy:' || true)"
for marker in aimgr-route-shim aimgr-web-defaults aimgr-no-titlebar; do
  echo "$HTML" | grep -q "$marker" && pass "served HTML has $marker" || fail "served HTML missing $marker"
done
HASHES="$(echo "$CSP" | grep -o 'sha256-' | wc -l)"
[ "$HASHES" -ge 2 ] && pass "CSP carries inline-script hashes ($HASHES)" || fail "CSP missing hashes: $CSP"
# Hashed bundle assets must cache immutably (src/server/proxy.js
# isImmutableAsset): over the tunnel each request costs ~250-800ms, so a
# cold switch must cost doc + API only after the first load.
ASSET="$(echo "$HTML" | grep -oE '/_assets/[A-Za-z0-9_.-]+\.js' | head -1)"
if [ -n "$ASSET" ]; then
  ASSET_CC="$(curl -s -m 20 -D - -o /dev/null "$MGR/s/$SESS$ASSET" | tr -d '\r' | grep -i '^cache-control:' || true)"
  echo "$ASSET_CC" | grep -q "immutable" \
    && pass "bundle asset immutable ($ASSET)" || fail "asset missing immutable cache: $ASSET_CC"
  API_CC="$(curl -s -m 20 -D - -o /dev/null "$MGR/s/$SESS/api/info" | tr -d '\r' | grep -i '^cache-control:' || true)"
  echo "$API_CC" | grep -q "immutable" \
    && fail "API must never be immutable: $API_CC" || pass "API responses not immutable"
  # Manager shell pins its own assets (?v=VERSION, immutable) while the
  # shell document stays uncached (it is the version anchor).
  MGR_HTML="$(curl -s -m 20 "$MGR/")"
  echo "$MGR_HTML" | grep -qE 'app\.js\?v=[^"]+' \
    && pass "shell references versioned app.js" || fail "shell missing versioned app.js"
  echo "$MGR_HTML" | grep -q "__AI_MGR_VERSION__" \
    && fail "version placeholder leaked unstamped" || pass "version stamped, no placeholder leak"
  APP_VER_URL="$(echo "$MGR_HTML" | grep -oE 'app\.js\?v=[^"&'"'"' ]+' | head -1)"
  APP_CC="$(curl -s -m 20 -D - -o /dev/null "$MGR/$APP_VER_URL" | tr -d '\r' | grep -i '^cache-control:' || true)"
  echo "$APP_CC" | grep -q "immutable" \
    && pass "versioned manager asset immutable ($APP_VER_URL)" || fail "versioned asset not immutable ($APP_VER_URL): $APP_CC"
  APP_CC_PLAIN="$(curl -s -m 20 -D - -o /dev/null "$MGR/app.js" | tr -d '\r' | grep -i '^cache-control:' || true)"
  echo "$APP_CC_PLAIN" | grep -q "immutable" \
    && fail "unversioned asset must not be immutable: $APP_CC_PLAIN" || pass "unversioned asset stays fresh"
else
  fail "no bundle asset found in served HTML"
fi
# Workspace config GETs cache briefly server-side (src/server/proxy.js
# config cache), pre-warmed at create (sessions.js prewarmSessionConfig):
# the repeat below must be a HIT with zero upstream I/O — ~7 sequential
# tunnel RTTs saved per repeat switch. Poll briefly: the warm runs in the
# background after the create POST responds.
CFG_HIT=""
for _ in $(seq 1 10); do
  CFG_HIT="$(curl -s -m 20 -D - -o /dev/null "$MGR/s/$SESS/api/config" | tr -d '\r' | grep -i '^x-aimgr-cache:' || true)"
  echo "$CFG_HIT" | grep -qi "HIT" && break
  sleep 1
done
echo "$CFG_HIT" | grep -qi "HIT" \
  && pass "config GET served as HIT (create pre-warmed)" || fail "config GET not HIT: $CFG_HIT"
# Browser-cacheable: repeats within TTL must cost zero requests (served
# from disk) — the server HIT only saves backend ms, but the tunnel RTT is
# the real cost. `private` keeps it out of shared caches.
CFG_CC="$(curl -s -m 20 -D - -o /dev/null "$MGR/s/$SESS/api/config" | tr -d '\r' | grep -i '^cache-control:' || true)"
echo "$CFG_CC" | grep -q "private, max-age=" \
  && pass "config GET browser-cacheable ($CFG_CC)" || fail "config not browser-cacheable: $CFG_CC"

echo "== browser: fresh state gets defaults"
agent-browser open "$URL" >/dev/null 2>&1 || true
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { localStorage.removeItem('opencode.global.dat:settings.v3'); localStorage.removeItem('opencode-color-scheme'); localStorage.removeItem('ai-manager.panes'); localStorage.removeItem('ai-manager.layout'); return "cleared"; })()
EOF
agent-browser open "$URL" >/dev/null 2>&1 || true
GOT_SETTINGS=""; GOT_SCHEME=""; GOT_MODE=""; GOT_BG=""; TABS=""; BOOT=""
for _ in $(seq 1 15); do
  sleep 2
  GOT_SETTINGS="$(agent-browser eval "localStorage.getItem('opencode.global.dat:settings.v3')" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || true)"
  [ -n "$GOT_SETTINGS" ] && [ "$GOT_SETTINGS" != "None" ] && break
done
GOT_SCHEME="$(agent-browser eval "localStorage.getItem('opencode-color-scheme')" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || true)"
[ "$GOT_SETTINGS" = '{"general":{"followUpBehavior":"queue"}}' ] \
  && pass "queue default seeded" || fail "queue seed got: $GOT_SETTINGS"
[ "$GOT_SCHEME" = "dark" ] \
  && pass "dark default seeded" || fail "dark seed got: $GOT_SCHEME"
MODE_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({m: document.documentElement.dataset.colorScheme, b: document.documentElement.style.backgroundColor, thead: (() => { const h = document.querySelector('header[data-slot="titlebar-v2"]'); return h ? getComputedStyle(h).display : 'absent'; })(), sesshead: (() => { const h = document.querySelector('div[data-session-title]'); return h ? getComputedStyle(h).display : 'absent'; })(), ttabs: (() => { const t = document.querySelector('[data-slot="titlebar-tabs"]'); return t ? (t.offsetParent === null ? 'hidden' : 'visible') : 'absent'; })(), bad: document.body.innerText.includes('Unrecognised route!')}))()
EOF
)"
# agent-browser eval returns a JSON-quoted string; unquote before matching.
MODE="$(echo "$MODE_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))')"
echo "$MODE" | grep -q '"m":"dark"' && pass "app booted dark" || fail "not dark: $MODE"
echo "$MODE" | grep -q '"thead":"none"' && pass "titlebar hidden" || fail "titlebar visible: $MODE"
echo "$MODE" | grep -q '"sesshead":"none"' && pass "session header hidden" || fail "session header visible: $MODE"
echo "$MODE" | grep -q '"ttabs":"hidden"' && pass "tabs strip hidden" || fail "tabs visible: $MODE"
echo "$MODE" | grep -q '"bad":false' && pass "no router crash" || fail "router crash: $MODE"

echo "== browser: XHR 2-arg open stays async (file-upload regression)"
# opencode uploads attachments via `xhr.open("POST", url)` (async default)
# + `xhr.responseType = "json"`. The api-scope wrapper once forwarded an
# explicit `undefined` async flag, flipping the call to sync in Chrome, so
# responseType threw and the composer showed "Upload failed".
XHR_ASYNC="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { try { const x = new XMLHttpRequest(); x.open('POST', '/api/experimental/fs/write?path=/tmp/e2e-probe'); x.responseType = 'json'; return 'async-ok'; } catch (e) { return 'THROW:' + e.message; } })()
EOF
)"
XHR_ASYNC_UNQ="$(echo "$XHR_ASYNC" | python3 -c 'import json,sys; print(json.load(sys.stdin))')"
echo "$XHR_ASYNC_UNQ" | grep -q "^async-ok" \
  && pass "XHR 2-arg open async (upload responseType ok)" || fail "XHR went sync: $XHR_ASYNC_UNQ"

echo "== browser: explicit choices preserved"
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { localStorage.setItem('opencode.global.dat:settings.v3', '{"general":{"followUpBehavior":"steer"}}'); localStorage.setItem('opencode-color-scheme', 'light'); return "set"; })()
EOF
agent-browser open "$URL" >/dev/null 2>&1 || true
sleep 4
KEPT_S="$(agent-browser eval "localStorage.getItem('opencode.global.dat:settings.v3')" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || true)"
KEPT_C="$(agent-browser eval "localStorage.getItem('opencode-color-scheme')" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || true)"
[ "$KEPT_S" = '{"general":{"followUpBehavior":"steer"}}' ] \
  && pass "explicit steer kept" || fail "steer overwritten: $KEPT_S"
[ "$KEPT_C" = "light" ] \
  && pass "explicit light kept" || fail "light overwritten: $KEPT_C"

echo "== api: session rename validates + persists"
BAD_RENAME="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X PATCH "$MGR/api/sessions/$SESS" -H 'Content-Type: application/json' -d '{"title":"   "}')"
[ "$BAD_RENAME" = "400" ] \
  && pass "empty rename rejected (400)" || fail "empty rename → HTTP $BAD_RENAME (want 400)"

echo "== browser: left-panel rename survives activation (dblclick race)"
# Fresh manager page: the session is inactive, so double-clicking its row
# fires two activates (async ensure/touch + terminal focus) plus
# startRename. The rename input must survive past the activation round-trip
# instead of being destroyed into a silent blur-cancel (regression: the
# rename box flashed and died, name unchanged). Poll for the row: cold boots
# under load can exceed fixed sleeps, and a blind click on a not-yet-rendered
# row silently dispatches to nothing.
RENAME_OPEN=""
for _ in 1 2; do
  # Double-activate can kill the headless tab mid-switch; retry once on a
  # fresh page so one death doesn't cascade the section.
  openMgr "document.querySelector('[data-sess="$SESS"] .lbl')" "sidebar row present for rename" || true
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var lbl = document.querySelector('[data-sess="$SESS"] .lbl'); if (!lbl) return "no-row"; var c = new MouseEvent("click", { bubbles: true, cancelable: true }); lbl.dispatchEvent(c); lbl.dispatchEvent(c); lbl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "dispatched"; })()
EOF
sleep 5
RENAME_RAW="$(agent-browser eval "JSON.stringify(document.querySelector('.sess-rename-input') ? true : false)" 2>/dev/null | tail -1)"
RENAME_OPEN="$(echo "$RENAME_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  [ "$RENAME_OPEN" = "true" ] && break
done
[ "$RENAME_OPEN" = "true" ] \
  && pass "rename input survives activation" || {
    RENAME_CTX_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({ href: location.href, rows: document.querySelectorAll('#wsList [data-sess]').length, sessN: (typeof state !== 'undefined') ? state.sessions.length : 'no-state', renaming: (typeof state !== 'undefined') ? String(state.renamingId) : 'no-state', switching: (typeof state !== 'undefined') ? state.switchingIds.size : -1 }) )()
EOF
)"
    RENAME_CTX="$(echo "$RENAME_CTX_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
    RENAME_PGERR="$(agent-browser errors 2>/dev/null | head -8 || true)"
    fail "rename input died mid-activation (raw: $RENAME_RAW ctx: $RENAME_CTX errs: $RENAME_PGERR)"
  }
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var inp = document.querySelector('.sess-rename-input'); if (!inp) return "no-input"; inp.value = "e2e-renamed"; inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return "committed"; })()
EOF
sleep 2
RENAMED_STATE="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = json.load(sys.stdin)['sessions']
print(next((s['title'] for s in ss if s['id'] == '$SESS'), 'MISSING'))")"
[ "$RENAMED_STATE" = "e2e-renamed" ] \
  && pass "rename persisted via PATCH" || fail "rename not persisted: $RENAMED_STATE"
RENAME_PAINT="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var row = document.querySelector('[data-sess="$SESS"]'); return row ? row.innerText : "no-row"; })()
EOF
)"
echo "$RENAME_PAINT" | grep -q "e2e-renamed" \
  && pass "sidebar paints new title" || fail "sidebar stale: $RENAME_PAINT"

echo "== api: manager rename writes through to the backend chat"
# The PATCH above ("e2e-renamed") must converge the backend copy too —
# otherwise the next backend→manager title sync would revert the user's
# rename to the stale backend copy.
HID_HPORT="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = json.load(sys.stdin)['sessions']
s = next((x for x in ss if x['id'] == '$SESS'), {})
print((s.get('harnessSessionId') or ''), (s.get('port') or ''))")"
HID="$(echo "$HID_HPORT" | awk '{print $1}')"
HPORT="$(echo "$HID_HPORT" | awk '{print $2}')"
PWF="${AI_MGR_OPENCODE_PASSWORD_FILE:-$HOME/.ai-manager/opencode-password}"
PW="$(cat "$PWF" 2>/dev/null | tr -d '\n' || true)"
if [ -z "$HID" ] || [ -z "$HPORT" ] || [ -z "$PW" ]; then
  fail "no bound backend chat (hid=$HID port=$HPORT pwlen=${#PW})"
else
  BACKEND_TITLE="$(curl -s -m 10 -u "opencode:$PW" "http://127.0.0.1:$HPORT/api/session/$HID" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("title",""))' 2>/dev/null || true)"
  [ "$BACKEND_TITLE" = "e2e-renamed" ] \
    && pass "rename wrote through to backend" || fail "backend title stuck at: $BACKEND_TITLE"

  echo "== api+browser: backend auto-title syncs back to the sidebar"
  # Simulate the opencode title agent with an out-of-band backend rename (no
  # billed prompt turn); the next /api/state poll must adopt it and repaint.
  curl -s -m 10 -o /dev/null -u "opencode:$PW" -X PATCH "http://127.0.0.1:$HPORT/api/session/$HID" -H 'Content-Type: application/json' -d '{"title":"e2e-auto-title"}'
  SYNCED=""
  for _ in $(seq 1 10); do
    sleep 2
    SYNCED="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = json.load(sys.stdin)['sessions']
print(next((s['title'] for s in ss if s['id'] == '$SESS'), 'MISSING'))")"
    [ "$SYNCED" = "e2e-auto-title" ] && break
  done
  [ "$SYNCED" = "e2e-auto-title" ] \
    && pass "backend auto-title adopted by /api/state" || fail "sync stuck at: $SYNCED"
  openMgr "document.querySelector('[data-sess="$SESS"] .lbl')" "sidebar row present for auto-title" || true
  AUTO_PAINT="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var row = document.querySelector('[data-sess="$SESS"]'); return row ? row.innerText : "no-row"; })()
EOF
)"
  echo "$AUTO_PAINT" | grep -q "e2e-auto-title" \
    && pass "sidebar paints auto title" || fail "sidebar stale: $AUTO_PAINT"
fi

echo "== api: manager restart adopts the live backend (no worker interrupt)"
# Deploy restarts must not interrupt in-flight opencode turns: web backends
# survive manager shutdown and the rebooted manager adopts them (same pid,
# same bound chat) instead of respawning.
if [ -z "$HID" ] || [ -z "$HPORT" ] || [ -z "$PW" ]; then
  fail "no bound backend chat from earlier section (hid=$HID port=$HPORT)"
else
  BEFORE_PID="$(curl -s -m 10 -u "opencode:$PW" "http://127.0.0.1:$HPORT/api/info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pid",""))' 2>/dev/null || true)"
  [ -n "$BEFORE_PID" ] || fail "could not read backend pid"
  kill "$MGR_PID"
  for _ in $(seq 1 15); do port_free "$MGR_PORT" && break; sleep 1; done
  port_free "$MGR_PORT" || { fail "scratch manager did not stop"; exit 1; }
  if kill -0 "$BEFORE_PID" 2>/dev/null; then
    pass "backend survived manager shutdown (pid $BEFORE_PID)"
  else
    fail "backend died with manager (pid $BEFORE_PID)"
  fi
  AI_MGR_PORT="$MGR_PORT" AI_MGR_DATA="$TMP/data/manager.json" \
    AI_MGR_HARNESS_BASE_PORT="$HARNESS_BASE" \
    nohup node src/server/index.js > "$TMP/manager2.log" 2>&1 &
  MGR_PID=$!
  for _ in $(seq 1 12); do
    curl -s -m 3 "$MGR/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -s -m 5 "$MGR/health" >/dev/null || { fail "rebooted manager never came up (see $TMP/manager2.log)"; exit 1; }
  AFTER_PID="$(curl -s -m 10 -u "opencode:$PW" "http://127.0.0.1:$HPORT/api/info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pid",""))' 2>/dev/null || true)"
  [ "$AFTER_PID" = "$BEFORE_PID" ] \
    && pass "rebooted manager adopted same backend" || fail "backend respawned ($BEFORE_PID -> $AFTER_PID)"
  ADOPTED="$(curl -s -m 20 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
s=next((x for x in ss if x['id']=='$SESS'),{})
print(s.get('status','MISSING'), s.get('title','NOTITLE'))")"
  echo "$ADOPTED" | grep -q "^running e2e-auto-title" \
    && pass "adopted session running with title intact" || fail "adopted state wrong: $ADOPTED"
fi

echo "== browser: left panel hides harness tag, title uses full width"
# Sidebar session rows + attention shelf must not render the harness pill
# (removed); hover-only rename/delete buttons must take no flex space until
# hovered so the title label spans the row (regression: invisible buttons
# reserved ~60px and titles ellipsized early).
LEFTPANEL_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  tagInRows: document.querySelectorAll('#wsList .sess .tag').length,
  tagInShelf: document.querySelectorAll('#attentionShelf .tag').length,
  renameDisplay: (() => { var b = document.querySelector('[data-sess="$SESS"] .sess-rename-hover'); return b ? getComputedStyle(b).display : 'absent'; })(),
  delDisplay: (() => { var b = document.querySelector('[data-sess="$SESS"] .sess-del-hover'); return b ? getComputedStyle(b).display : 'absent'; })(),
  lblShare: (() => { var row = document.querySelector('[data-sess="$SESS"]'); var lbl = row && row.querySelector('.lbl'); if (!row || !lbl) return 0; return lbl.getBoundingClientRect().width / row.getBoundingClientRect().width; })()
}))()
EOF
)"
LEFTPANEL="$(echo "$LEFTPANEL_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$LEFTPANEL" | grep -q '"tagInRows":0' \
  && pass "no harness tag in sidebar rows" || fail "harness tag still in rows: $LEFTPANEL"
echo "$LEFTPANEL" | grep -q '"tagInShelf":0' \
  && pass "no harness tag in attention shelf" || fail "harness tag still in shelf: $LEFTPANEL"
echo "$LEFTPANEL" | grep -q '"renameDisplay":"none"' \
  && pass "rename button takes no space until hover" || fail "rename button visible: $LEFTPANEL"
echo "$LEFTPANEL" | grep -q '"delDisplay":"none"' \
  && pass "delete button takes no space until hover" || fail "delete button visible: $LEFTPANEL"
LBLSHARE="$(echo "$LEFTPANEL" | python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('lblShare',0))" "$LEFTPANEL" 2>/dev/null || echo 0)"
python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > 0.65 else 1)" "$LBLSHARE" \
  && pass "title spans row (share $LBLSHARE)" || fail "title cramped (share $LBLSHARE): $LEFTPANEL"

echo "== api+browser: no-prompt session keeps its default title (fallback guard)"
# Fallback guard for title-from-first-message (src/server/sessions.js
# syncSessionTitle): with zero user messages the sync must leave the creation
# default alone — no invented or empty titles. Derivation itself is covered by
# stub-level tests (tests/sessions.test.js); this script deliberately never
# sends a prompt (that would run a billed agent turn), so no real backend
# chat here can carry user messages.
SESS2="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
T2="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s['title'] for s in ss if s['id']=='$SESS2'),'MISSING'))")"
echo "$T2" | grep -q "^opencode · " \
  && pass "default-titled session created ($T2)" || fail "unexpected creation title: $T2"
sleep 10
T2B="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s['title'] for s in ss if s['id']=='$SESS2'),'MISSING'))")"
[ -n "$T2B" ] && [ "$T2B" = "$T2" ] \
  && pass "no-prompt title untouched by sync ($T2B)" || fail "sync rewrote no-prompt title: $T2 -> $T2B"
openMgr "document.querySelector('[data-sess="$SESS2"] .lbl')" "sidebar row present for no-prompt session" || true
PAINT2="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var row = document.querySelector('[data-sess="$SESS2"]'); return row ? row.innerText : "no-row"; })()
EOF
)"
echo "$PAINT2" | grep -q "opencode" \
  && pass "sidebar paints default title" || fail "sidebar stale for no-prompt session: $PAINT2"

echo "== api: opencode sessions share one background backend"
# One `opencode serve` hosts every manager opencode session as a chat
# (POST /api/session); per-session backend processes are gone. SESS + SESS2
# already exist, so this asserts sharing with zero extra boot cost.
OP_PORTS="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=[s for s in json.load(sys.stdin)['sessions'] if s.get('harness')=='opencode' and s.get('mode')=='web']
print(' '.join(sorted(str(s.get('port')) for s in ss)))")"
echo "opencode ports: $OP_PORTS"
NUNIQ="$(echo "$OP_PORTS" | tr ' ' '\n' | sort -u | grep -c . || true)"
[ "$NUNIQ" = "1" ] \
  && pass "all opencode sessions share one port ($OP_PORTS)" || fail "opencode sessions span $NUNIQ ports: $OP_PORTS"
# A further create must not boot a backend (chat pre-create only: seconds,
# not the ~60s cold serve boot) and must land on the same shared port.
T0="$(date +%s)"
SESS_SH="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-shared-third\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
T1="$(date +%s)"; SH_DT=$((T1 - T0))
SH_PORT="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((str(s.get('port')) for s in ss if s['id']=='$SESS_SH'),'MISSING'))")"
FIRST_PORT="$(echo "$OP_PORTS" | tr ' ' '\n' | sort -u | head -1)"
[ "$SH_PORT" = "$FIRST_PORT" ] \
  && pass "third session lands on the shared port ($SH_PORT)" || fail "third session on $SH_PORT, want $FIRST_PORT"
[ "$SH_DT" -lt 25 ] \
  && pass "shared create fast (${SH_DT}s, no backend boot)" || fail "shared create slow: ${SH_DT}s"
# Create pre-warms workspace config over loopback (sessions.js
# prewarmSessionConfig, fired by the create route): the new session's first
# config GET must be a HIT without the browser having asked first. Poll
# briefly — the warm runs in the background after the POST responds.
SH_HIT=""
for _ in $(seq 1 10); do
  SH_HIT="$(curl -s -m 10 -D - -o /dev/null "$MGR/s/$SESS_SH/api/config" | tr -d '\r' | grep -i '^x-aimgr-cache:' || true)"
  echo "$SH_HIT" | grep -qi "HIT" && break
  sleep 1
done
echo "$SH_HIT" | grep -qi "HIT" \
  && pass "created session opens pre-warmed (config HIT)" || fail "no pre-warm after create: $SH_HIT"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_SH" >/dev/null 2>&1 || true

echo "== browser+api: web-to-web switch reuses the cached view (no reload)"
# Static markers: per-pane iframe cache (a few views kept in memory) +
# server liveness cache (rapid switches skip TCP probe + backend calls).
grep -q "FRAME_CACHE_N" src/public/app.js \
  && pass "frontend keeps a few web views cached" || fail "no FRAME_CACHE_N in app.js"
grep -q "isFrameCached" src/public/app.js \
  && pass "instant cached-switch path present" || fail "no isFrameCached in app.js"
grep -q "purgeSessionFrames" src/public/app.js \
  && pass "deleted sessions purge cached views" || fail "no purgeSessionFrames in app.js"
grep -q "isRecentlyAlive" src/server/sessions.js \
  && pass "server liveness cache present" || fail "no alive cache in sessions.js"
# API: warm the liveness cache, then time a repeated ensure — rapid switches
# must not re-probe (bound is generous; uncached adopt+title-sync is seconds).
curl -s -m 30 -X POST "$MGR/api/sessions/$SESS/ensure" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
ENSURE_MS="$(python3 -c "
import time, urllib.request
t0=time.time()
urllib.request.urlopen(urllib.request.Request('$MGR/api/sessions/$SESS/ensure', data=b'{}', headers={'Content-Type':'application/json'}), timeout=30).read()
print(int((time.time()-t0)*1000))")"
python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) < 8000 else 1)" "$ENSURE_MS" \
  && pass "repeated ensure fast (${ENSURE_MS}ms)" || fail "repeated ensure slow: ${ENSURE_MS}ms"
# Browser: pane 0 shows SESS, detour to SESS2 (second web view), switch back.
# The SESS document must be the SAME element (shown, not reloaded) and the
# pane must hold both views within the keep-N budget.
openMgr "document.querySelector('#paneGrid .pane')" "manager page booted for web-to-web switch" || true
for _ in $(seq 1 12); do
  HAS_BOTH="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].filter((o) => o.value === "$SESS" || o.value === "$SESS2").length.toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_BOTH" | grep -q "2" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var s = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select'); s.value = "$SESS"; s.dispatchEvent(new Event('change', { bubbles: true })); return "on-web-a"; })()
EOF
sleep 8
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var f = [...document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame')].find((x) => (x.dataset && x.dataset.sess === "$SESS") || (x.getAttribute('src') || '').includes("$SESS")); if (f) f.dataset.cacheMark = "e2e"; return "marked"; })()
EOF
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var s = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select'); s.value = "$SESS2"; s.dispatchEvent(new Event('change', { bubbles: true })); return "on-web-b"; })()
EOF
sleep 8
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var s = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select'); s.value = "$SESS"; s.dispatchEvent(new Event('change', { bubbles: true })); return "back-to-a"; })()
EOF
sleep 3
REUSE_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; return JSON.stringify({ kept: !!p.querySelector('.pane-frame[data-cache-mark="e2e"]'), frames: p.querySelectorAll('.pane-frame').length }); })()
EOF
)"
REUSE="$(echo "$REUSE_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$REUSE" | grep -q '"kept":true' \
  && pass "switch-back reuses the cached view (no reload)" || fail "cached view not reused: $REUSE"
NFRAMES="$(echo "$REUSE" | python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('frames',99))" "$REUSE" 2>/dev/null || echo 99)"
python3 -c "import sys; sys.exit(0 if 1 <= int(sys.argv[1]) <= 3 else 1)" "$NFRAMES" \
  && pass "pane holds both views within budget ($NFRAMES)" || fail "frame budget wrong: $REUSE"
# Client-side switching: same-backend web→web switches must not reboot the
# SPA — the live view navigates its own route to the target chat (one
# document navigation total: the cold boot; the detour + return add none).
# The iframe URL must carry the target session's backend chat id.
HID_A="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s.get('harnessSessionId','') for s in ss if s['id']=='$SESS'),''))")"
NAV_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { var w = f.contentWindow; return JSON.stringify({ navs: w.performance.getEntriesByType('navigation').length, href: w.location.href }); } catch (e) { return JSON.stringify({ err: String(e).slice(0, 60) }); } })()
EOF
)"
NAV="$(echo "$NAV_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NAV" | grep -q '"navs":1' \
  && pass "switches add no document navigation (client-side)" || fail "SPA rebooted on switch: $NAV_RAW"
echo "$NAV" | grep -q "$HID_A" \
  && pass "live view routed to the target chat" || fail "live view not on target chat: $NAV_RAW"

echo "== browser: top-bar New Session inits in the live view (no SPA reboot)"
# Real init path: the top-bar button POSTs /api/sessions, then activates the
# new session in the focused pane. The live SPA must route to the just-created
# chat (never fetched in this document, no tab link yet) with no new document
# (fast-accept fresh lane) and the stage loader must clear promptly:
# strict-only verify would stall ~6s on "switching…" then park on "loading…"
# for the 15s fallback (loader visible ~21s total), which is the reported
# "new session takes forever" gap. Restores SESS afterwards so the sidebar
# blocks below start from a live session (never leave the pane on a session
# about to be deleted).
BEFORE_NAV_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1 || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { var w = f.contentWindow; var rs = w.performance.getEntriesByType('resource'); var old = 0; for (var i = 0; i < rs.length; i++) { if (String(rs[i].name || '').includes("/api/session/$HID_A/message")) old++; } return JSON.stringify({ navs: w.performance.getEntriesByType('navigation').length, frames: p.querySelectorAll('.pane-frame').length, oldMsg: old }); } catch (e) { return JSON.stringify({ err: "x" }); } })()
EOF
)"
BEFORE_NAV="$(echo "$BEFORE_NAV_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
BEFORE_NNAV="$(echo "$BEFORE_NAV" | python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("navs","?"))' "$BEFORE_NAV" 2>/dev/null || echo "?")"
BEFORE_OLDMSG="$(echo "$BEFORE_NAV" | python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("oldMsg",-1))' "$BEFORE_NAV" 2>/dev/null || echo "-1")"
BEFORE_NSESS="$(curl -s -m 10 "$MGR/api/state" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["sessions"]))')"
agent-browser eval "document.getElementById('btnNewSessionTop').click()" >/dev/null 2>&1 || true
T0="$(date +%s)"
FRESH_NAV_RAW=""
for _ in $(seq 1 15); do
  sleep 2
  FRESH_NAV_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1 || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { var w = f.contentWindow; var el = document.getElementById('stageLoader'); var rs = w.performance.getEntriesByType('resource'); var old = 0; for (var i = 0; i < rs.length; i++) { if (String(rs[i].name || '').includes("/api/session/$HID_A/message")) old++; } return JSON.stringify({ navs: w.performance.getEntriesByType('navigation').length, href: w.location.href, frames: p.querySelectorAll('.pane-frame').length, loaderHidden: el ? el.classList.contains('hidden') : "absent", sessions: (typeof state !== "undefined" ? state.sessions.length : -1), oldMsg: old }); } catch (e) { return JSON.stringify({ err: "x" }); } })()
EOF
)"
  FRESH_NAV="$(echo "$FRESH_NAV_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  echo "$FRESH_NAV" | grep -q '"loaderHidden":true' || continue
  python3 -c "import sys,json; d=json.loads(sys.argv[1]); sys.exit(0 if d.get('sessions',-1)==int(sys.argv[2])+1 else 1)" "$FRESH_NAV" "$BEFORE_NSESS" 2>/dev/null && break
done
T1="$(date +%s)"; FRESH_DT=$((T1 - T0))
FRESH_NAV="$(echo "$FRESH_NAV_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
SESS_FN="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=[s for s in json.load(sys.stdin)['sessions'] if s.get('harness')=='opencode']
ss.sort(key=lambda s: s.get('createdAt',0), reverse=True)
print(ss[0]['id'] if ss else '')")"
HID_FN="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s.get('harnessSessionId','') for s in ss if s['id']=='$SESS_FN'),''))")"
[ -n "$HID_FN" ] \
  && echo "$FRESH_NAV" | grep -q "$HID_FN" \
  && echo "$FRESH_NAV" | grep -q "\"navs\":$BEFORE_NNAV" \
  && python3 -c "import sys,json; d=json.loads(sys.argv[1]); sys.exit(0 if 1 <= d.get('frames',99) <= 3 else 1)" "$FRESH_NAV" \
  && python3 -c "import sys,json; d=json.loads(sys.argv[1]); sys.exit(0 if d.get('oldMsg',-1)>=int(sys.argv[2]) else 1)" "$FRESH_NAV" "$BEFORE_OLDMSG" \
  && [ "$FRESH_DT" -lt 15 ] \
  && pass "new session inits client-side (${FRESH_DT}s, one document, on new chat)" || fail "new session rebooted/stalled SPA: $FRESH_NAV_RAW"
# Back to the target chat for the sidebar blocks below; the throwaway goes away.
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var s = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select'); s.value = "$SESS"; s.dispatchEvent(new Event('change', { bubbles: true })); return "back-to-target"; })()
EOF
sleep 4
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_FN" >/dev/null 2>&1 || true
SESS_FN=""

echo "== browser: sidebar-row switch routes client-side with rows intact"
# Same switch through the complaint path (left-panel row click, not the pane
# dropdown): mark the target row, detour via the SESS2 row, switch back via
# the SESS row. The live view must route with no document navigation, and the
# marked row node must survive the switch renders + background polls (a
# wholesale innerHTML rebuild would destroy it).
HIDS="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
g=lambda i: next((s.get('harnessSessionId','') for s in ss if s['id']==i),'')
print(g('$SESS'), g('$SESS2'))" || echo "HID-ERR")"
HID_B="$(echo "$HIDS" | awk '{print $2}')"
echo "switch hids: SESS2->$HID_B"
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var r = document.querySelector('[data-sess="$SESS"]'); if (r) r.dataset.e2eKeep = "1"; var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = p && [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); if (f) f.dataset.navMark = "e2e"; return "marked"; })()
EOF
NAV0_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1 || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { return JSON.stringify({ navs: f.contentWindow.performance.getEntriesByType('navigation').length, mark: (f.dataset && f.dataset.navMark) || null }); } catch (e) { return JSON.stringify({ err: "x" }); } })()
EOF
)"
NAV0="$(echo "$NAV0_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var row = document.querySelector('[data-sess="$SESS2"]'); if (!row) return "no-row"; row.click(); return "detoured"; })()
EOF
HREF_B=""
for _ in $(seq 1 12); do
  sleep 2
  HREF_B="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1 || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { return f.contentWindow.location.href; } catch (e) { return "unreadable"; } })()
EOF
)"
  echo "$HREF_B" | grep -q "$HID_B" && break
done
if echo "$HREF_B" | grep -q "$HID_B"; then
  pass "sidebar click detoured to the second chat"
else
  GOTB="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s.get('harnessSessionId','') for s in ss if s['id']=='$SESS2'),'MISSING'))" || echo "STATE-ERR")"
  fail "detour missed second chat (want $HID_B now $GOTB in $HREF_B)"
  agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -3 || true
(() => JSON.stringify([...document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame')].map((f) => ({ sess: (f.dataset && f.dataset.sess) || null, src: (f.getAttribute('src') || '').slice(-40), hidden: f.classList.contains('hidden') }))))()
EOF
fi
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var row = document.querySelector('[data-sess="$SESS"]'); if (!row) return "no-row"; row.click(); return "back"; })()
EOF
HREF_A=""
for _ in $(seq 1 12); do
  sleep 2
  HREF_A="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1 || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { return f.contentWindow.location.href; } catch (e) { return "unreadable"; } })()
EOF
)"
  echo "$HREF_A" | grep -q "$HID_A" && break
done
echo "$HREF_A" | grep -q "$HID_A" \
  && pass "sidebar click switched back to the target chat" || fail "switch-back missed target chat: $HREF_A"
NAV2_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1 || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); try { return JSON.stringify({ navs: f.contentWindow.performance.getEntriesByType('navigation').length, mark: (f.dataset && f.dataset.navMark) || null }); } catch (e) { return JSON.stringify({ err: "x" }); } })()
EOF
)"
NAV2="$(echo "$NAV2_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NAV2" | grep -q '"navs":1' \
  && echo "$NAV2" | grep -q '"mark":"e2e"' \
  && echo "$NAV0" | grep -q '"mark":"e2e"' \
  && pass "two sidebar switches reuse the one live view ($NAV2)" || fail "SPA rebooted on sidebar switch: $NAV0 -> $NAV2"
# Force a full poll-cycle refresh; the marked row node must still be there.
agent-browser eval "refresh()" >/dev/null 2>&1 || true
KEPT=""
for _ in $(seq 1 10); do
  sleep 2
  KEPT_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1 || true
(() => { try { return JSON.stringify({ rows: document.querySelectorAll('#wsList [data-sess]').length, marked: !!document.querySelector('[data-sess="$SESS"][data-e2e-keep="1"]'), sessions: (typeof state !== "undefined" ? state.sessions.length : -1) }); } catch (e) { return JSON.stringify({ err: "x" }); } })()
EOF
)"
  KEPT="$(echo "$KEPT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  echo "$KEPT" | grep -q '"marked":true' && break
done
echo "$KEPT" | grep -q '"marked":true' \
  && pass "sidebar row node survives switch renders + refresh (keyed update)" || fail "row node lost: $KEPT"
# Cold switches must take the loader path: the "on-web-b" detour above ran on
# a fresh page (SESS2 never loaded), so the stage loader element must exist
# now. Regression: the instant branch probed the cache AFTER paintPane had
# already created the new frame, so it always "hit" and cold switches showed
# a blank frame with zero feedback (loader path dead code).
LOADER_RAW="$(agent-browser eval "!!document.getElementById('stageLoader')" 2>/dev/null | tail -1)"
echo "$LOADER_RAW" | grep -q "true" \
  && pass "cold switch takes the loader path" || fail "no stage loader after cold switch: $LOADER_RAW"
# Warm switch-back must not stick the pill: back-to-a reuses the live view
# (client-side nav hides on verify) and the real document load hides it
# otherwise — the about:blank commit must not count (it used to hide the
# loader ~10ms in, before content arrived; the inverse failure — ignoring
# real loads — would leave it visible here, past the sleep below). The nav
# verify is async (up to ~6s on a loaded box), so poll for the clear instead
# of reading once.
STUCK=""
for _ in $(seq 1 10); do
STUCK_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var el = document.getElementById("stageLoader"); return JSON.stringify(el ? !el.classList.contains("hidden") : "absent"); })()
EOF
)"
STUCK="$(echo "$STUCK_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$STUCK" = "false" ] && break
sleep 1
done
[ "$STUCK" = "false" ] \
  && pass "stage loader clears after switch-back" || fail "loader stuck visible: $STUCK_RAW"
# Deleting SESS2 via API must drop its cached document on the next poll.
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS2" >/dev/null 2>&1 || true
sleep 10
GONE2_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => [...document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame')].some((f) => ((f.dataset && f.dataset.sess) || '') === "$SESS2" || (f.getAttribute('src') || '').includes("$SESS2")).toString())()
EOF
)"
GONE2="$(echo "$GONE2_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$GONE2" = "false" ] \
  && pass "deleted session purged from cache" || fail "stale cached view lingers: $GONE2_RAW"

echo "== browser: sidebar minus removes the session with no confirm dialog"
# The hover minus deletes on a single click — no confirm() may appear (a
# native dialog would stall headless input and annoy). Uses a throwaway
# session so the main $SESS flow is untouched.
SESS3="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-minus\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
openMgr "document.querySelector('[data-sess="$SESS3"] .lbl')" "sidebar row present for minus" || true
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var b = document.querySelector('[data-sess="$SESS3"] .sess-del-hover'); if (!b) return "no-btn"; b.click(); return "clicked"; })()
EOF
GONE=""
for _ in $(seq 1 10); do
  sleep 2
  GONE="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print('gone' if '$SESS3' not in [s['id'] for s in ss] else 'present')")"
  [ "$GONE" = "gone" ] && break
done
[ "$GONE" = "gone" ] \
  && pass "minus click deleted session without confirm" || fail "session still present after minus click: $GONE"
ROW3="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => document.querySelector('[data-sess="$SESS3"]') ? "still-there" : "gone")()
EOF
)"
echo "$ROW3" | grep -q "gone" \
  && pass "sidebar row removed" || fail "sidebar row lingers: $ROW3"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS3" >/dev/null 2>&1 || true

echo "== browser: session minus removes from workspace + mobile dismisses menu"
# Per-session minus (not hidden behind desktop-only hover on touch) removes
# the session; tapping any sidebar item on mobile closes the overlay drawer.
MINUS_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  href: location.href,
  delText: (() => { var b = document.querySelector('[data-sess="$SESS"] .sess-del-hover'); return b ? b.textContent.trim() : 'absent'; })(),
  delTitle: (() => { var b = document.querySelector('[data-sess="$SESS"] .sess-del-hover'); return b ? (b.getAttribute('title') || '') : 'absent'; })(),
  touchRule: (() => { try { return [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.conditionText && r.conditionText.includes('768px') && r.cssText.includes('sess-del-hover')); } catch { return false; } }); } catch { return 'unknown'; } })(),
  hasDismiss: (typeof dismissMobileSidebar === 'function'),
  dismissWorks: (() => { try { var l = document.getElementById('left'); l.classList.add('open'); var orig = window.matchMedia; window.matchMedia = (q) => ({ matches: String(q).includes('768'), media: q, addListener(){}, removeListener(){} }); dismissMobileSidebar(); var closed = !l.classList.contains('open'); window.matchMedia = orig; l.classList.remove('open'); return closed; } catch (e) { return 'err:' + e.message; } })()
}))()
EOF
)"
MINUS="$(echo "$MINUS_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$MINUS" | grep -q '"delText":"−"' \
  && pass "session row has minus control" || fail "session minus missing: $MINUS"
echo "$MINUS" | grep -qi 'remove.*workspace' \
  && pass "minus titled remove-from-workspace" || fail "minus title wrong: $MINUS"
echo "$MINUS" | grep -q '"touchRule":true' \
  && pass "mobile shows minus (768px rule)" || fail "no mobile minus rule: $MINUS"
echo "$MINUS" | grep -q '"hasDismiss":true' \
  && pass "mobile dismiss helper present" || fail "no dismissMobileSidebar: $MINUS"
echo "$MINUS" | grep -q '"dismissWorks":true' \
  && pass "menu item dismisses mobile drawer" || fail "drawer not dismissed: $MINUS"

echo "== browser: removed chrome stays gone (sessionBar/statusline/shortcut-tip/sidebar-heading)"
# Deleted manager chrome must not render: no session bar, no bottom
# statusline, no sidebar shortcut tip, no sidebar heading text. The sidebar
# count pill + left-panel rename/minus own the bar's old jobs.
openMgr "document.getElementById('sidebarCountPill')" "manager page booted for chrome check" || true
CHROME_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  href: location.href,
  sessionBar: !!document.getElementById('sessionBar'),
  statusline: !!document.getElementById('statusline'),
  statusText: !!document.getElementById('statusText'),
  hostStatus: !!document.getElementById('hostStatus'),
  shortcutTip: !!document.querySelector('.shortcut-tip'),
  sideHeading: !!document.querySelector('.sidebar-heading'),
  headingText: document.body.innerText.includes('WORKSPACES & SESSIONS'),
  barFn: (typeof renderSessionBar !== 'undefined'),
  countPill: !!document.getElementById('sidebarCountPill')
}))()
EOF
)"
CHROME="$(echo "$CHROME_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
for k in sessionBar statusline statusText hostStatus shortcutTip sideHeading headingText barFn; do
  echo "$CHROME" | grep -q "\"$k\":false" \
    && pass "no $k" || fail "removed chrome present ($k): $CHROME"
done
echo "$CHROME" | grep -q '"countPill":true' \
  && pass "sidebar count pill kept" || fail "count pill missing: $CHROME"

echo "== browser: top-bar harness switch owns new-session default (one-click create, no modal)"
# New Session buttons create instantly — no "Launch New AI Session" popup.
# The harness switch top-right picks the harness; quick-create POSTs directly.
openMgr "document.getElementById('harnessSwitch')" "harness switch present" || true
SWITCH_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  sw: !!document.getElementById('harnessSwitch'),
  inTopRight: !!document.querySelector('.top-right #harnessSwitch'),
  btns: [...document.querySelectorAll('#harnessSwitch .hs-btn')].map(b => b.dataset.harness),
  selCount: document.querySelectorAll('#harnessSwitch .hs-btn.sel').length,
  sel: ((document.querySelector('#harnessSwitch .hs-btn.sel') || {}).dataset || {}).harness || null
}))()
EOF
)"
SWITCH="$(echo "$SWITCH_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$SWITCH" | grep -q '"inTopRight":true' \
  && pass "switch sits top-right" || fail "switch not top-right: $SWITCH"
for h in opencode droid dsh agy; do
  echo "$SWITCH" | grep -q "$h" \
    && pass "switch offers $h" || fail "switch missing $h: $SWITCH"
done
echo "$SWITCH" | grep -q '"selCount":1' \
  && pass "exactly one harness selected" || fail "selection count wrong: $SWITCH"
# Click droid: selection + localStorage must follow (no hidden modal field any more).
CLICK_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var b = document.querySelector('#harnessSwitch .hs-btn[data-harness="droid"]'); if (!b) return "no-btn"; b.click(); return JSON.stringify({ sel: (document.querySelector('#harnessSwitch .hs-btn.sel') || {}).dataset.harness, stored: localStorage.getItem('ai-manager.harness') }); })()
EOF
)"
CLICK="$(echo "$CLICK_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$CLICK" | grep -q '"sel":"droid"' \
  && pass "switch selects droid" || fail "droid not selected: $CLICK"
echo "$CLICK" | grep -q '"stored":"droid"' \
  && pass "selection persists to localStorage" || fail "not persisted: $CLICK"
# One-click New Session: no modal popup exists, and clicking the top-bar
# button creates a droid session directly (PTY spawn is fast — no 60s boot).
BEFORE_N="$(curl -s -m 10 "$MGR/api/state" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['sessions']))")"
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnNewSessionTop'); if (b) b.click(); return "clicked"; })()
EOF
QUICK="none"
for _ in $(seq 1 15); do
  sleep 2
  QUICK="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = json.load(sys.stdin)['sessions']
print(len(ss))")"
  [ "$QUICK" -gt "$BEFORE_N" ] 2>/dev/null && break
done
python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) > int(sys.argv[2]) else 1)" "$QUICK" "$BEFORE_N" \
  && pass "top-bar New Session creates directly (no modal)" || fail "no session created: $BEFORE_N -> $QUICK"
QUICKH="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = sorted(json.load(sys.stdin)['sessions'], key=lambda s: s.get('createdAt',0), reverse=True)
print(ss[0].get('harness','') if ss else '')")"
[ "$QUICKH" = "droid" ] \
  && pass "quick-create uses the switch pick (droid)" || fail "quick-create harness wrong: $QUICKH"
# Clean up the quick-created session so later assertions see a stable set.
# Guarded by count growth: if quick-create failed, QUICKID would be a
# pre-existing session (e.g. the main $SESS) and deleting it would cascade
# failures through every later section.
QUICKID="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = sorted(json.load(sys.stdin)['sessions'], key=lambda s: s.get('createdAt',0), reverse=True)
print(ss[0].get('id','') if ss else '')")"
[ "$QUICK" -gt "$BEFORE_N" ] 2>/dev/null && [ -n "$QUICKID" ] && curl -s -m 10 -X DELETE "$MGR/api/sessions/$QUICKID" >/dev/null 2>&1 || true
NOMODAL_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  modalGone: !document.getElementById('modal'),
  quickFn: (typeof quickCreateSession === 'function')
}))()
EOF
)"
NOMODAL="$(echo "$NOMODAL_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NOMODAL" | grep -q '"modalGone":true' \
  && pass "Launch New AI Session popup removed" || fail "modal still present: $NOMODAL"
echo "$NOMODAL" | grep -q '"quickFn":true' \
  && pass "quick-create entry point present" || fail "no quickCreateSession: $NOMODAL"
# Reload: the droid pick must survive.
openMgr "document.querySelector('#harnessSwitch .hs-btn.sel')" "manager page booted for harness reload check" keep || true
KEPT_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({ sel: ((document.querySelector('#harnessSwitch .hs-btn.sel') || {}).dataset || {}).harness || null, stored: localStorage.getItem('ai-manager.harness') }))()
EOF
)"
KEPT="$(echo "$KEPT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$KEPT" | grep -q '"sel":"droid"' \
  && pass "switch pick survives reload" || fail "pick lost on reload: $KEPT"
# Reset to the default so later runs start clean.
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.querySelector('#harnessSwitch .hs-btn[data-harness="opencode"]'); if (b) b.click(); return "reset"; })()
EOF

echo "== browser: split-screen panes view multiple sessions at once"
# Toolbar + grid present; Split adds a second live pane; sidebar rows offer
# open-in-split; per-pane dropdowns can hold different sessions concurrently.
openMgr "document.querySelector('[data-sess] .lbl')" "sidebar rows present for split" || true
SPLITBAR_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  paneBar: !!document.getElementById('paneBar'),
  paneGrid: !!document.getElementById('paneGrid'),
  splitCols: !!document.getElementById('btnSplitCols'),
  splitRows: !!document.getElementById('btnSplitRows'),
  closePane: !!document.getElementById('btnClosePane'),
  splitCtl: !!document.querySelector('[data-sess] .sess-split-hover')
}))()
EOF
)"
SPLITBAR="$(echo "$SPLITBAR_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
for k in paneBar paneGrid splitCols splitRows closePane splitCtl; do
  echo "$SPLITBAR" | grep -q "\"$k\":true" \
    && pass "split chrome present ($k)" || fail "split chrome missing ($k): $SPLITBAR"
done
# Served session HTML carries the per-pane API scope so concurrent web panes
# route /api + WS explicitly instead of sharing one cookie.
echo "$HTML" | grep -q "aimgr-api-scope" \
  && pass "served HTML has aimgr-api-scope" || fail "served HTML missing aimgr-api-scope"
# Split vertically, then assign two different sessions side by side. The
# second session is a droid PTY (fast spawn, no 60s web boot) to keep e2e quick.
# Assign the first pane explicitly: a fresh page boots with empty panes. The
# dropdown only offers sessions from the last /api/state poll, so wait for the
# option first (same race as the second-pane assign below).
for _ in $(seq 1 12); do
  HAS_WEB0="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_WEB0" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var pane = document.querySelectorAll('#paneGrid .pane')[0];
  if (!pane) return "no-pane";
  var sel = pane.querySelector('.pane-select');
  if (!sel) return "no-select";
  sel.value = "$SESS";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-first";
})()
EOF
sleep 8
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 3
SESS_SPLIT="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-split-second\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
# The pane dropdown only offers sessions from the last /api/state poll (8s):
# assigning before the new id appears as an <option> sets value "" and the
# change handler clears the pane instead. Wait for the option first.
for _ in $(seq 1 12); do
  HAS_OPT="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[1]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS_SPLIT").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_OPT" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var panes = document.querySelectorAll('#paneGrid .pane');
  if (panes.length < 2) return "need-2-panes";
  var sel = panes[1].querySelector('.pane-select');
  if (!sel) return "no-select";
  sel.value = "$SESS_SPLIT";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned";
})()
EOF
sleep 6
SPLITSTATE_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  href: location.href,
  panes: document.querySelectorAll('#paneGrid .pane').length,
  pill: (document.getElementById('paneCount') || {}).textContent || null,
  firstSrc: (() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = p && [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); return f ? (f.getAttribute('src') || '') : 'absent'; })(),
  secondHasTerm: (() => { var t = document.querySelectorAll('#paneGrid .pane .pane-term')[1]; return t ? !t.classList.contains('hidden') : false; })(),
  bothVisible: (() => { var ps = document.querySelectorAll('#paneGrid .pane'); if (ps.length < 2) return false; return [...ps].every(p => p.offsetParent !== null); })()
}))()
EOF
)"
SPLITSTATE="$(echo "$SPLITSTATE_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$SPLITSTATE" | grep -q '"panes":2' \
  && pass "two split panes live" || fail "pane count wrong: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q '"pill":"2"' \
  && pass "pane count pill shows 2" || fail "pane pill wrong: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q "$SESS" \
  && pass "first pane keeps its web session" || fail "first pane lost session: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q '"secondHasTerm":true' \
  && pass "second pane runs a different session live" || fail "second pane not live: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q '"bothVisible":true' \
  && pass "both sessions visible at the same time" || fail "panes not co-visible: $SPLITSTATE"
# Layout persists across reload (panes + direction in localStorage).
openMgr "document.querySelectorAll('#paneGrid .pane').length" "manager page booted for layout check" keep || true
SPLITKEPT_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  panes: document.querySelectorAll('#paneGrid .pane').length,
  stored: !!localStorage.getItem('ai-manager.panes')
}))()
EOF
)"
SPLITKEPT="$(echo "$SPLITKEPT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$SPLITKEPT" | grep -q '"panes":2' \
  && pass "split layout survives reload" || fail "layout lost on reload: $SPLITKEPT"
echo "$SPLITKEPT" | grep -q '"stored":true' \
  && pass "split layout persisted to localStorage" || fail "not persisted: $SPLITKEPT"
# Close back to a single pane.
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
sleep 2
SPLITCLOSED="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
echo "$SPLITCLOSED" | grep -q "1" \
  && pass "close pane returns to single view" || fail "close pane failed: $SPLITCLOSED"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_SPLIT" >/dev/null 2>&1 || true

echo "== browser: sidebar switch follows the focused pane, not the newest"
# Regression: clicks inside a web iframe never bubbled pointerdown outward,
# so the focused pane stayed stuck on the newest split and a sidebar switch
# landed there instead of the window the user clicked. Focusing pane 0's
# iframe must move .focused there; the next sidebar switch must then replace
# pane 0's session while pane 1 keeps its own.
SESS_FB=""; SESS_FC=""
SESS_FB="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-focus-b\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
SESS_FC="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-focus-c\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
openMgr "document.querySelector('[data-sess] .lbl')" "manager page booted with rows" || true
# Normalize to a single pane (prior sections may leave one or two).
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
  sleep 2
done
# Pane 0 shows the web session (its iframe is visible, so it can take focus).
for _ in $(seq 1 12); do
  HAS_WEBO="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_WEBO" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select');
  sel.value = "$SESS";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-web";
})()
EOF
sleep 8
# Split: the new (newest) pane becomes active.
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 3
for _ in $(seq 1 12); do
  HAS_FB="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[1]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS_FB").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_FB" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[1].querySelector('.pane-select');
  sel.value = "$SESS_FB";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-b";
})()
EOF
sleep 6
# Focus pane 0 through its web iframe — the equivalent of clicking web
# content (outer focus lands on the iframe element itself).
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = p && [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); if (f) f.focus(); return "focused-iframe"; })()
EOF
sleep 2
FOCUSED_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => [...document.querySelectorAll('#paneGrid .pane')].findIndex((p) => p.classList.contains('focused')).toString())()
EOF
)"
FOCUSED="$(echo "$FOCUSED_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$FOCUSED" = "0" ] \
  && pass "iframe click moves focus to that pane" || fail "focus stuck off pane 0 (index: $FOCUSED_RAW)"
# The sidebar row for the third session must exist before clicking it.
for _ in $(seq 1 12); do
  HAS_FCROW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => (document.querySelector('[data-sess="$SESS_FC"]') ? "yes" : "no"))()
EOF
)"
  echo "$HAS_FCROW" | grep -q "yes" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var row = document.querySelector('[data-sess="$SESS_FC"]'); if (!row) return "no-row"; row.click(); return "switched"; })()
EOF
GOT_FOCUS=""
for _ in $(seq 1 12); do
  sleep 2
  GOT_FOCUS="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify([...document.querySelectorAll('#paneGrid .pane')].map((p) => (p.querySelector('.pane-select') || {}).value || "")))()
EOF
)"
  echo "$GOT_FOCUS" | grep -q "$SESS_FC" && break
done
GOT_FOCUS_UQ="$(echo "$GOT_FOCUS" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$GOT_FOCUS_UQ" | grep -q "\"$SESS_FC\",\"$SESS_FB\"" \
  && pass "switch replaced the focused pane, newest untouched" || fail "switch hit the wrong pane: $GOT_FOCUS_UQ"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_FB" >/dev/null 2>&1 || true
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_FC" >/dev/null 2>&1 || true
SESS_FB=""; SESS_FC=""

echo "== browser: alternating web taps move focus every time (no stuck pane)"
# Regression: taps inside a web iframe never bubble pointerdown outward, and
# iframe-to-iframe moves fire neither window blur nor iframe focus events —
# only document.activeElement moves. The first tap (outer -> iframe) worked
# via the blur handler; every alternating tap after it stayed stuck. Real
# mouse clicks must move .focused on every alternation, not just the first.
SESS_TW="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-alt-second\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
openMgr "document.querySelector('[data-sess] .lbl')" "manager page booted with rows" || true
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
  sleep 2
done
for _ in $(seq 1 12); do
  HAS_TW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? ([...s.options].some((o) => o.value === "$SESS") && [...s.options].some((o) => o.value === "$SESS_TW")).toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_TW" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select');
  sel.value = "$SESS";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-web";
})()
EOF
sleep 8
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 3
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var panes = document.querySelectorAll('#paneGrid .pane');
  var s1 = panes[1] && panes[1].querySelector('.pane-select');
  if (!s1) return "need-2-panes";
  s1.value = "$SESS_TW";
  s1.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-tw";
})()
EOF
sleep 2
for _ in $(seq 1 15); do
  FRAMES_READY="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({ live: [...document.querySelectorAll('#paneGrid .pane')].map((p) => { var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); return !!(f && f.getAttribute('src')); }) }))()
EOF
)"
  echo "$FRAMES_READY" | grep -q '"live":\[true,true\]' && break
  sleep 2
done
echo "$FRAMES_READY" | grep -q '"live":\[true,true\]' \
  && pass "both web views committed before tapping" || fail "web views never committed: $FRAMES_READY"
# Tag the visible web views so real mouse clicks can target them directly
# (clicking the iframe element lands inside its content, like a user tap).
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => {
  var ps = document.querySelectorAll('#paneGrid .pane');
  ps.forEach((p, i) => {
    var f = [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden'));
    if (f) f.dataset.tap = "tap" + i;
  });
  return "tagged";
})()
EOF
TAP_OK=1
for EXPECT in 0 1 0 1; do
  HIT=0
  for _ in $(seq 1 3); do
    agent-browser click "[data-tap=\"tap$EXPECT\"]" >/dev/null 2>&1 || true
    sleep 2
    GOT="$(agent-browser eval "[...document.querySelectorAll('#paneGrid .pane')].findIndex((p) => p.classList.contains('focused')).toString()" 2>/dev/null | tail -1)"
    echo "$GOT" | grep -q "\"$EXPECT\"" && { HIT=1; break; }
  done
  [ "$HIT" = "1" ] || TAP_OK=0
done
[ "$TAP_OK" = "1" ] \
  && pass "alternating taps move focus every time" || fail "focus stuck during alternation"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_TW" >/dev/null 2>&1 || true
SESS_TW=""

echo "== browser: left-panel selection tracks the active window"
# The user's invariant: sidebar `.active` == focused pane's session.
# Web pane 0 ($SESS) + droid pane 1; focusing the web iframe must move the
# sidebar highlight, and clicking a row for the session live in the OTHER
# pane must focus it instead of duplicating the view.
SESS_GB="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-sel-b\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
openMgr "document.querySelector('[data-sess] .lbl')" "manager page booted with rows" || true
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
  sleep 2
done
for _ in $(seq 1 12); do
  HAS_GB="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS_GB").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_GB" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var panes = document.querySelectorAll('#paneGrid .pane');
  var s0 = panes[0] && panes[0].querySelector('.pane-select');
  if (!s0) return "no-pane";
  s0.value = "$SESS";
  s0.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-web";
})()
EOF
sleep 8
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 3
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var panes = document.querySelectorAll('#paneGrid .pane');
  var s1 = panes[1] && panes[1].querySelector('.pane-select');
  if (!s1) return "need-2-panes";
  s1.value = "$SESS_GB";
  s1.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-b";
})()
EOF
sleep 6
# Focus pane 0 through its web iframe (== clicking web content).
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var f = p && [...p.querySelectorAll('.pane-frame')].find((x) => !x.classList.contains('hidden')); if (f) f.focus(); return "focused-iframe"; })()
EOF
sleep 2
SEL_WEB_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var r = document.querySelector('#wsList .sess.active'); return r ? r.dataset.sess : null; })()
EOF
)"
SEL_WEB="$(echo "$SEL_WEB_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$SEL_WEB" = "$SESS" ] \
  && pass "sidebar selects the iframe-focused window" || fail "sidebar stuck off web pane (got: $SEL_WEB_RAW)"
# Click the row for the session live in pane 1: must focus pane 1, keep both
# panes (no duplication of the view into pane 0).
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var row = document.querySelector('[data-sess="$SESS_GB"]'); if (!row) return "no-row"; row.click(); return "clicked"; })()
EOF
sleep 3
SEL_DUP_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  active: (() => { var r = document.querySelector('#wsList .sess.active'); return r ? r.dataset.sess : null; })(),
  panes: [...document.querySelectorAll('#paneGrid .pane')].map((p) => (p.querySelector('.pane-select') || {}).value || "")
}))()
EOF
)"
SEL_DUP="$(echo "$SEL_DUP_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$SEL_DUP" | grep -q "\"active\":\"$SESS_GB\"" \
  && pass "sidebar selects the other pane's session on click" || fail "sidebar did not follow (got: $SEL_DUP_RAW)"
echo "$SEL_DUP" | grep -q "\"$SESS\",\"$SESS_GB\"" \
  && pass "click focused the live pane instead of duplicating" || fail "view duplicated or lost: $SEL_DUP_RAW"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_GB" >/dev/null 2>&1 || true

echo "== browser: split-assign syncs the new pane dropdown immediately"
# Regression: setPaneSession must repaint pane headers on completion. The
# new pane's dropdown kept showing "No session" until the next 8s background
# poll rebuilt it. Freeze polling first so a poll can't mask the lag.
SESS_HA=""; SESS_HB=""
SESS_HA="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-dd-a\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
SESS_HB="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-dd-b\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
openMgr "document.querySelector('[data-sess] .lbl')" "manager page booted with rows" || true
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
  sleep 2
done
# Both sessions must appear as dropdown options before freezing the polls.
for _ in $(seq 1 12); do
  HAS_HAB="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? ([...s.options].some((o) => o.value === "$SESS_HA") && [...s.options].some((o) => o.value === "$SESS_HB")).toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_HAB" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { for (var i = 1; i < 200; i++) { try { clearInterval(i); } catch (e) {} } return "frozen"; })()
EOF
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var panes = document.querySelectorAll('#paneGrid .pane');
  var s0 = panes[0] && panes[0].querySelector('.pane-select');
  if (!s0) return "no-pane";
  s0.value = "$SESS_HA";
  s0.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-a";
})()
EOF
sleep 3
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 2
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var panes = document.querySelectorAll('#paneGrid .pane');
  var s1 = panes[1] && panes[1].querySelector('.pane-select');
  if (!s1) return "need-2-panes";
  s1.value = "$SESS_HB";
  s1.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-b";
})()
EOF
sleep 2
DD_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify([...document.querySelectorAll('#paneGrid .pane')].map((p) => (p.querySelector('.pane-select') || {}).value || "")))()
EOF
)"
DD="$(echo "$DD_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$DD" | grep -q "\"$SESS_HA\",\"$SESS_HB\"" \
  && pass "split-assign syncs both dropdowns without a poll" || fail "dropdown lagged without poll: $DD_RAW"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_HA" >/dev/null 2>&1 || true
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_HB" >/dev/null 2>&1 || true
SESS_HA=""; SESS_HB=""
# Reload restores the frozen background poll for any later sections.
openMgr "document.querySelector('#paneGrid .pane')" "manager page booted for rapid switching" || true

echo "== browser: rapid PTY switching keeps the live stream"
# Alternate two terminal sessions with overlapping activations: the sidebar
# highlight, pane dropdown, terminal view, and loader must all agree on the
# last switch, and its EventSource must be open (single stream per switch).
SESS_PA=""; SESS_PB=""
SESS_PA="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-rapid-a\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
SESS_PB="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-rapid-b\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
sleep 4
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
  sleep 2
done
for _ in $(seq 1 12); do
  HAS_PAROW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => ((document.querySelector('[data-sess="$SESS_PA"]') && document.querySelector('[data-sess="$SESS_PB"]')) ? "yes" : "no"))()
EOF
)"
  echo "$HAS_PAROW" | grep -q "yes" && break
  sleep 2
done
for SID in "$SESS_PA" "$SESS_PB" "$SESS_PA" "$SESS_PB"; do
  agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var row = document.querySelector('[data-sess="$SID"]'); if (!row) return "no-row"; row.click(); return "switched"; })()
EOF
  sleep 1
done
RAPID=""
for _ in $(seq 1 10); do
  sleep 2
  RAPID="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  active: (() => { var r = document.querySelector('#wsList .sess.active'); return r ? r.dataset.sess : null; })(),
  select: (() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; return p ? ((p.querySelector('.pane-select') || {}).value || "") : ""; })(),
  termVisible: (() => { var t = document.querySelectorAll('#paneGrid .pane .pane-term')[0]; return t ? !t.classList.contains('hidden') : false; })(),
  loaderOk: (() => { var l = document.getElementById('stageLoader'); return !l || l.classList.contains('hidden'); })(),
  streamOpen: (() => { try { return state.panes[0].es && state.panes[0].es.readyState === 1; } catch (e) { return false; } })()
}))()
EOF
)"
  echo "$RAPID" | grep -q "$SESS_PB" || continue
  echo "$RAPID" | grep -q '"streamOpen":true' && break
done
RAPID_UQ="$(echo "$RAPID" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$RAPID_UQ" | grep -q "\"active\":\"$SESS_PB\"" \
  && pass "rapid switches land on the last session" || fail "sidebar lost the last switch: $RAPID"
echo "$RAPID_UQ" | grep -q "\"select\":\"$SESS_PB\"" \
  && pass "pane dropdown follows rapid switches" || fail "dropdown lost the last switch: $RAPID"
echo "$RAPID_UQ" | grep -q '"termVisible":true' \
  && pass "terminal view stays up after rapid switches" || fail "terminal hidden: $RAPID"
echo "$RAPID_UQ" | grep -q '"loaderOk":true' \
  && pass "no stuck loader after rapid switches" || fail "loader stuck: $RAPID"
echo "$RAPID_UQ" | grep -q '"streamOpen":true' \
  && pass "last switch holds the live stream" || fail "stream not open: $RAPID"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_PA" >/dev/null 2>&1 || true
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_PB" >/dev/null 2>&1 || true
SESS_PA=""; SESS_PB=""

echo "== api: agy session boots a live PTY (no prompt sent)"
# Real agy binary through the manager stack: create (fast PTY spawn, no web
# boot), assert pty mode + running status, then read the terminal stream and
# expect the agy banner (fresh scratch dir stops at the trust prompt — that
# prompt itself proves the binary booted; deliberately NOT accepted, so no
# global trust entry is written and no billed turn runs).
SESS_AGY=""
SESS_AGY="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"agy\",\"title\":\"e2e-agy\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
AGY_STATE="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
s=next((x for x in ss if x['id']=='$SESS_AGY'),{})
print(s.get('harness','?'), s.get('mode','?'), s.get('status','?'))")"
echo "$AGY_STATE" | grep -q "^agy pty running" \
  && pass "agy session running in pty mode ($AGY_STATE)" || fail "agy state wrong: $AGY_STATE"
sleep 12
AGY_STREAM="$(curl -s -m 15 "$MGR/api/pty/session/$SESS_AGY/stream" | head -c 60000 || true)"
echo "$AGY_STREAM" | grep -qa -i "antigravity" \
  && pass "agy PTY streams its banner" || fail "agy banner missing from stream"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_AGY" >/dev/null 2>&1 || true
SESS_AGY=""

echo "== browser: attention shelf card owns a dismiss × (hide without delete)"
# A quiet PTY session reads as waiting (no output past the 8s window), so an
# idle droid session lands on the Needs Attention shelf with no billed turn.
# Its × must hide the card while keeping the session; opening the session
# must re-arm (card returns while still waiting).
SESS_DIS=""
SESS_DIS="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-dismiss\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
DIS_WAIT=""
for _ in $(seq 1 30); do
  sleep 2
  DIS_WAIT="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s.get('activity','?') for s in ss if s['id']=='$SESS_DIS'),'MISSING'))")"
  [ "$DIS_WAIT" = "waiting" ] && break
done
[ "$DIS_WAIT" = "waiting" ] \
  && pass "idle droid session reads as waiting" || fail "droid never went waiting (got: $DIS_WAIT)"
openMgr "document.querySelector('[data-sess=\"$SESS_DIS\"]')" "sidebar row present for dismiss" || true
DIS_CARD_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_DIS"]'),
  btn: (() => { var b = document.querySelector('#attentionShelf [data-sess="$SESS_DIS"] .shelf-dismiss'); return b ? b.textContent.trim() : 'absent'; })(),
  title: (() => { var b = document.querySelector('#attentionShelf [data-sess="$SESS_DIS"] .shelf-dismiss'); return b ? (b.getAttribute('title') || '') : 'absent'; })(),
  badgeBefore: ((document.getElementById('filterWaitCount') || {}).textContent || 'absent')
}))()
EOF
)"
DIS_CARD="$(echo "$DIS_CARD_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$DIS_CARD" | grep -q '"card":true' \
  && pass "waiting session shows on the attention shelf" || fail "no shelf card: $DIS_CARD"
echo "$DIS_CARD" | grep -q '"btn":"×"' \
  && pass "shelf card owns a dismiss ×" || fail "dismiss button missing: $DIS_CARD"
echo "$DIS_CARD" | grep -qi 'dismiss' \
  && pass "dismiss button titled" || fail "dismiss title wrong: $DIS_CARD"
# Click ×: the card must go, the sidebar row must stay (no delete).
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var b = document.querySelector('#attentionShelf [data-sess="$SESS_DIS"] .shelf-dismiss'); if (!b) return "no-btn"; b.click(); return "dismissed"; })()
EOF
sleep 2
DIS_GONE_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_DIS"]'),
  row: !!document.querySelector('#wsList [data-sess="$SESS_DIS"]'),
  badgeHidden: (() => { var b = document.getElementById('filterWaitCount'); return b ? b.classList.contains('hidden') : 'absent'; })(),
  stored: (localStorage.getItem('ai-manager.dismissedAttention') || '').includes("$SESS_DIS")
}))()
EOF
)"
DIS_GONE="$(echo "$DIS_GONE_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$DIS_GONE" | grep -q '"card":false' \
  && pass "dismiss × hides the shelf card" || fail "card lingers after dismiss: $DIS_GONE"
echo "$DIS_GONE" | grep -q '"row":true' \
  && pass "dismiss keeps the session (sidebar row stays)" || fail "dismiss deleted the session: $DIS_GONE"
DIS_ALIVE="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print('alive' if '$SESS_DIS' in [s['id'] for s in ss] else 'gone')")"
[ "$DIS_ALIVE" = "alive" ] \
  && pass "dismissed session alive server-side" || fail "session gone server-side: $DIS_ALIVE"
echo "$DIS_GONE" | grep -q '"stored":true' \
  && pass "dismiss persists to localStorage" || fail "dismiss not persisted: $DIS_GONE"
# Opening the session re-arms: the still-waiting card returns. The attach
# itself redraws the terminal (resize → fresh PTY output reads as working),
# so poll until the session goes quiet again instead of single-shot.
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var row = document.querySelector('#wsList [data-sess="$SESS_DIS"]'); if (!row) return "no-row"; row.click(); return "opened"; })()
EOF
DIS_BACK=""; DIS_BACK_RAW=""
for _ in $(seq 1 15); do
  sleep 2
  DIS_BACK_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_DIS"]'),
  stored: (localStorage.getItem('ai-manager.dismissedAttention') || '').includes("$SESS_DIS")
}))()
EOF
)"
  DIS_BACK="$(echo "$DIS_BACK_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  echo "$DIS_BACK" | grep -q '"card":true' && break
done
echo "$DIS_BACK" | grep -q '"card":true' \
  && pass "opening re-arms the attention card" || fail "card did not return on open: $DIS_BACK"
echo "$DIS_BACK" | grep -q '"stored":false' \
  && pass "open clears the persisted dismiss" || fail "dismiss still stored after open: $DIS_BACK"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_DIS" >/dev/null 2>&1 || true
SESS_DIS=""

echo "== browser: Needs Attention shelf collapses + expands (persisted)"
# The shelf header is a toggle: collapse keeps the header + count but hides
# the cards; the flag persists across reload; expand restores the cards.
SESS_COL=""
SESS_COL="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-collapse\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
COL_WAIT=""
for _ in $(seq 1 30); do
  sleep 2
  COL_WAIT="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s.get('activity','?') for s in ss if s['id']=='$SESS_COL'),'MISSING'))")"
  [ "$COL_WAIT" = "waiting" ] && break
done
[ "$COL_WAIT" = "waiting" ] \
  && pass "collapse fixture reads as waiting" || fail "collapse fixture never waiting (got: $COL_WAIT)"
agent-browser open "$MGR/" >/dev/null 2>&1 || true
sleep 4
COL_OPEN_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var t = document.querySelector('#attentionShelf .shelf-toggle'); return JSON.stringify({
  toggle: !!t,
  expanded: t ? t.getAttribute('aria-expanded') : 'absent',
  header: t ? t.textContent : 'absent',
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_COL"]')
}); })()
EOF
)"
COL_OPEN="$(echo "$COL_OPEN_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$COL_OPEN" | grep -q '"toggle":true' \
  && pass "shelf header is a collapse toggle" || fail "no shelf toggle: $COL_OPEN"
echo "$COL_OPEN" | grep -q '"expanded":"true"' \
  && pass "shelf starts expanded" || fail "shelf not expanded on fresh state: $COL_OPEN"
echo "$COL_OPEN" | grep -q '"card":true' \
  && pass "waiting session shows before collapse" || fail "no card before collapse: $COL_OPEN"
# Collapse: the card must go, the header (with count) must stay.
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var t = document.querySelector('#attentionShelf .shelf-toggle'); if (!t) return "no-toggle"; t.click(); return "collapsed"; })()
EOF
sleep 2
COL_SHUT_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var t = document.querySelector('#attentionShelf .shelf-toggle'); return JSON.stringify({
  collapsed: document.getElementById('attentionShelf').classList.contains('collapsed'),
  expanded: t ? t.getAttribute('aria-expanded') : 'absent',
  header: t ? t.textContent : 'absent',
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_COL"]'),
  stored: localStorage.getItem('ai-manager.attentionCollapsed') || 'absent'
}); })()
EOF
)"
COL_SHUT="$(echo "$COL_SHUT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$COL_SHUT" | grep -q '"card":false' \
  && pass "collapse hides the shelf card" || fail "card lingers after collapse: $COL_SHUT"
echo "$COL_SHUT" | grep -q '"collapsed":true' \
  && pass "shelf carries the collapsed state" || fail "no collapsed state: $COL_SHUT"
echo "$COL_SHUT" | grep -q 'Needs Attention' \
  && pass "collapsed header keeps the count" || fail "header lost after collapse: $COL_SHUT"
echo "$COL_SHUT" | grep -q '"stored":"1"' \
  && pass "collapse persists to localStorage" || fail "collapse not persisted: $COL_SHUT"
# Reload: the shelf must stay collapsed.
agent-browser open "$MGR/" >/dev/null 2>&1 || true
sleep 4
COL_RELOAD_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_COL"]'),
  collapsed: document.getElementById('attentionShelf').classList.contains('collapsed')
}))()
EOF
)"
COL_RELOAD="$(echo "$COL_RELOAD_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$COL_RELOAD" | grep -q '"card":false' \
  && pass "collapse survives reload" || fail "collapse lost on reload: $COL_RELOAD"
# Expand: the card must return (leaves default state for later sections).
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => { var t = document.querySelector('#attentionShelf .shelf-toggle'); if (!t) return "no-toggle"; t.click(); return "expanded"; })()
EOF
sleep 2
COL_BACK_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  card: !!document.querySelector('#attentionShelf [data-sess="$SESS_COL"]'),
  expanded: (document.querySelector('#attentionShelf .shelf-toggle') || {}).getAttribute
    ? document.querySelector('#attentionShelf .shelf-toggle').getAttribute('aria-expanded') : 'absent'
}))()
EOF
)"
COL_BACK="$(echo "$COL_BACK_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$COL_BACK" | grep -q '"card":true' \
  && pass "expand restores the shelf card" || fail "card did not return on expand: $COL_BACK"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_COL" >/dev/null 2>&1 || true
SESS_COL=""

echo "== browser: narrate toggle speaks session activity (persisted)"
# Narrate toggle: flips aria-pressed + .on, persists, survives reload.
# Headless speech uses the system engine (forced below — the Kokoro default
# would pull ~90MB); all clicks here are synthetic (no trusted gesture).
openMgr "document.getElementById('btnNarrate')" "manager page booted for narrate" || true
NARR_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  btn: !!document.getElementById('btnNarrate'),
  inTopRight: !!document.querySelector('.top-right #btnNarrate'),
  pressed: (() => { var b = document.getElementById('btnNarrate'); return b ? b.getAttribute('aria-pressed') : 'absent'; })(),
  fns: (typeof setNarrate === 'function') && (typeof isNarrateOn === 'function') && (typeof narrateTransitions === 'function') && (typeof maybeNarratePty === 'function'),
  engine: (typeof cleanForSpeech === 'function')
}))()
EOF
)"
NARR="$(echo "$NARR_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR" | grep -q '"btn":true' \
  && pass "narrate toggle present" || fail "no #btnNarrate: $NARR"
echo "$NARR" | grep -q '"inTopRight":true' \
  && pass "narrate toggle sits top-right" || fail "toggle not top-right: $NARR"
echo "$NARR" | grep -q '"pressed":"false"' \
  && pass "narrate defaults to off" || fail "narrate default wrong: $NARR"
echo "$NARR" | grep -q '"fns":true' \
  && pass "narrator engine wired" || fail "narrator fns missing: $NARR"
# Default engine is the Kokoro neural voice, lazily loaded: boot must fetch
# nothing (no ~90MB until the first utterance).
NARR_ENG_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  d: window.__narrateDiag(),
  cdn: performance.getEntriesByType('resource').filter((r) => /jsdelivr|huggingface|kokoro/i.test(r.name)).length
}))()
EOF
)"
NARR_ENG="$(echo "$NARR_ENG_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR_ENG" | grep -q '"engine":"kokoro"' \
  && pass "neural voice is the default engine" || fail "engine default wrong: $NARR_ENG"
echo "$NARR_ENG" | grep -q '"kokoro":"idle"' \
  && pass "model lazy (idle at boot)" || fail "model not idle: $NARR_ENG"
echo "$NARR_ENG" | grep -q '"cdn":0' \
  && pass "no voice download before first use" || fail "eager download: $NARR_ENG"
# Sentence splitter: two clean sentences out, prompts/spinners/tool rows dropped.
NARR_SPLIT_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  split: splitIntoSentences('First the auth wall was checked and it passed. Then the build failed on a missing env var! Short. $ kubectl get pods'),
  splitTail: splitIntoSentences('The trading session finished the migration and all three replicas are healthy now'),
  noisePrompt: isNoiseLine('$ kubectl get pods'),
  noiseShort: isNoiseLine('ok'),
  noiseClean: isNoiseLine('The deployment finished and all pods are running now.')
}))()
EOF
)"
NARR_SPLIT="$(echo "$NARR_SPLIT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR_SPLIT" | grep -q 'First the auth wall was checked and it passed' \
  && pass "splitter keeps sentence one" || fail "splitter dropped s1: $NARR_SPLIT"
echo "$NARR_SPLIT" | grep -q 'Then the build failed on a missing env var' \
  && pass "splitter keeps sentence two" || fail "splitter dropped s2: $NARR_SPLIT"
echo "$NARR_SPLIT" | grep -q 'all three replicas are healthy now' \
  && pass "splitter keeps unpunctuated tail whole" || fail "splitter amputated tail: $NARR_SPLIT"
echo "$NARR_SPLIT" | grep -q '"noisePrompt":true' \
  && pass "splitter drops shell prompts" || fail "prompt leaked: $NARR_SPLIT"
echo "$NARR_SPLIT" | grep -q '"noiseClean":false' \
  && pass "splitter keeps clean speech" || fail "clean flagged noise: $NARR_SPLIT"
# Force the system engine for the headless speech path (deterministic,
# no model download); the neural default is covered by static tests above.
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => window.__narrateSetEngine('system'))()
EOF
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnNarrate'); if (b) b.click(); return "on"; })()
EOF
sleep 2
NARR_ON_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  pressed: document.getElementById('btnNarrate').getAttribute('aria-pressed'),
  cls: document.getElementById('btnNarrate').classList.contains('on'),
  stored: localStorage.getItem('ai-manager.narrate')
}))()
EOF
)"
NARR_ON="$(echo "$NARR_ON_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR_ON" | grep -q '"pressed":"true"' \
  && pass "toggle switches narrate on" || fail "toggle did not switch on: $NARR_ON"
echo "$NARR_ON" | grep -q '"stored":"1"' \
  && pass "narrate pick persists to localStorage" || fail "not persisted: $NARR_ON"
# Headless clicks are synthetic (no trusted gesture), so Chrome gates speech
# with not-allowed: the narrator must record it on the toggle (amber err +
# retry queued) instead of failing silently. A later real click replays.
# The utterance error is async — poll until it lands.
NARR_DIAG="EVAL-ERR"
for _ in $(seq 1 8); do
  NARR_DIAG_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  diag: (typeof window.__narrateDiag === 'function'),
  d: ((typeof window.__narrateDiag === 'function') ? window.__narrateDiag() : {}),
  cls: document.getElementById('btnNarrate').className
}))()
EOF
)"
  NARR_DIAG="$(echo "$NARR_DIAG_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  echo "$NARR_DIAG" | grep -q '"lastError":"not-allowed"' && break
  sleep 2
done
echo "$NARR_DIAG" | grep -q '"diag":true' \
  && pass "narrate diagnostics readable" || fail "no __narrateDiag: $NARR_DIAG"
echo "$NARR_DIAG" | grep -q '"lastError":"not-allowed"' \
  && pass "autoplay block recorded (not-allowed)" || fail "block not recorded: $NARR_DIAG"
echo "$NARR_DIAG" | grep -q '"retryQueued":true' \
  && pass "blocked speech queued for next gesture" || fail "no retry queued: $NARR_DIAG"
echo "$NARR_DIAG" | grep -q 'narrate-btn on err' \
  && pass "toggle shows blocked-error state" || fail "no err state: $NARR_DIAG"
# Live content narration: feed the focused session, background ignored, the
# buffer flushes after a pause and the queue drains utterance by utterance
# (headless errors still advance the chain — lastContent proves the path).
for _ in $(seq 1 12); do
  HAS_NOPT="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_NOPT" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select');
  sel.value = "$SESS";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned";
})()
EOF
# Let the switch settle (observer attached, loader cleared) BEFORE feeding:
# feeding mid-switch gets wiped when the iframe commit re-targets observation.
NARR_SETTLED=""
for _ in $(seq 1 15); do
  sleep 2
  NARR_SETTLED_RAW="$(agent-browser eval "JSON.stringify(window.__narrateDiag().webObservedId)" 2>/dev/null | tail -1)"
  NARR_SETTLED="$(echo "$NARR_SETTLED_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  [ "$NARR_SETTLED" = "$SESS" ] && break
done
[ "$NARR_SETTLED" = "$SESS" ] \
  && pass "transcript observer attached before feed" || fail "observer never attached: $NARR_SETTLED"
agent-browser eval --stdin >/dev/null 2>&1 <<EOF || true
(() => {
  narrateFeed('sess_e2e_background', 'This background session text must be ignored completely by the narrator feed path.');
  narrateFeed("$SESS", 'The session finished the database migration in twelve seconds. All three replicas are healthy now.');
  return "fed";
})()
EOF
NARR_BUF_RAW="$(agent-browser eval "JSON.stringify(narrate.pendingText)" 2>/dev/null | tail -1)"
NARR_BUF="$(echo "$NARR_BUF_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR_BUF" | grep -qv 'ignored completely' \
  && pass "background session text never enters the buffer" || fail "background leaked: $NARR_BUF"
echo "$NARR_BUF" | grep -q 'database migration in twelve seconds' \
  && pass "focused session feedback buffered" || fail "focused feed missing: $NARR_BUF"
NARR_CONTENT="EVAL-ERR"
for _ in $(seq 1 14); do
  sleep 2
  NARR_CONTENT_RAW="$(agent-browser eval "JSON.stringify({d: window.__narrateDiag()})" 2>/dev/null | tail -1)"
  NARR_CONTENT="$(echo "$NARR_CONTENT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  # Live transcript also feeds the queue, so any spoken sentence proves the
  # pump — synthetic or live text, the chain is the same.
  echo "$NARR_CONTENT" | grep -q '"lastContent":"[^"]' && break
done
echo "$NARR_CONTENT" | grep -q '"lastContent":"[^"]' \
  && pass "session feedback spoken utterance by utterance" || fail "content never queued/spoken: $NARR_CONTENT"
NARR_Q="$(echo "$NARR_CONTENT" | python3 -c "import json,sys; print(json.loads(sys.argv[1])['d']['queue'])" "$NARR_CONTENT" 2>/dev/null || echo 99)"
python3 -c "import sys; sys.exit(0 if 0 <= int(sys.argv[1]) <= 5 else 1)" "$NARR_Q" \
  && pass "sentence queue capped live (depth $NARR_Q)" || fail "queue uncapped: $NARR_CONTENT"
openMgr "document.getElementById('btnNarrate')" "manager page booted for narrate reload check" keep || true
NARR_KEPT_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  pressed: document.getElementById('btnNarrate').getAttribute('aria-pressed'),
  stored: localStorage.getItem('ai-manager.narrate')
}))()
EOF
)"
NARR_KEPT="$(echo "$NARR_KEPT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR_KEPT" | grep -q '"pressed":"true"' \
  && pass "narrate pick survives reload" || fail "pick lost on reload: $NARR_KEPT"
# Reload restores ON silently with a fresh speech context: the pre-reload
# block must not leak across (clean toggle, no stale retry).
NARR_CLEAN_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
  d: window.__narrateDiag(),
  cls: document.getElementById('btnNarrate').className
}))()
EOF
)"
NARR_CLEAN="$(echo "$NARR_CLEAN_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$NARR_CLEAN" | grep -q '"lastError":null' \
  && pass "reload clears the stale block" || fail "stale block leaked: $NARR_CLEAN"
echo "$NARR_CLEAN" | grep -q '"cls":"narrate-btn on"' \
  && pass "toggle clean after reload" || fail "toggle still err: $NARR_CLEAN"
# Post-reload the restored pane shows $SESS (web) again: once its transcript
# document loads, the observer must re-target it for live narration.
NARR_WEB="EVAL-ERR"
for _ in $(seq 1 15); do
  sleep 2
  NARR_WEB_RAW="$(agent-browser eval "JSON.stringify(window.__narrateDiag().webObservedId)" 2>/dev/null | tail -1)"
  NARR_WEB="$(echo "$NARR_WEB_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  echo "$NARR_WEB" | grep -q "$SESS" && break
done
echo "$NARR_WEB" | grep -q "$SESS" \
  && pass "transcript observer follows the focused web session" || fail "no transcript observer: $NARR_WEB"
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF' || true
(() => { var b = document.getElementById('btnNarrate'); if (b) b.click(); return "off"; })()
EOF
sleep 1

echo "== $FAILS failure(s)"
exit "$([ "$FAILS" -eq 0 ] && echo 0 || echo 1)"
