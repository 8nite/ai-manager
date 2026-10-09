#!/usr/bin/env bash
# scripts/ai-tunnel-health.sh — check local manager + tunnel reachability.
set -euo pipefail
PORT="${LOCAL_PORT:-${AI_MGR_PORT:-4000}}"
echo "== manager http://127.0.0.1:$PORT/health"
curl -fsS "http://127.0.0.1:$PORT/health" | head -c 300
echo
echo "== gateway https://ai-manager.nexvision.cc/health (needs device session in browser; raw curl is unauthenticated)"
curl -ksS "https://ai-manager.nexvision.cc/health" | head -c 500
echo
