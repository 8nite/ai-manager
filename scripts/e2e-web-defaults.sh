#!/usr/bin/env bash
# e2e-web-defaults.sh — end-to-end test for opencode PTY sessions.
#
# Spins an ISOLATED scratch manager (own port/store/harness ports — never the
# live :4000), creates real opencode sessions (TUI in a PTY, like droid/agy),
# then asserts through a real headless browser (agent-browser):
#   1. opencode sessions boot in pty mode with a live terminal stream;
#   2. sidebar switching + split-screen hold live PTY streams per pane;
#   3. rename/attention/narrate behavior matches the other PTY harnesses.
#
# Deliberately does NOT send a prompt: that would run a billed agent turn.
# Chat-id backfill is covered by stub-level tests
# (tests/sessions.test.js "backfill adopts ...").
#
# Usage: bash scripts/e2e-web-defaults.sh
#   Env overrides: MGR_PORT (default 4001), HARNESS_BASE (default 4300).
# Requires: node, curl, python3, agent-browser on PATH.

set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
MGR_PORT="${MGR_PORT:-4001}"
HARNESS_BASE="${HARNESS_BASE:-4300}"
MGR="http://127.0.0.1:${MGR_PORT}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "FAIL: missing required command: $1"; exit 2; }; }
need node; need curl; need python3; need agent-browser

port_free() { ! (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_free "$MGR_PORT" || { echo "FAIL: port $MGR_PORT in use (set MGR_PORT=)"; exit 2; }
port_free "$HARNESS_BASE" || { echo "FAIL: port $HARNESS_BASE in use (set HARNESS_BASE=)"; exit 2; }

TMP="$(mktemp -d /tmp/aimgr-e2e.XXXXXX)"
WS="$TMP/ws"; mkdir -p "$WS" "$TMP/data"
# Isolated Chrome profile: the shared default profile may be driven
# concurrently (parallel dev browser use steals tabs/focus/localStorage and
# flakes unrelated sections). A per-run profile keeps e2e hermetic and is
# removed with $TMP by the EXIT trap.
export AGENT_BROWSER_PROFILE="$TMP/browser-profile"
MGR_PID=""; SESS=""; FAILS=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

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
  if [ -n "${SESS_NR:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_NR" >/dev/null 2>&1 || true
  fi
  if [ -n "${SESS_PTY:-}" ]; then
    curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_PTY" >/dev/null 2>&1 || true
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
echo "== create opencode session (fast PTY spawn)"
CREATED="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-web-defaults\"}")"
SESS="$(echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
STATUS="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next(s['status'] for s in ss if s['id']=='$SESS'))")"
[ "$STATUS" = "running" ] || { fail "session status=$STATUS (want running)"; tail -5 "$TMP/manager.log"; exit 1; }
pass "session running ($SESS)"

echo "== api: session rename validates + persists"
BAD_RENAME="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X PATCH "$MGR/api/sessions/$SESS" -H 'Content-Type: application/json' -d '{"title":"   "}')"
[ "$BAD_RENAME" = "400" ] \
  && pass "empty rename rejected (400)" || fail "empty rename → HTTP $BAD_RENAME (want 400)"

echo "== browser: left-panel rename survives activation (dblclick race)"
# Fresh manager page: the session is inactive, so double-clicking its row
# fires two activates (async ensure/touch + terminal focus) plus
# startRename. The rename input must survive past the activation round-trip
# instead of being destroyed into a silent blur-cancel (regression: the
# rename box flashed and died, name unchanged).
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => { var lbl = document.querySelector('[data-sess="$SESS"] .lbl'); if (!lbl) return "no-row"; var c = new MouseEvent("click", { bubbles: true, cancelable: true }); lbl.dispatchEvent(c); lbl.dispatchEvent(c); lbl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "dispatched"; })()
EOF
sleep 5
RENAME_RAW="$(agent-browser eval "JSON.stringify(document.querySelector('.sess-rename-input') ? true : false)" 2>/dev/null | tail -1)"
RENAME_OPEN="$(echo "$RENAME_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$RENAME_OPEN" = "true" ] \
  && pass "rename input survives activation" || fail "rename input died mid-activation (raw: $RENAME_RAW)"
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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

echo "== api: manager restart respawns PTY sessions (chats resume by id)"
# PTY sessions die with the manager (their stdio is the pty itself) and are
# respawned on boot with `opencode --session <hid>`, so the conversation
# continues. Liveness here means: running status + a live terminal stream.
kill "$MGR_PID"
for _ in $(seq 1 15); do port_free "$MGR_PORT" && break; sleep 1; done
port_free "$MGR_PORT" || { fail "scratch manager did not stop"; exit 1; }
AI_MGR_PORT="$MGR_PORT" AI_MGR_DATA="$TMP/data/manager.json" \
  AI_MGR_HARNESS_BASE_PORT="$HARNESS_BASE" \
  nohup node src/server/index.js > "$TMP/manager2.log" 2>&1 &
MGR_PID=$!
for _ in $(seq 1 12); do
  curl -s -m 3 "$MGR/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -s -m 5 "$MGR/health" >/dev/null || { fail "rebooted manager never came up (see $TMP/manager2.log)"; exit 1; }
RBOOT=""
for _ in $(seq 1 10); do
  sleep 2
  RBOOT="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
s=next((x for x in ss if x['id']=='$SESS'),{})
print(s.get('status','MISSING'), s.get('mode','NOMODE'), s.get('title','NOTITLE'))")"
  echo "$RBOOT" | grep -q "^running pty e2e-renamed" && break
done
echo "$RBOOT" | grep -q "^running pty e2e-renamed" \
  && pass "rebooted session running in pty mode with title intact" || fail "respawn state wrong: $RBOOT"
RSTREAM="$(curl -s -m 15 "$MGR/api/pty/session/$SESS/stream" | head -c 20000 | tr -d '\0' || true)"
[ -n "$RSTREAM" ] \
  && pass "respawned PTY streams terminal output" || fail "respawned PTY stream empty"

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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
PAINT2="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var row = document.querySelector('[data-sess="$SESS2"]'); return row ? row.innerText : "no-row"; })()
EOF
)"
echo "$PAINT2" | grep -q "opencode" \
  && pass "sidebar paints default title" || fail "sidebar stale for no-prompt session: $PAINT2"

echo "== api: opencode sessions run as PTYs with no backend port"
# No serve processes, no shared backend: each opencode session is a TUI in a
# PTY (same shape as droid/agy). SESS + SESS2 already exist.
OP_MODES="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=[s for s in json.load(sys.stdin)['sessions'] if s.get('harness')=='opencode']
print(' '.join(sorted(set(s.get('mode','?') for s in ss))))")"
[ "$OP_MODES" = "pty" ] \
  && pass "all opencode sessions in pty mode ($OP_MODES)" || fail "opencode modes wrong: $OP_MODES"
OP_PORTS="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=[s for s in json.load(sys.stdin)['sessions'] if s.get('harness')=='opencode']
print(' '.join(sorted(set(str(s.get('port')) for s in ss))))")"
[ "$OP_PORTS" = "None" ] \
  && pass "no backend ports allocated" || fail "ports allocated: $OP_PORTS"
# A further create spawns a PTY (fast, no backend boot).
T0="$(date +%s)"
SESS_PTY="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-pty-third\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
T1="$(date +%s)"; PTY_DT=$((T1 - T0))
[ "$PTY_DT" -lt 25 ] \
  && pass "pty create fast (${PTY_DT}s, no backend boot)" || fail "pty create slow: ${PTY_DT}s"
PTY_STREAM="$(curl -s -m 15 "$MGR/api/pty/session/$SESS_PTY/stream" | head -c 20000 | tr -d '\0' || true)"
[ -n "$PTY_STREAM" ] \
  && pass "new PTY streams terminal output" || fail "new PTY stream empty"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_PTY" >/dev/null 2>&1 || true

echo "== browser+api: pty switch attaches the live stream (no reload)"
# Sidebar row switch between two opencode PTYs: the pane keeps one terminal
# view per session and the new switch holds the live EventSource. No iframes
# are created for the switch.
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
for _ in $(seq 1 12); do
  HAS_BOTH="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].filter((o) => o.value === "$SESS" || o.value === "$SESS2").length.toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_BOTH" | grep -q "2" && break
  sleep 2
done
NFRAMES0="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame').length" 2>/dev/null | tail -1)"
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => { var row = document.querySelector('#wsList [data-sess="$SESS2"]'); if (!row) return "no-row"; row.click(); return "detoured"; })()
EOF
SWITCHED=""
for _ in $(seq 1 10); do
  sleep 2
  SWITCHED="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  active: (() => { var r = document.querySelector('#wsList .sess.active'); return r ? r.dataset.sess : null; })(),
  select: (() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; return p ? ((p.querySelector('.pane-select') || {}).value || "") : ""; })(),
  termVisible: (() => { var t = document.querySelectorAll('#paneGrid .pane .pane-term')[0]; return t ? !t.classList.contains('hidden') : false; })(),
  loaderOk: (() => { var l = document.getElementById('stageLoader'); return !l || l.classList.contains('hidden'); })(),
  streamOpen: (() => { try { return state.panes[0].es && state.panes[0].es.readyState === 1; } catch (e) { return false; } })()
}))()
EOF
)"
  echo "$SWITCHED" | grep -q "$SESS2" || continue
  echo "$SWITCHED" | grep -q '"streamOpen":true' && break
done
SWITCHED_UQ="$(echo "$SWITCHED" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$SWITCHED_UQ" | grep -q "\"active\":\"$SESS2\"" \
  && pass "row switch lands on the second session" || fail "sidebar lost the switch: $SWITCHED"
echo "$SWITCHED_UQ" | grep -q "\"select\":\"$SESS2\"" \
  && pass "pane dropdown follows the row switch" || fail "dropdown lost the switch: $SWITCHED"
echo "$SWITCHED_UQ" | grep -q '"termVisible":true' \
  && pass "terminal view stays up across switches" || fail "terminal hidden: $SWITCHED"
echo "$SWITCHED_UQ" | grep -q '"loaderOk":true' \
  && pass "no stuck loader after switches" || fail "loader stuck: $SWITCHED"
echo "$SWITCHED_UQ" | grep -q '"streamOpen":true' \
  && pass "new switch holds the live stream" || fail "stream not open: $SWITCHED"
NFRAMES1="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane')[0].querySelectorAll('.pane-frame').length" 2>/dev/null | tail -1)"
[ "$NFRAMES1" = "$NFRAMES0" ] \
  && pass "pty switch creates no iframe ($NFRAMES0 frames)" || fail "iframe created on pty switch: $NFRAMES0 -> $NFRAMES1"
# Switch back to SESS via its row; same expectations.
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => { var row = document.querySelector('#wsList [data-sess="$SESS"]'); if (!row) return "no-row"; row.click(); return "back"; })()
EOF
SWBACK=""
for _ in $(seq 1 10); do
  sleep 2
  SWBACK="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => JSON.stringify({
  active: (() => { var r = document.querySelector('#wsList .sess.active'); return r ? r.dataset.sess : null; })(),
  streamOpen: (() => { try { return state.panes[0].es && state.panes[0].es.readyState === 1; } catch (e) { return false; } })()
}))()
EOF
)"
  echo "$SWBACK" | grep -q "$SESS" || continue
  echo "$SWBACK" | grep -q '"streamOpen":true' && break
done
SWBACK_UQ="$(echo "$SWBACK" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$SWBACK_UQ" | grep -q "\"active\":\"$SESS\"" \
  && pass "row switch back lands on the first session" || fail "switch-back lost: $SWBACK"
echo "$SWBACK_UQ" | grep -q '"streamOpen":true' \
  && pass "switch-back holds the live stream" || fail "stream not open after back: $SWBACK"
# Keyed sidebar: mark the SESS row, force a full refresh() (same as the 8s
# poll): the SAME DOM node must keep the mark — a wholesale innerHTML
# rebuild would destroy it. Scoped to #wsList: a waiting session also owns
# an attention-shelf card (earlier in DOM order) that the shelf rebuilds
# every poll, which would eat an unscoped mark.
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => { var r = document.querySelector('#wsList [data-sess="$SESS"]'); if (r) r.dataset.e2eKeep = "1"; return "marked"; })()
EOF
agent-browser eval "refresh()" >/dev/null 2>&1 || true
KEPT=""
for _ in $(seq 1 10); do
  sleep 2
  KEPT_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1 || true
(() => { try { return JSON.stringify({ rows: document.querySelectorAll('#wsList [data-sess]').length, marked: !!document.querySelector('#wsList [data-sess="$SESS"][data-e2e-keep="1"]'), sessions: (typeof state !== "undefined" ? state.sessions.length : -1) }); } catch (e) { return JSON.stringify({ err: "x" }); } })()
EOF
)"
  KEPT="$(echo "$KEPT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
  echo "$KEPT" | grep -q '"marked":true' && break
done
echo "$KEPT" | grep -q '"marked":true' \
  && pass "sidebar row node survives switch renders + refresh (keyed update)" || fail "row node lost: $KEPT"
# Deleting SESS2 must kill its PTY: the terminal stream 404s afterwards.
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS2" >/dev/null 2>&1 || true
sleep 2
GONE_STREAM="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$MGR/api/pty/session/$SESS2/stream")"
[ "$GONE_STREAM" = "404" ] \
  && pass "deleted session drops its PTY (stream 404)" || fail "stale PTY stream: HTTP $GONE_STREAM"

echo "== browser: sidebar minus removes the session with no confirm dialog"
# The hover minus deletes on a single click — no confirm() may appear (a
# native dialog would stall headless input and annoy). Uses a throwaway
# session so the main $SESS flow is untouched.
SESS3="$(curl -s -m 150 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"opencode\",\"title\":\"e2e-minus\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
CHROME_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({
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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
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
echo "$SWITCH" | grep -q '"sw":true' \
  && pass "harness switch present" || fail "no #harnessSwitch: $SWITCH"
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
QUICKID="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss = sorted(json.load(sys.stdin)['sessions'], key=lambda s: s.get('createdAt',0), reverse=True)
print(ss[0].get('id','') if ss else '')")"
[ -n "$QUICKID" ] && curl -s -m 10 -X DELETE "$MGR/api/sessions/$QUICKID" >/dev/null 2>&1 || true
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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
KEPT_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => JSON.stringify({ sel: ((document.querySelector('#harnessSwitch .hs-btn.sel') || {}).dataset || {}).harness || null, stored: localStorage.getItem('ai-manager.harness') }))()
EOF
)"
KEPT="$(echo "$KEPT_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
echo "$KEPT" | grep -q '"sel":"droid"' \
  && pass "switch pick survives reload" || fail "pick lost on reload: $KEPT"
# Reset to the default so later runs start clean.
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var b = document.querySelector('#harnessSwitch .hs-btn[data-harness="opencode"]'); if (b) b.click(); return "reset"; })()
EOF

echo "== browser: split-screen panes view multiple sessions at once"
# Toolbar + grid present; Split adds a second live pane; sidebar rows offer
# open-in-split; per-pane dropdowns can hold different sessions concurrently.
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
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
# Split vertically, then assign two different sessions side by side (both
# PTYs now — fast spawn, no backend boot). Assign the first pane explicitly:
# a fresh page boots with empty panes. The dropdown only offers sessions from
# the last /api/state poll, so wait for the option first (same race as the
# second-pane assign below).
for _ in $(seq 1 12); do
  HAS_WEB0="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_WEB0" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
  panes: document.querySelectorAll('#paneGrid .pane').length,
  pill: (document.getElementById('paneCount') || {}).textContent || null,
  firstSel: (() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; return (p.querySelector('.pane-select') || {}).value || ""; })(),
  firstHasTerm: (() => { var t = document.querySelectorAll('#paneGrid .pane .pane-term')[0]; return t ? !t.classList.contains('hidden') : false; })(),
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
echo "$SPLITSTATE" | grep -q "\"firstSel\":\"$SESS\"" \
  && pass "first pane keeps its opencode session" || fail "first pane lost session: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q '"firstHasTerm":true' \
  && pass "first pane runs a live terminal" || fail "first pane not live: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q '"secondHasTerm":true' \
  && pass "second pane runs a different session live" || fail "second pane not live: $SPLITSTATE"
echo "$SPLITSTATE" | grep -q '"bothVisible":true' \
  && pass "both sessions visible at the same time" || fail "panes not co-visible: $SPLITSTATE"
# Layout persists across reload (panes + direction in localStorage).
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 5
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
sleep 2
SPLITCLOSED="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
echo "$SPLITCLOSED" | grep -q "1" \
  && pass "close pane returns to single view" || fail "close pane failed: $SPLITCLOSED"
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_SPLIT" >/dev/null 2>&1 || true

echo "== browser: sidebar switch follows the focused pane, not the newest"
# Regression: pane focus used to stick on the newest split, so a sidebar
# switch landed there instead of the window the user clicked. Pressing
# pane 0 must move .focused there; the next sidebar switch must then replace
# pane 0's session while pane 1 keeps its own.
SESS_FB=""; SESS_FC=""
SESS_FB="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-focus-b\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
SESS_FC="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-focus-c\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
# Normalize to a single pane (prior sections may leave one or two).
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var b = document.getElementById('btnClosePane'); if (b) b.click(); return "closed"; })()
EOF
  sleep 2
done
# Pane 0 shows the opencode session (a live terminal, takes focus via press).
for _ in $(seq 1 12); do
  HAS_WEBO="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_WEBO" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select');
  sel.value = "$SESS";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-web";
})()
EOF
sleep 8
# Split: the new (newest) pane becomes active.
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[1].querySelector('.pane-select');
  sel.value = "$SESS_FB";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-b";
})()
EOF
sleep 6
# Focus pane 0 with a real pointer press on the pane element (PTY views
# hold no DOM focus to adopt; the pane pointerdown listener moves .focused).
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; if (!p) return "no-pane"; p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return "pressed"; })()
EOF
sleep 2
FOCUSED_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => [...document.querySelectorAll('#paneGrid .pane')].findIndex((p) => p.classList.contains('focused')).toString())()
EOF
)"
FOCUSED="$(echo "$FOCUSED_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$FOCUSED" = "0" ] \
  && pass "pane press moves focus to that pane" || fail "focus stuck off pane 0 (index: $FOCUSED_RAW)"
# The sidebar row for the third session must exist before clicking it.
for _ in $(seq 1 12); do
  HAS_FCROW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => (document.querySelector('[data-sess="$SESS_FC"]') ? "yes" : "no"))()
EOF
)"
  echo "$HAS_FCROW" | grep -q "yes" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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

echo "== browser: left-panel selection tracks the active window"
# The user's invariant: sidebar `.active` == focused pane's session.
# Opencode pane 0 ($SESS) + droid pane 1; pressing pane 0 must move the
# sidebar highlight, and clicking a row for the session live in the OTHER
# pane must focus it instead of duplicating the view.
SESS_GB="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-sel-b\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 3
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
# Focus pane 0 with a real pointer press on the pane element (PTY views
# hold no DOM focus to adopt; the pane pointerdown listener moves .focused).
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; if (!p) return "no-pane"; p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return "pressed"; })()
EOF
sleep 2
SEL_WEB_RAW="$(agent-browser eval --stdin 2>/dev/null <<'EOF' | tail -1
(() => { var r = document.querySelector('#wsList .sess.active'); return r ? r.dataset.sess : null; })()
EOF
)"
SEL_WEB="$(echo "$SEL_WEB_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
[ "$SEL_WEB" = "$SESS" ] \
  && pass "sidebar selects the pressed pane's window" || fail "sidebar stuck off pressed pane (got: $SEL_WEB_RAW)"
# Click the row for the session live in pane 1: must focus pane 1, keep both
# panes (no duplication of the view into pane 0).
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
for _ in $(seq 1 3); do
  NPANES="$(agent-browser eval "document.querySelectorAll('#paneGrid .pane').length" 2>/dev/null | tail -1)"
  echo "$NPANES" | grep -q "1" && break
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { for (var i = 1; i < 200; i++) { try { clearInterval(i); } catch (e) {} } return "frozen"; })()
EOF
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var b = document.getElementById('btnSplitCols'); if (b) b.click(); return "split"; })()
EOF
sleep 2
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 3

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
  agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
  agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
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
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
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

echo "== browser: narrate toggle speaks session activity (persisted)"
# Narrate toggle: flips aria-pressed + .on, persists, survives reload.
# Headless speech uses the system engine (forced below — the Kokoro default
# would pull ~90MB); all clicks here are synthetic (no trusted gesture).
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => window.__narrateSetEngine('system'))()
EOF
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
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
# Feed a quiet droid PTY: the opencode TUI repaints constantly (backlog
# replay + spinner frames flood narrateFeed and evict test text before the
# read). The feed/filter/flush/queue path is harness-agnostic.
SESS_NR=""
SESS_NR="$(curl -s -m 60 -X POST "$MGR/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WSID\",\"harness\":\"droid\",\"title\":\"e2e-narrate-quiet\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
for _ in $(seq 1 12); do
  HAS_NOPT="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1
(() => { var p = document.querySelectorAll('#paneGrid .pane')[0]; var s = p && p.querySelector('.pane-select'); return s ? [...s.options].some((o) => o.value === "$SESS_NR").toString() : "no-pane"; })()
EOF
)"
  echo "$HAS_NOPT" | grep -q "true" && break
  sleep 2
done
agent-browser eval --stdin >/dev/null 2>&1 <<EOF
(() => {
  var sel = document.querySelectorAll('#paneGrid .pane')[0].querySelector('.pane-select');
  sel.value = "$SESS_NR";
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return "assigned-quiet";
})()
EOF
sleep 3
# Settle: a fresh PTY flaps working→waiting as its spawn burst settles, and
# every transition preempts content narration (clears buffer+queue by design).
# Feed only once the session reads stably waiting across consecutive polls.
STABLE=0
for _ in $(seq 1 12); do
  sleep 2
  ACT="$(curl -s -m 10 "$MGR/api/state" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(next((s.get('activity','?') for s in ss if s['id']=='$SESS_NR'),'MISSING'))")"
  if [ "$ACT" = "waiting" ]; then STABLE=$((STABLE + 1)); else STABLE=0; fi
  [ "$STABLE" -ge 2 ] && break
done
[ "$STABLE" -ge 2 ] \
  && pass "narrate session settled before feed" || fail "session never settled (activity: $ACT)"
FED_RAW="$(agent-browser eval --stdin 2>/dev/null <<EOF | tail -1 || true
(() => {
  narrateFeed('sess_e2e_background', 'This background session text must be ignored completely by the narrator feed path.');
  narrateFeed("$SESS_NR", 'The session finished the database migration in twelve seconds. All three replicas are healthy now.');
  return JSON.stringify(narrate.pendingText);
})()
EOF
)"
NARR_BUF="$(echo "$FED_RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin))' 2>/dev/null || echo "EVAL-ERR")"
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
curl -s -m 10 -X DELETE "$MGR/api/sessions/$SESS_NR" >/dev/null 2>&1 || true
SESS_NR=""
agent-browser open "$MGR/" >/dev/null 2>&1
sleep 4
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
agent-browser eval --stdin >/dev/null 2>&1 <<'EOF'
(() => { var b = document.getElementById('btnNarrate'); if (b) b.click(); return "off"; })()
EOF
sleep 1

echo "== $FAILS failure(s)"
exit "$([ "$FAILS" -eq 0 ] && echo 0 || echo 1)"
