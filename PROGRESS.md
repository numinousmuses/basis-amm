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
- [x] M4 services/basis-node (oracle, keeper, mock executor, reconciler, SQLite indexer, quote, REST/WS :8797, Polymarket read-only, lean testnet mode); 7/7 integration tests
- [x] M5+M6 apps/web done by subagent: 10 pages, 25 vitest + 7 Playwright pass (agent-reported; re-verify before publish), footage in video/footage
- [x] M6 Playwright 7/7 re-verified by me against the dev stack; web vitest 25/25; build ok
- [x] M7 testnet: acceptance 16/16 on core.basislive211107.testnet (docs/integration-proofs/README.md); live stack core.live.basislive211107.testnet with basis-node --stack infra/testnet/live-stack.secret.json --port 8798 (lean mode, view cache)
- [x] M8 docs complete incl. integration proofs
- [x] M9 https://github.com/numinousmuses/basis-amm public; CI green (rust, typescript, sandbox-e2e); release v0.1.0 with video
- [x] M10 video/basis-amm-demo.mp4 (86 s, Remotion, real footage)

## Log

- 2026-11-08 21:40 ET: repo initialised, spec + mockup copied to docs/spec, toolchain installed.
- 2026-11-08 23:15 ET: SDK (packages/sdk) + stack (packages/stack: sandbox runner, deployStack, MockVenue) done.
  Sandbox: ~/.local/share/basis-amm/near-sandbox (nearcore 2.14.0) needs DYLD_LIBRARY_PATH=~/.local/share/basis-amm/xz/lib
  (built xz from source; infra/local-dev/install-sandbox.sh reproduces). Smoke deploy test passes (tests/e2e/test/smoke.test.ts, ~100s).
  Next: tests/e2e acceptance suite (spec section 11 items 1-12 + adversarial), then services, web, testnet.
  Fair-value gate: policy floor_coverage_bps (5% provisional) of hold-to-resolution floor EV; $0.80 item 11 runs on pm-gold-above-3000 with zero-spread book so EV is exactly $80.
- 2026-11-09 00:20 ET: dev stack running: `cd services/basis-node && npx tsx src/main.ts --sandbox` (sandbox :3030, API :8797; port 8787 is taken by another local app).
  State in infra/local-dev/data (stack.json has dev keys). Orphan near-sandbox processes must be killed by PID after stopping the node.
- 2026-11-09 04:00 ET: testnet. Faucet gives 10 NEAR/account and rate-limits (429) per IP.
  First testnet attempt (basisamm202099) failed: signers need ~0.31 NEAR free for 300 Tgas prepaid; keys of those
  accounts were lost (fixed: deployStack checkpointPath). Acceptance on testnet running with master basisacc211086.testnet
  (log /tmp/acc-testnet.log; secret stack -> infra/testnet/acceptance-stack.secret.json; proofs -> docs/integration-proofs/testnet-acceptance.json).
  Live demo master basislive211107.testnet has ~22.8 NEAR, needs ~27: reclaim spare NEAR from acceptance role accounts after the run,
  then `npx tsx scripts/deploy-testnet.ts basislive211107.testnet live` and run basis-node --stack infra/testnet/live-stack.secret.json.
  Remotion video: video/src/Demo.tsx (1920x1080, 2570 frames). Render: cd video && npx remotion render BasisDemo out/basis-amm-demo.mp4 --props='{"repoUrl":"https://github.com/numinousmuses/basis-amm","testnetContract":"...","testnetSteps":N}'
  Research finding: 5% floor coverage loses LP money in all families; breakeven 10-40% (docs/decisions.md).
- 2026-11-09 04:40 ET: ALL MILESTONES DONE. Running processes: sandbox dev stack (:3030/:8797), testnet node (:8798), vite preview (:5419).
  Testnet RPC lessons: FastNEAR free tier and rpc.testnet.near.org both 429; fixed with SDK backoff + shared deduped view cache (lean mode).
- 2026-11-09 05:40 ET: round 2 (Joshua: kill testnet, TEE oracle, make section 14 decisions). Testnet node stopped.
  TEE oracle: crates/oracle-tee (wasip2, PROTECTED_ORACLE_KEY, Gamma second source), contract request_tee_reporter/on_tee_reporter,
  require_attested_marks, contracts/mock-outlayer (sandbox only), basis-node --tee-outlayer/--tee-wasmtime. docs/tee-oracle.md.
  Decisions: docs/decisions.md DECIDED; caps 4x crypto/election, 3x sports/Fed, ceiling 5x; coverage 15/35/55/55%; final-hour CLOSE_ONLY;
  bLP non-transferable. Tests use specFixtureManifests() (labeled 5x override). All suites green: e2e 21, node 10, web 25+7, rust 37+5.
