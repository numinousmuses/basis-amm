# Section 14 decisions

Joshua asked me on 2026-11-09 to make the section 14 calls. These are my decisions and the code
and policies now ship them. Every one is still a config field, a policy field or a manifest value,
so changing one later is a timelocked governance action, not a code change. All of it is for
testnet and test funds; item 17 lists what has to happen before real money.

## The pricing problem, and the fix

A nonrecourse leveraged claim held through a binary resolution is an option. Just before the
event resolves, a position with financing base `N - M` and current price `q` has expected payout
`q * (M + Q - N)` but marked equity `M + Q*q - N`; the gap is `(1-q)(N-M)` for every open position,
whatever its P&L. The vault pays that gap when the event lands against the trader. At entry the
contract prices it as the hold-to-resolution trader EV, which at a fair entry is `(L-1) * M * (1-p0)`.
Liquidation and early exits mean the vault only bears part of that, and the 5% coverage I shipped
first was far too little: LPs lost money in every simulated family.

The cost scales with `(L-1)` and with how many positions survive to resolution. Two levers cut
it without ever force-closing a winner:

1. **Leverage caps per family.** I tried 2x, 3x and 4x. Below 3x the premium as a share of margin
   barely moves (fewer liquidations mean more positions reach the jump).
2. **A pre-resolution maintenance ramp for losing positions.** Maintenance rises from 5% to 50%
   over the final stretch of each market (10 h for daily crypto, 2 days for weekly, 7 days for
   elections, Fed and monthly commodities, 1.5 h for sports). Only positions below their margin
   are affected, so losers are liquidated at the book before the resolution jump instead of
   through it. New opens stop when the ramp starts.

With both, the simulator (`research/`, 5 seeds x 6,000 trades per family) gives:

| Family | Leverage cap | Break-even coverage, no ramp | With ramp | Shipped coverage | Seeds where LPs profit | Trader edge per trade |
|---|---|---|---|---|---|---|
| Crypto, commodities | 4x | 11.6% | 6.7% | 10% | 4 of 5 | -$3 |
| Elections | 4x | 25.0% | 19.0% | 25% | 4 of 5 | -$4 |
| Sports in-play | 3x | 41.4% | 37.7% | 50% | 5 of 5 | -$3 |
| Macro catalysts (Fed) | 3x | 41.0% | 8.9% | 15% | 4 of 5 | -$2 |

Shipped coverage is the mean break-even with the ramp plus 25%, rounded up to 5%. What a trader
pays at entry for $100 of margin at $0.50: crypto 4x $15, election 4x $37.50, sports 3x $50,
Fed 3x $15. Sports stays expensive because a single score can decide the event long before the
ramp; the honest choices are to price that or not offer leverage on in-play sports. A final-hour
CLOSE_ONLY window and the tick-sensitivity ceiling `p0/(k*tick)` still apply.

The simulator uses synthetic paths. Before real funds these numbers must be recalibrated on real
order-book history (spec section 11).

## All decisions

| # | Question | Decision | Where it lives |
|---|---|---|---|
| 1 | MVP market set | Daily crypto (BTC), weekly crypto (SOL, ETH hedged), sports in-play (NBA), election (Senate, with an INVALID scenario), Fed meeting (3 outcomes), commodity (gold); weather admitted after deploy | `policies/examples/` |
| 2 | Listing authority | Admin proposes, risk council approves after the timelock (24 h for real funds, 30 s on the testnet demo). No automatic admission | `propose_market`, `approve_policy` |
| 3 | Leverage | Protocol ceiling 5x (timelocked); per family 3-4x as above; tick-sensitivity ceiling and vault capacity on top | `max_leverage_ceiling`, `max_leverage` |
| 4 | LP token | One `bLP`, non-transferable until an external risk audit (`blp_transferable: false`); deposits and withdrawals still work | `ProtocolConfig.blp_transferable` |
| 5 | Insurance | Seed 5% of target vault size; 20% of every fee; no opens while insurance is below $1,000 (testnet) | `min_insurance_for_opens`, `insurance_share_bps` |
| 6 | Exposure caps | 2% of NAV per event, 10% globally, hedge inventory 10-15% of NAV per hedged market, max $10,000 margin per position | policy and config |
| 7 | Fees | Open 0.10%, close 0.10%, holding 10% APR on `(L-1)M` (15% for long-dated elections), keeper reward 5% of positive residual capped at $5, risk premium per the table above (with the maintenance ramp), split 70% LP / 20% insurance / 10% treasury. No keeper subsidy from insurance | `MarketPolicy.fees`, `pre_resolution_maintenance_bps`, `maintenance_ramp_ns` |
| 8 | Custody/execution | Executor signs through `executor-tee` (OutLayer TDX, PROTECTED key) as a CLOB-scoped Polymarket Session Key on a vault-controlled Deposit Wallet; per-order $2,500 hard cap in the TEE, tighter caps in basis-node. Paper venue by default; live orders only with explicit opt-in (`docs/hedging.md`) | `Roles.executors`, `tee_executor` |
| 9 | Collateral | Testnet `tUSDC`. Production: Circle's native USDC on NEAR, token id asserted live at deploy. The vault keeps hedge inventory on Polygon in executor custody; bridge cost is a vault expense | `collateral_token` |
| 10 | Partial execution | Default ON. User slider with a 10% floor. No repeated child fills. Orders live at most 10 minutes. If a user chose all-or-none and the venue filled partially, the vault keeps and unwinds the inventory and refunds the user in full | `min_fill_floor_ppm`, `max_order_lifetime_ns` |
| 11 | Internal opposing flow | No matching (spec decision). Implemented | |
| 12 | Liquidation and triggers | Full liquidation of losing positions only. TP/SL are best-effort keeper triggers, never guaranteed fills | `liquidate`, `execute_trigger` |
| 13 | LP withdrawals | Immediate when free liquidity allows, otherwise FIFO queue. No withdrawal fee. The withdrawing LP bears no hedge-sale cost; emergency liquidity comes from free cash only | `request_withdraw` |
| 14 | Oracle trust | MARK reports must come from the TEE oracle (`require_attested_marks: true` for real funds) and pass a second-source check inside the TEE; 120 s staleness (tighten crypto to 30 s once the TEE oracle runs continuously). Resolution: 2 independent reporters plus a dispute window | `docs/tee-oracle.md` |
| 15 | Disputes | Settlement freezes until finalized; no provisional claims | `ResolutionStatus::Disputed` |
| 16 | Upgrades | No upgrade method. New versions deploy fresh with migration. For real funds, the contract account's full-access key is deleted (locked contract) | deployment |
| 17 | Deployment intent | (A) testnet and synthetic funds. Before real funds: independent audit, legal review, recalibration on real order-book data, real collateral, live TEE oracle and executor | |
| 18 | Naming | `Basis-AMM`, `bLP`; insurance is a ledger, not a token | |
| 19 | Economic model | Synthetic claim, vault owns hedges (spec decision). Implemented | |
| 20 | Hedge instruments | Exact same-event outcome shares only, bought with FAK orders and unwound when the hedged position closes; redeemed after settlement. No perps or rate futures in v1 | receipt token check, executor |
| 21 | Market-rules UX | Compact rules summary on the trade screen, full terms one click away, confirmation shows them before signing | `apps/web` |
| 22 | Multi-outcome | Binary venue tokens first; schemas take any exclusive outcome set (the Fed fixture has 3) | payout matrix |
| 23 | Profit/loss | Loss capped at M, profit uncapped (spec decision). Implemented and property-tested | |
| 24 | Pool proposal | `POOL_ONLY` default with full scenario reserve; `POOL_PLUS_HEDGE` and `HEDGE_REQUIRED` per market | `MarketPolicy.strategy` |
| 25 | +100% barrier | Removed (spec decision). No code path closes a winning position | |
| 26 | Pricing vs execution | Commit-then-execute at a mark observed after the commit, depth-walked for the actual size; spread and depth guards; closes refused on thin books | `verify_mark`, `plan_open` |

The spec's section 11 demo is written for 5x positions. The acceptance suite deploys those fixture
markets with a labeled 5x override (`specFixtureManifests` in `packages/stack`); nothing outside
tests uses it.
