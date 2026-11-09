# Basis-AMM build progress

Read this first after any context reset. It is the single source of truth for what is done,
what is next, and which decisions were made. Update it after every milestone and commit.

## Goal (from Joshua, 2026-11-08)

Implement `docs/spec/Basis_AMM_Engineering_Spec_v0.1.md` end to end in this local repo
(`~/basis-amm`), commit often, fully built and tested (unit, property, sandbox, e2e), deployed
on NEAR testnet, UI ported from `docs/spec/ui-mockup.html`, then publish to a PUBLIC repo
`numinousmuses/basis-amm` (gh CLI is logged in as numinousmuses), then a Remotion demo video.

Rules: no AI attribution in commits (no Co-Authored-By, no "Generated with"). No em dashes in
prose. Testnet / synthetic funds only. Real Polymarket = read-only discovery; hedge fills are a
labeled deterministic mock executor (spec section 11 "hackathon minimum").

## Architecture decisions (deviations recorded in docs/deviations.md)

1. One deployable `basis-core` contract with modules registry / vault+bLP / margin / oracle /
   insurance (spec section 3 allows this when async cross-contract invariants are risky).
   Reserve + open happen atomically in one receipt. Plus `mock-usdc` NEP-141 test token.
2. `crates/basis-math`: pure fixed-point math (payoff, reserve, scenario stress, fees, fair-value
   gate, partial fill), no_std-friendly, shared by contract; property-tested with proptest.
   Emits JSON test vectors consumed by the TypeScript SDK tests so both sides agree.
3. Oracle reports and quotes: ed25519 signed borsh payloads, verified onchain with
   `env::ed25519_verify` against registered reporter keys. Commit-then-execute: execution needs
   a MARK report observed after the order's commit timestamp (anti last-look).
4. FINAL_RESOLUTION: reporter quorum + dispute window, then finalize. Guardian can dispute.
5. Fair-value gate: the hold-to-resolution trader EV under mark-implied probability is an upper
   bound on the floor's value. Required risk premium = EV_upper * policy.floor_value_coverage_bps.
   Quote rejected (FAIR_VALUE) if premium exceeds user-signed max_fee.
6. Activity: contract keeps a bounded onchain audit ring buffer with sequence numbers and emits
   NEP-297 logs; indexer pulls `get_events_since`.
7. Offchain: TypeScript pnpm workspace. `packages/sdk` (types, borsh, signing, math mirror),
   `services/*` (oracle-worker, quote-engine, keeper, mock-executor, reconciler, indexer-api,
   polymarket read-only adapter) run by one `basis-node` process; SQLite (node:sqlite) read
   model, never the accounting authority.
8. `apps/web`: Vite + React + TS, port of the 10 mockup pages, near-wallet-selector for testnet,
   local dev-key signer for sandbox and demo.
9. Section 14 product-owner decisions: every one is a config parameter. Example values live in
   `policies/examples/` and `docs/decisions.md`, flagged PROVISIONAL pending Joshua.

## Milestones

- [x] M0 toolchain: rustup 1.99.1, wasm32 target, cargo-near 0.23.0, near-cli-rs 0.31.1
- [x] M1 basis-math crate + property tests + test vectors (37 tests; TS parity via crates/basis-math/vectors)
- [x] M2 basis-core contract (registry, vault/bLP NEP-141, margin, oracle, hedge, insurance, views) + mock-usdc; builds via scripts/build-contracts.sh -> out/*.wasm
- [x] M3 sandbox acceptance suite tests/e2e/test/acceptance.test.ts: 16/16 pass (spec 11 items 1-12 + adversarial), ~10 min
- [~] M4 services/basis-node built (oracle, keeper, mock executor, reconciler, SQLite indexer, quote, REST/WS on :8797, Polymarket read-only discovery). TODO: in-process integration test services/basis-node/test
- [~] M5+M6 apps/web + Playwright + footage capture DELEGATED to a background subagent (started 2026-11-09 00:20 ET). It commits only apps/web, video/footage, pnpm-lock.yaml. Do not touch apps/web while it runs; use explicit git add paths (never git add -A) until it reports.
- [ ] M6 Playwright e2e against local sandbox stack
- [ ] M7 NEAR testnet deployment + scripted acceptance demo with tx hashes recorded
- [ ] M8 docs (threat-model, risk-policy, deployment, integration-proofs, deviations, decisions)
- [ ] M9 publish public GitHub repo numinousmuses/basis-amm + CI
- [ ] M10 Remotion demo video rendered from real app footage

## Log

- 2026-11-08 21:40 ET: repo initialised, spec + mockup copied to docs/spec, toolchain installed.
- 2026-11-08 23:15 ET: SDK (packages/sdk) + stack (packages/stack: sandbox runner, deployStack, MockVenue) done.
  Sandbox: ~/.local/share/basis-amm/near-sandbox (nearcore 2.14.0) needs DYLD_LIBRARY_PATH=~/.local/share/basis-amm/xz/lib
  (built xz from source; infra/local-dev/install-sandbox.sh reproduces). Smoke deploy test passes (tests/e2e/test/smoke.test.ts, ~100s).
  Next: tests/e2e acceptance suite (spec section 11 items 1-12 + adversarial), then services, web, testnet.
  Fair-value gate: policy floor_coverage_bps (5% provisional) of hold-to-resolution floor EV; $0.80 item 11 runs on pm-gold-above-3000 with zero-spread book so EV is exactly $80.
- 2026-11-09 00:20 ET: dev stack running: `cd services/basis-node && npx tsx src/main.ts --sandbox` (sandbox :3030, API :8797; port 8787 is taken by another local app).
  State in infra/local-dev/data (stack.json has dev keys). Orphan near-sandbox processes must be killed by PID after stopping the node.
