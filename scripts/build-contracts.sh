#!/usr/bin/env bash
# Builds both contracts to target/near/<name>/<name>.wasm with cargo-near.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
cd "$(dirname "$0")/.."
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"
for c in mock-usdc basis-core; do
  (cd "contracts/$c" && cargo near build non-reproducible-wasm --no-abi >/dev/null)
done
mkdir -p out
cp target/near/basis_core/basis_core.wasm out/basis_core.wasm
cp target/near/mock_usdc/mock_usdc.wasm out/mock_usdc.wasm
ls -la out/*.wasm
