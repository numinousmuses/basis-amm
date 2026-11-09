#!/usr/bin/env bash
# Builds the TEE oracle for OutLayer (wasm32-wasip2) and prints the SHA-256 to pin in TeeConfig.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
cd "$(dirname "$0")/.."
rustup target add wasm32-wasip2 >/dev/null 2>&1 || true
cargo build -q -p oracle-tee --release --target wasm32-wasip2
mkdir -p out && cp target/wasm32-wasip2/release/oracle-tee.wasm out/oracle-tee.wasm
shasum -a 256 out/oracle-tee.wasm 2>/dev/null || sha256sum out/oracle-tee.wasm
