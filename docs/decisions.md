# Section 14 decisions: what the code does today

The spec says the implementing agent must not decide section 14 itself. I did not hard-code any of
these answers. Each one is a config field, a policy field or a manifest value, and the shipped
values are the spec's own recommendation where it gave one. Every value below is marked
PROVISIONAL and is safe only for testnet and synthetic funds. Changing one is a governance
action (timelocked `propose_config` / `propose_policy`), never a code change.

| # | Question | Shipped (provisional) | Where it lives |
|---|----------|-----------------------|----------------|
| 1 | MVP demo market set | 7 fixtures: daily crypto (BTC), weekly crypto (SOL, ETH), sports in-play (NBA), election (Senate, with an INVALID scenario), Fed meeting (3 outcomes), commodity (gold). A weather market is admitted after deploy to prove no redeploy is needed | `policies/examples/*.json` |
| 2 | Listing authority | Admin proposes, risk council approves after the timelock. No automatic admission | `propose_market` / `approve_policy` |
| 3 | Leverage policy | Protocol ceiling 10x (timelocked config) plus a stricter per-market cap plus the tick-sensitivity ceiling `p0/(k*tick)` plus vault capacity | `ProtocolConfig.max_leverage_ceiling`, `MarketPolicy.max_leverage`, `min_adverse_ticks` |
| 4 | LP token | Single `bLP`, transferable (`blp_transferable: true`, can be switched off) | `ProtocolConfig.blp_transferable` |
| 5 | Insurance | $5,000 seed in demos; 20% of every fee; opens are refused while insurance is below $1,000 | `min_insurance_for_opens`, `fees.insurance_share_bps` |
| 6 | Exposure caps | Event stress cap 2% of NAV, global stress cap 10% of NAV, hedge budget 10-15% of NAV per hedged market | `event_stress_cap_bps`, `global_stress_cap_bps`, `hedge_budget_bps` |
| 7 | Fee schedule | Open 0.10%, close 0.10%, holding 10% APR on the virtual base `(L-1)M` (15% for the election), keeper reward 5% of positive residual capped at $5, fair-value risk premium 5% of the hold-to-resolution floor value, fee split 70% LP / 20% insurance / 10% treasury | `MarketPolicy.fees` |
| 8 | Custody/execution | Controlled executor account (option A, simplest MVP). The executor in this repo is a deterministic mock that never signs a real venue order | `Roles.executors`, `services/basis-node/src/executor.ts` |
| 9 | Collateral | `tUSDC`, a 6-decimal testnet NEP-141 with a faucet. No bridge | `contracts/mock-usdc` |
| 10 | Partial execution (open parts) | Default ON. Minimum fill is a user slider bounded below by a per-market floor (10%). No repeated child fills. Order lifetime max 10 minutes. If a user chose all-or-none and the venue filled partially, the vault keeps the inventory and the user is refunded in full | `min_fill_floor_ppm`, `max_order_lifetime_ns`, `finalize_open_hedged` |
| 11 | Internal opposing flow | DECIDED in spec: no matching. Implemented | every fill is against the vault |
| 12 | Early exit / liquidation | Full liquidation only (no keeper partial liquidation). TP/SL are best-effort keeper triggers | `liquidate`, `execute_trigger` |
| 13 | LP withdrawals | Immediate when free liquidity allows, else queued FIFO. No withdrawal fee. No max queue age | `request_withdraw`, `settle_withdrawals` |
| 14 | Oracle trust | One mark reporter key; resolution needs `min_resolution_reporters` (1 in demos, 2 supported) plus a dispute window. Staleness 120 s for every market | `ReporterInfo`, `max_mark_staleness_ns` |
| 15 | Disputes | Settlement freezes while disputed. No provisional claims | `ResolutionStatus::Disputed` |
| 16 | Upgrades | Contracts are deployed without an upgrade method. A new version means a new deployment plus migration | no `upgrade` entry point |
| 17 | Deployment intent | (A) testnet and synthetic funds only | everywhere |
| 18 | Naming | `Basis-AMM`, `bLP`; insurance is a ledger, not a token | contract metadata |
| 19 | Economic model | DECIDED in spec: synthetic claim, vault owns hedges. Implemented; there is no loan ledger | |
| 20 | Hedging strategies | (A) exact same-event outcome shares only | receipts must match the market's own outcome token ref |
| 21 | Market-policy UX | (A) compact rules on the trade screen with full terms expandable | `apps/web` |
| 22 | Multi-outcome | Schemas support any mutually exclusive outcome set via a payout matrix; the Fed fixture has 3 outcomes; execution in this repo is mock-only | `MarketDescriptor.scenarios` |
| 23 | Profit/loss | DECIDED in spec: loss capped at M, no profit cap. Implemented and property-tested | `basis-math::position` |
| 24 | Pool proposal | (A) `POOL_ONLY` default with full scenario reserve, plus `POOL_PLUS_HEDGE` and `HEDGE_REQUIRED` per market | `MarketPolicy.strategy` |
| 25 | +100% barrier | DECIDED in spec: removed. There is no code path that closes a profitable position | |
| 26 | Oracle pricing vs execution | Commit-then-execute: execution uses a mark observed after the user's commit, priced by walking the book for the actual size; spread and depth guards refuse thin or wide books | `verify_mark`, `plan_open` |

## The one number I most want you to look at

`floor_coverage_bps` (item 7) decides how much of the nonrecourse floor's value a trader pays up
front. The contract computes the hold-to-resolution trader EV under mark-implied probabilities
(the spec's $0.80 example comes out at exactly +$80) and charges `coverage * EV`. At 100% coverage
a 5x position at $0.50 would cost $200 of premium on $100 of margin, which kills the product. At
the shipped 5% it costs $9.85. Liquidation before resolution makes the true value lower than the
hold-to-resolution bound, but by how much depends on how often marks gap through the liquidation
price, which needs the historical backtest the spec asks for before any real funds.

The simulator in `research/` puts numbers on this (synthetic paths with jumps, 10,000 trades per
event family, `pnpm --filter @basis/research sim`). LP P&L for `POOL_ONLY` by coverage:

| Coverage | crypto-daily | sports-in-play | election | fed-meeting |
|---|---|---|---|---|
| 5% (shipped) | -$34,354 | -$122,317 | -$119,583 | -$218,566 |
| 10% | -$22 | -$94,650 | -$86,221 | -$178,036 |
| 25% | $102,975 | -$11,647 | $13,867 | -$56,445 |
| 50% | $274,637 | $126,690 | $180,679 | $146,206 |

At 5% the vault loses money in every family. Breakeven sits around 10% for liquid crypto and
25-40% where one catalyst decides the event (sports, Fed). The losses come from positions held
through resolution: a losing trader's equity jumps from positive to `M - N` in one step, and the
floor absorbs `(L-1)M`. Three levers, all policy data, none needing code: a higher
`floor_coverage_bps`, lower `max_leverage` near the catalyst, or a `CLOSE_ONLY` window before
resolution so new exposure stops accumulating. A maintenance curve that rises toward resolution
(liquidating losers earlier, never touching winners) would need a contract change.
