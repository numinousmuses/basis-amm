#!/usr/bin/env bash
# Create a testnet master account and pool NEAR into it from extra faucet-sponsored accounts.
# Usage: scripts/faucet-master.sh <prefix> <extra-funders>   (each faucet account starts with 10 NEAR)
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
PREFIX="$1"; N="${2:-2}"
M="${PREFIX}$(date +%s | tail -c 7).testnet"
near account create-account sponsor-by-faucet-service "$M" autogenerate-new-keypair save-to-legacy-keychain network-config testnet create >/dev/null
for i in $(seq 1 "$N"); do
  F="${PREFIX}f${i}$(date +%s | tail -c 6).testnet"
  near account create-account sponsor-by-faucet-service "$F" autogenerate-new-keypair save-to-legacy-keychain network-config testnet create >/dev/null
  sleep 2
  near tokens "$F" send-near "$M" '9.9 NEAR' network-config testnet sign-with-legacy-keychain send >/dev/null
done
echo "$M"
