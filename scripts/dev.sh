#!/usr/bin/env bash
# One command local run.
#   scripts/dev.sh                     sandbox: nearcore sandbox + basis-node (:8797) + dashboard (:5418)
#   scripts/dev.sh testnet <stack.json> your own testnet stack: basis-node (:8798, lean, dev keys exposed locally) + dashboard
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
[ -f out/basis_core.wasm ] || scripts/build-contracts.sh
MODE="${1:-sandbox}"
cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM
if [ "$MODE" = "sandbox" ]; then
  [ -x "${BASIS_TOOLS:-$HOME/.local/share/basis-amm}/near-sandbox" ] || infra/local-dev/install-sandbox.sh
  (cd services/basis-node && npx tsx src/main.ts --sandbox) &
  API=http://127.0.0.1:8797
else
  STACK="${2:?usage: scripts/dev.sh testnet <infra/testnet/NAME-stack.secret.json>}"
  (cd services/basis-node && npx tsx src/main.ts --stack "../../$STACK" --port 8798 --expose-dev-keys) &
  API=http://127.0.0.1:8798
fi
until curl -s "$API/api/health" | grep -q ok; do sleep 3; done
echo "basis-node ready at $API"
VITE_API_URL="$API" pnpm --filter @basis/web dev
