#!/usr/bin/env bash
# scripts/build-gateway-configmap.sh — package k8s/ai-gateway sources into the
# ai-manager-gateway-code ConfigMap (mirrors the opencode-auth flow).
# Usage: bash scripts/build-gateway-configmap.sh [apply|dry-run]
set -euo pipefail
cd "$(dirname "$0")/../k8s/ai-gateway"

MODE="${1:-dry-run}"
CM=ai-manager-gateway-code
NS=nexvision

build_args=()
for f in *.js; do
  [ -e "$f" ] || continue
  build_args+=(--from-file="$f")
done
# gateway-admin wrapper (extensionless filename survives as the CM key).
[ -e gateway-admin ] && build_args+=(--from-file="gateway-admin")
for f in public/index.html public/login.html public/register.html public/gateway.css; do
  key="public_$(basename "$f" | tr '.' '_')"
  build_args+=(--from-file="$key=$f")
done

if [ "$MODE" = "apply" ]; then
  kubectl -n "$NS" create configmap "$CM" "${build_args[@]}" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "ConfigMap $CM applied; restart the gateway to pick it up:"
  echo "  kubectl -n $NS rollout restart deploy/ai-manager-gateway"
else
  kubectl -n "$NS" create configmap "$CM" "${build_args[@]}" --dry-run=client -o yaml | head -n 20
  echo "... (dry-run; pass 'apply' to write)"
fi
