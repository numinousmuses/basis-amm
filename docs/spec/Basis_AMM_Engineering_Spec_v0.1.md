# Basis-AMM — Engineering Specification v0.1

**Status:** Product-owner review draft; includes GMX-style counterparty-pool proposal. **Not implementation-frozen.**  
**Date:** 2026-11-08  
**Purpose:** A market-agnostic, nonrecourse synthetic leveraged trading protocol over prediction markets, backed by a risk-managed counterparty liquidity vault.  
**Primary chain:** NEAR Protocol. **Initial venue adapter:** Polymarket on Polygon, without restricting the protocol to crypto, sports, Polymarket, or binary questions.  
**Principle:** Trader maximum loss is deposited isolated margin, while **profit is not capped at +100% of margin**. The synthetic claim earns full price-based P&L until voluntary close, valid liquidation, or resolution; a binary outcome's $1 payout still imposes a finite mathematical maximum. **No mandatory profitable-position auto-close or forced +100% take-profit.** The pool is counterparty to the nonrecourse leveraged claim and owns/manages optional hedges. Vault and insurance absorb uncovered losses. Do not market the vault as delta-neutral, guaranteed profitable, insured, or risk-free.
**Product-owner decisions confirmed 2026-11-08/09:** (1) No hard-coded market-category eligibility, trading cutoffs, or leverage tiers; approved markets use versioned, configurable offchain strategies and onchain-enforced policy bounds. (2) Markets may span crypto, elections, sports, Fed rates, and other prediction categories. (3) Partial fills enabled by default, with user opt-out. (4) No internal matching and no order book. (5) **Synthetic leverage**: users own nonrecourse claims against Basis-AMM, not venue shares or margin loans. (6) **Profit uncapped relative to margin; loss capped at 100% posted isolated margin.** (7) **No automatic +100%-profit close**; trader-directed exits, valid liquidation, or event settlement only. Fees apply per signed terms.

**GMX-style architectural correction, proposed for approval:** The vault can be the synthetic trader's counterparty with **no mandatory per-trade outcome-share purchase**. But an unhedged vault must reserve for the trader's **full possible winning P&L, which can exceed posted margin**. For a binary outcome entered at `p0`, margin `M`, and leverage `L`, maximum gross winning P&L is `L*M*(1-p0)/p0`, not `M`. Optional hedges change scenario risk and must be modeled together with synthetic liabilities, collateral and execution costs. This pool-only/optional-hedge strategy choice still requires Joshua's approval.

## 0. Goals, assumptions, exclusions

Deliver: (a) oracle-anchored synthetic leveraged positions with extensible outcome spaces; begin with binary YES/NO contracts but do not encode a binary-only protocol schema; (b) **reserve-first pool counterparty settlement** with explicit optional per-market hedge strategies and no internal matching; (c) early closes, stop orders, take profit and partial reduction when an admissible current market quote exists, even if no vault hedge trade is executed; (d) liquidations; (e) USDC-denominated LP vault token `bLP`; (f) a separately accounted insurance reserve; (g) adapter-based market observations and venue-specific finalized resolution; (h) portfolio loss-budget controls; (i) CLI/services/dashboard/demo with independently testable proofs; (j) true NEAR contract integration; (k) explicit user-facing per-market leverage, fees, holding costs, entry/exit windows, liquidation and resolution restrictions.

**No market category is permanently included or excluded in contract code.** Markets are admitted through an owner-approved, versioned `MarketPolicy` and named execution/resolution adapters; any venue/category/time horizon can be proposed, including elections, sports during or before play, central-bank meetings, macroeconomic data releases, and crypto. Each market independently specifies its permitted actions, entry window, liquidity threshold, risk model, leverage ceiling, oracle requirements, resolution dependencies, and risk-capacity reservation. An unsupported or unsafe market is rejected for a stated reason, not because the smart contract contains a blanket `sports`/`elections`/`1-hour` restriction. The initial operator may approve a narrow subset without constraining later protocol capability.

Do not implement perpetual funding, uncapped price derivatives, user margin calls beyond posted collateral, synthetic futures detached from an exact event, **unreserved** market making, presumed ability to obtain trustworthy in-play sports or illiquid political-market marks, assumed 24/7 executable external hedging, or unlimited leverage. An **unhedged but fully max-payout-reserved** synthetic position may be admissible if oracle quality and portfolio risk controls pass. In-play access is a market policy and risk-capacity decision, not an architectural prohibition.

**Critical distinction:** For a **pool-counterparty position with no external hedge**, the LP's maximum direct loss is the **full theoretical positive trader P&L**, dependent on entry price and leverage, not `M`. A same-direction outcome-share hedge can cover profitable trader states but creates adverse-outcome losses beyond forfeited user margin. Model both event outcomes, interim paths, execution costs, oracle manipulation, correlated positions, and hedge failure. Reserves do not replace fair pricing.

## 1. Verified primitives and limits

- NEAR contracts: implement in Rust using current official `near-sdk`; generate Wasm and deploy to NEAR testnet. Fungible vault shares should conform to NEP-141 where appropriate, with storage accounting and transfer callbacks according to current standard.
- NEAR Intents: supports intent-based asset swap/settlement with external solvers; **do not assume** its API directly trades Polymarket outcome shares or provides an authenticated Polymarket price oracle. A specifically built Polygon/Polymarket adapter or solver is needed, and its support must be demonstrated before claims.
- Polymarket: outcome positions and order execution on Polygon via its order-book/CTF exchange ecosystem; obtain market-specific token IDs, actual tick size, order book, trading status, minimum order size, fee structure, and resolution contract mapping. Use actual executed fill amounts and receipts. Its binary outcome-share execution path can be reused across many event categories; separate strategies concern *risk, limits, data cadence and event-specific settlement*, not necessarily new venue trading code per market.
- OutLayer: candidate for attested offchain WASM calculations/oracles, callable by NEAR contracts with asynchronous callbacks. TEE attestation binds the code and inputs/outputs, **not** truth/freshness of external market APIs; independently verify source and block/response provenance.
- NEAR Chain Signatures: optional signing bridge for Polygon transactions, subject to capability/security testing. A dedicated bounded executor/TEE wallet is another option; choose one before live funds.

Authoritative references for implementers:

1. https://docs.near.org/
2. https://docs.near-intents.org/integration/market-makers/introduction
3. https://app.outlayer.ai/docs/near-integration
4. https://app.outlayer.ai/docs/tee-attestation
5. https://github.com/Polymarket/uma-ctf-adapter
6. https://github.com/Polymarket/agent-skills/blob/main/order-patterns.md
7. https://docs.polymarket.com/ (check latest CLOB API and settlement contracts)
8. https://docs.gmx.io/docs/providing-liquidity/ (GMX pool-level limits, reserve usage, price impact and ADL)
9. https://docs.gmx.io/docs/trading/liquidations/ (liquidation and auto-deleveraging)
10. https://docs.gmx.io/docs/trading/fees/ (imbalance-dependent fees and borrowing/funding)

Do not copy an address, chain ID, token contract, token precision, bridge route, or API shape from a blog into production without a live read-only assertion and testnet verification.

## 2. Trust architecture

```text
User wallet/UI ─── NEAR positions + risk ─── NEAR counterparty vault / bLP
                              │                        │
                              ▼                        ▼
                   approved market oracle       reserve + insurance
                              │                        │
                    PM prices / resolution      optional hedge budget
                                                       │
                                                       ▼
                                               strategy executor ── Polygon/other venues
```

**Trust model must be described honestly.** For **unhedged pool-mode positions**, opening does not require a Polygon token purchase or chain receipt; NEAR must still verify the user deposit, policy, risk reserve and admissible *external price oracle*. NEAR cannot infer Polygon order-book execution merely from a backend's assertion for optional hedges. A trusted/attested operator receipt is not a trustless Polygon inclusion proof. A stronger model requires a verified Polygon proof/light client, or explicit trust in a bonded/attested operator plus independent accounting. Disclose all assumptions.

No user funds should be bridged or transferred out of a contract before the exact chain, token, spender, approvals, and failure recoveries have been verified. Distinguish native NEAR-chain stablecoin assets from Polygon pUSD/USDC; document bridge conversion and accounting liabilities explicitly.

## 3. Onchain contracts — proposed split

Deploy independent contracts with typed interfaces and shared versioned IDs (or separate modules in a single deployable if asynchronous cross-contract invariants become too risky). The **release contracts and interfaces must be fixed by tests before UI implementation**.

### `basis.registry.near` — governance/configuration

- Authorizes vault, margin engine, oracle reporters, hedge executor keys, insurance, supported collateral, market adapters.
- Stores venue-neutral `market_id`, external venue/chain and event identifiers, ordered outcome/token set (not limited to YES/NO), settlement authority, approved execution adapter ID/version, pricing and resolution adapter IDs/versions, independent `MarketPolicy` hash and epoch, allowed-actions state, and its effective/expiry bounds.
- Market lifecycle states `UNLISTED`, `PENDING_REVIEW`, `ACTIVE`, `CLOSE_ONLY`, `SUSPENDED`, `RESOLVING`, `SETTLED`, `INVALID`. **State transitions are a result of approved policy evaluation and venue events, not hard-coded event classes or clock cutoffs.** A market policy can independently disable opens, increases, reduce, closes, or liquidations when a particular action is objectively impossible; inability to execute an exit must be disclosed, not hidden.
- The offchain policy service may propose/configure arbitrary new market classes and strategy adapters, but NEAR must enforce: allowlisted adapter/version and collateral, authenticated policy hash/epoch, accepted leverage/margin/fee bounds, available vault risk capacity, permitted action and expiry, and idempotent fill authorization. The service cannot bypass those invariant checks by changing a database row. Emergency restrictions may tighten live admission; no retroactive liquidation-price or borrower fee changes beyond the mechanism transparently accepted at entry.
- Timelocked mutable risk changes for live funds; emergency guardian can **only restrict** entry, stop withdrawal, or switch close-only, not withdraw assets or weaken solvency policies unilaterally. Separation of admin, risk council, guardian and executor.

### `basis.vault.near` — USDC accounting and bLP

- Accept selected NEAR-chain fungible collateral via `ft_transfer_call`; verify predecessor token contract, deposit value and attached data; no fake balance increments from arbitrary caller-provided numbers.
- Issues **bLP** shares using NEP-141-compatible mint/burn and transfer restrictions/registration where required. Fixed share precision with checked `u128` arithmetic; never use floating point.
- Track available liquid assets, posted user margin, current nonrecourse synthetic payout liabilities, **locked scenario-based worst-case user-profit reserves**, separate optional hedge capital, external vault-owned hedge inventory mark value, realized/unrealized hedge P&L, fees, pending withdrawals and insurance reserve. Payout reserves are encumbrances of LP capital, not automatically booked as current NAV losses; do not double-count. Do not invent borrower loan receivables.
- Share price `NAV / total_shares`, with NAV using conservative realizable valuation of external holdings and subtraction of liabilities, pending claims and expected costs. Never treat gross hedge notional as free collateral.
- `deposit`, `request_withdraw`, `settle_withdraw`, `cancel_withdraw`, `get_nav`, `get_available_liquidity`, `get_share_price`, `get_risk_summary`; use queued withdrawals or epochs so LPs cannot extract collateral while it backs open trades.
- Block LP withdrawal if it violates liquidity, worst-case stressed NAV, insurance minimum, or pending-hedge commitments. Initial deposits receive shares based on preceding conservative NAV snapshot. NAV disputes/valuation staleness pause mint/burn.
- Trading/holding/liquidation fees credited by explicit ledger entries, not simply assumed from an offchain receipt.

### `basis.margin.near` — orders, positions, nonrecourse accounting

- Isolated-margin **synthetic** positions (no cross-margin). User funds `M`; their synthetic claim's total cash value is floored at zero (subject to approved fees), with no +M profit ceiling; the event payout vector sets the finite maximum theoretical settlement on that isolated position. Users cannot be charged retroactive deficits. The vault owns any external outcome-share, perp, option, or basket hedges; users do not receive or owe a separately transferable venue share or loan.
- Create immutable `OrderIntent` signed by user: `{nonce, market_id, outcome_id, margin_amount, requested_leverage, max_entry_price, max_hedge_slippage, max_fee, max_lifetime, deadline, close_mode, allow_partial_fill=true, minimum_acceptable_fill_fraction, owner, policy_hash, quote_id}`. The UI defaults `allow_partial_fill` to true, exposes an obvious toggle to turn it off, and freezes the chosen value in the user's signature. Never infer opt-in from a missing legacy field; old clients require a canonical migration/explicit default. Unique nonce/domain separation and replay protection.
- `request_open`, `cancel_open` (before synthetic execution or irreversible optional hedge), `reserve_payout_capacity`, `finalize_open_pool`, `commit_hedge`/`finalize_open_hedged` only for approved hedge-required strategies, `request_reduce`, `finalize_reduce`, `request_close`, `finalize_close`, `post_margin`, `liquidate`, `resolve`, `claim`.
- Position record: immutable quote/hedge fill receipt, `Q_synthetic` reference exposure units, actual execution-weighted entry reference price, synthetic leverage `L`, accrued fees `F`, isolated margin `M`, nonrecourse payoff-terms version, outcome exposure, expiry, funding/fee snapshots, vault-owned hedge allocation/inventory receipt references, policy hash and epoch, state/version. `D=(L-1)M` may be a **virtual financing quantity used to compute leverage and fees**, but is *not* a user loan receivable or legal borrower debt. Partial fills scale synthetic exposure, effective margin, fees and hedge reservations to executed size; release unused user collateral, with user-selected minimum-fill and slippage constraints respected.
- States: **pool mode** `REQUESTED` → `RISK_RESERVED` → `OPEN`; **hedge-required mode** `REQUESTED` → `RISK_RESERVED` → `HEDGING` → `HEDGED_PROVISIONAL` → `OPEN`; either may then enter `REDUCING`, `CLOSING`, `LIQUIDATING`, `RESOLVING` → `CLOSED`, `LIQUIDATED`, `SETTLED`. Optional hedging can occur/rebalance *after* pool-mode open with separate risk permission and hedge-loss budget. Rejection/expiry/orphan handling is mode-specific. All transitions idempotent and authorized.
- A valid close settles the **nonrecourse synthetic P&L contract** at a current *admissible oracle-backed exit reference* and disclosed price impact/fees, even without an external hedge sale, provided oracle depth/freshness criteria pass and the vault remains solvent. An offchain quote alone must not mint gains without a verifiable oracle commitment and required execution delay/anti-manipulation controls. Separate treasury accounting records optional hedge proceeds/deficits. Partial close scales reference exposure, margin allocation and remaining reference exposure and margin proportionally. User receives full positive synthetic P&L under the signed payoff terms, irrespective of vault hedge gains.
- Settlement verifies the **same exact external market** and resolution rules as the hedged tokens, including invalid/canceled markets and delay/dispute periods; `resolved` is different from `redeemed`.

### `basis.oracle.near` — attested observations

- Separate typed reports for `MARK` (short-lived executable order book), `RISK` (conservative depth/volatility/market suspension) and `FINAL_RESOLUTION` (finalized venue contract outcome) with different authorization/finality requirements.
- Report fields `{report_id, market_id, source_chain, observed_block, source_timestamp, fetch_timestamp, best_bid, best_ask, depth_by_level, execution_size, fee_schedule_version, tick_size, market_status, source_hash, attestation_ref, valid_until}`.
- An API midpoint or last trade is **not** necessarily executable. Use depth-weighted executable bid for liquidations and actual ask for new hedge cost. Guard stale reports, extraordinary spread, missing depth, missing time/source, conflict, report replay, outliers and front-running.
- Use OutLayer or Shade attested compute to fetch and normalize data and sign hashes, but explicitly document source authenticity and quorum/second-source checks. TEE calculations cannot substitute for proof that an external onchain resolution finalized.

### `basis.insurance.near` — loss buffer

- Segregated ledger/contract with explicit funded balance; allocate an owner-approved share of fees plus optional seed capital. Coverage is **finite**, never guaranteed.
- Loss waterfall: remaining trader margin → eligible insurance balance → vault LP NAV impairment. When capacity threshold breached, new openings are suspended and close/reduce remains possible.
- Insurance cannot be counted simultaneously as free vault liquidity. No hidden inflation of bLP to cover losses.

## 4. Offchain services and interfaces

**Suggested stack:** Rust NEAR contracts + Rust/TypeScript worker services; TypeScript Next.js or Vite dashboard; PostgreSQL for indexed read models and execution reconciliation; Redis optional ephemeral queues; event-sourced immutable ledger/outbox; WebSockets for market data; no database becomes an accounting authority over onchain ledger. Containerized dev/test environment; pinned package versions; OpenAPI and generated clients.

Services:

1. **Market discovery:** ingest external venue metadata, outcome mappings, market rules, status, books, fees, tick sizes, resolution sources and event metadata by pluggable venue adapters. Market coverage is *data/config driven*, never a whitelist of category strings compiled into NEAR code. New market IDs can be approved without deploying contracts if they use an existing vetted adapter and policy schema.
2. **Market-policy/strategy registry:** maintain signed, typed, versioned `MarketPolicy` and `StrategyProfile` manifests. Market-specific profiles choose risk model, leverage policy, pricing source, opening/reducing restrictions, volatility/event jump windows, maintenance/liquidation curve, max fill size and financing rate. Operators may select an audited execution algorithm from a registry; new arbitrary offchain strategy code requires tests, review, a pinned build hash, least-privilege signer capability and explicit activation. Publish manifest hash and human-readable restrictions to NEAR and to the user *before order signing*. Emit every policy update; pin the opening position's fee and liquidation semantics against retroactive surprise.
3. **Quote/risk service:** calculate admissible mark at requested size, synthetic P&L sensitivity and instrument-derived maximum theoretical payout, user-signed partial-fill minimum, dynamic spread/impact, fees, utilization, required **incremental LP scenario reserve reflecting full possible winning P&L**, optional external hedge budget and scenario stress; expose signed, expiring quote and full reason codes. Refuse if either policy/oracle is stale or onchain risk budget cannot be reserved. No external purchase is required to quote a pool-backed position.
4. **Execution/market adapter registry:** typed `discover_market`, `validate_market`, `get_orderbook`, `get_mark_evidence`, `quote_buy`, `quote_sell`, `execute_buy`, `execute_sell`, `get_fill_receipts`, `get_vault_hedge_balance`, `get_resolution`, `redeem` operations. An initial `polymarket_ctf_polygon` adapter is generic for supported CTF events in any category. Strategy families: (i) **POOL_ONLY**: fully reserve bounded user profit, no external hedge order, (ii) **POOL_PLUS_HEDGE**: open against LP reserves then optionally hedge portfolio net exposure, (iii) **HEDGE_REQUIRED**: do not open until a configured hedge fills, using the older cross-chain handshake. BTC perps or rates futures are **not exact hedges** for binary events; bound their basis and liquidation risks separately.
5. **Execution coordinator:** sign and submit bounded venue orders with FOK/FAK or tested equivalent, respect spreads, deadlines, approvals, venue eligibility and size caps; store actual fills, fees, tx hashes and confirmations. No funds are transferred to an unreviewed strategy, plugin, or endpoint. Signer policy restricts markets, tokens, spenders, size, total time-bound exposure and allowed methods.
6. **Reconciler:** compare NEAR nonrecourse synthetic liabilities, incremental reserved payout capacity and *optional* vault-owned Polygon hedge holdings/trades. In `POOL_ONLY`, zero external shares is expected, not an error; in `HEDGE_REQUIRED`, missing required shares blocks opening. Detect double booking, missing receipts, orphan hedge fills, wrong outcome, and reverted transaction. Freeze opens on genuine mismatch.
7. **Oracle/TEE worker:** compute canonical reports via market-specific pricing and finality adapters; pin WASM hash, measurement, data source, timestamps and verification receipt. Must never use an LLM to decide liquidations, settlement, or collateral amounts.
8. **Risk keeper:** watches maintenance equity, venue suspensions and per-market configured event gates; attempts liquidation permissionlessly or via bonded executor. Idempotent retries, bounded partial liquidation, no infinite cancel-replace loops.
9. **Indexer/UI API:** read-only analytics and authenticated user quote submission; render the precise currently applicable policy, including when a user can enter, reduce, exit and be liquidated; never expose signing keys through frontend.

### Dynamic market policies and boundaries

Each market is represented by `MarketDescriptor {venue, chain, external_market_id, outcomes[], underlying_event, outcome_payout_rules, resolution_adapter_id}` and a separately controlled `MarketPolicy {schema_version, policy_hash, risk_model_id, executor_adapter_id, observable_inputs, allowed_actions, session_windows, event_relative_windows, leverage_curve, maintenance_curve, sizing_caps, liquidity_guards, oracle_freshness_rules, settlement_rules, fees, governance_approval, activation_epoch}`. The descriptor and policy are data, so *elections, sports, Fed decisions and crypto are not privileged primitives in the engine*. The contract still verifies the policy hash, signed risk quote and hard loss/collateral invariants.

Configurable action policy examples (not defaults): `OPEN` sports in-play only when venue executable depth, fresh injury/score data and stress limits permit; `CLOSE_ONLY` around a volatile catalyst; election positions open until a specified verified event phase; rates markets priced using their exact event payoff and approved sources. Event status/timing comes from a named, authenticated data feed with staleness and missing-data fail-safe behavior. Per-market policies and permitted updates are visible on the trading screen and permanently recorded with each position. A blanket calendar cutoff is *not* permitted in core contract logic.

Do not let the offchain service claim unlimited authority: a new strategy cannot supply arbitrary `profit`, `margin`, `NAV`, or `resolution` numbers to the NEAR contract. Supply typed receipts and a previously approved strategy hash; reserve and liquidation validators enforce a bounded calculation domain. Reject unknown adapter versions and malformed outcome/payoff schemas.

### Economic model — DECIDED: nonrecourse synthetic leverage, uncapped positive P&L relative to margin

**Chosen B. Vault as direct counterparty to a synthetic user claim.** The trader locks `M` and receives nonrecourse leveraged price exposure with equity floored at zero, **not capped at 2M**. Full positive P&L belongs to the trader until voluntary exit, user-configured take-profit/stop, valid liquidation, or final event settlement. External outcome shares, if any, belong to the vault. Without hedges, the vault pays all positive P&L; with hedges it owns their profit and loss separately. The vault must price and reserve the full possible payout, not assume profits stop at +M.

**Rejected for v1 A. Direct borrower margin loans.** If implemented in the future, this would give the trader a beneficial venue-share position pledged as debt collateral. That is *not* the current model. Do not create user loan accounts, transfer venue shares to user accounts, or assume liquidation equals recovery of a secured loan. Preserve this model only as a future extension requiring different accounting and legal analysis.

**Implementation invariant:** do not mix future A's legal loan claims with B's synthetic user liabilities. The entire vault is never indiscriminately traded on a user's behalf: a strategy must reserve a bounded amount of free vault capital before acquiring its *vault-owned* hedge, and reconcile actual exposure and payout obligations. Synthetic contract claims must remain payable from verifiable vault/insurance capital even when a hedge execution or cross-chain callback fails.

### GMX-style pool-fill protocol (proposed default)

1. User selects event/outcome, margin `M`, leverage `L`, optional take-profit/stop controls and signed partial-fill preferences. Show 100% maximum loss and full event-derived potential gain, event-specific restrictions, market oracle and policy version.
2. Offchain risk and price adapter prepares a signed, short-lived *admissible* quote with mark evidence, executable-depth threshold, price-impact spread, fee bounds, risk-limit reasons and fee/cap timing. Use an order-commit then oracle-observation/execution separation, as GMX does, to reduce last-look and oracle front-running; never use the user's pre-commit stale price as guaranteed execution.
3. `basis.margin.near` locks deposited `M`, requests `basis.vault.near` to reserve up to **the full worst-case winning trader P&L (which may exceed `M`)** (plus separately quantified costs) and verifies event concentration, portfolio scenarios, available LP capital, oracle source validity and position capacity. If free capacity permits only a partial order, fill the permitted fraction when user opted in; otherwise decline without a Basis-AMM order book.
4. Contract executes the synthetic fill at the verified rule-conforming price/size, emits immutable position and corresponding event-derived maximum payout/reservation commitments, and releases unused funds. **No Polymarket shares need to be bought**, and the user is not waiting for a Polygon transaction in `POOL_ONLY` mode.
5. Keeper and risk engine continuously monitor obligations, Oracle/data integrity, time to catalyst and market status; user closes at an admissible current oracle, with dynamic spread and market-specific protective rules. When possible, liquidate before equity reaches zero; price jumps can skip levels, but user and vault payout bounds are still explicit.
6. At event finality, settle synthetic contract against the exact official event outcome; pay user full nonnegative synthetic equity less applicable fees and release remaining reserved capacity. Optional treasury hedges are separately sold/redeemed/reconciled and impact LP NAV, not the user's maximum claim.

### Optional hedge-required protocol (only when market policy demands it)

1. UI obtains short-lived **indicative** quote; user signs exact slippage/fee/leverage/deadline bounds and market `HEDGE_REQUIRED` flag.
2. NEAR margin contract verifies user deposit, nonrecourse synthetic payoff policy and aggregate risk capacity and **reserves** bounded vault hedge and contingent payout capacity (no open position yet).
3. Approved venue executor receives an authorized, expiry-bounded instruction; acquires the **vault-owned** exact-event outcome shares or other explicitly approved hedge inventory. Must not execute outside signed price, size, adapter or risk bounds. A user is not an external venue-share owner.
4. Executor publishes fill evidence (`order_id`, fill IDs, amounts, price, fees, Polygon tx hashes, verified receipt references), and independent reconciler confirms custodian balances. No blind operator `success=true` assertion.
5. Margin contract finalizes exactly once with actual fill evidence under its chosen trust/proof model and creates a **nonrecourse synthetic** OPEN position. Lock the corresponding maximum synthetic payout and risk-capital reservation; release unused funding reservation.
6. **Partial-fill default ON:** if execution fills at least the user-signed minimum fraction and respects total fees/slippage, activate only the filled proportion. Adjust synthetic exposure, effective margin, dynamic payout liability and vault-owned hedge allocations proportionately; release unused collateral and funding authorization. If user turned partial fills OFF, use venue-supported all-or-none execution where available or reject/unwind (the system cannot guarantee the unwind price); do not convert a partial execution into a full position. If fill is below user-signed minimum, follow explicit reject/unwind/cost allocation policy. No residual order rests on a Basis-AMM order book. **For POOL_ONLY, partial fills are reductions based on available risk capacity, not external token fills.**
7. Hedge succeeds but NEAR finalization fails → `HEDGED_PROVISIONAL`, keep capital reserved, retry finalization or unwind hedge, do not mint a user claim twice. If user abandoned or expired, deterministic compensation/return rule required.

This process is **not atomically cross-chain**. Prove that the user cannot be charged more than signed margin/fees and the vault cannot be committed twice on retries.

## 5. Risk and solvency mathematics

Represent each synthetic reference in units of the **selected underlying outcome's payout claim**, determined by the venue adapter, with an independently owned hedge allocation. For binary YES/NO, YES exposure tracks YES and NO exposure tracks NO. For multi-outcome markets, adapters must prove payout exclusivity, full payout vector, fees, token mapping, invalid/dispute rules and collateralization before listing. Avoid unsupported naked shorts; a "short YES" button maps to a specific approved instrument with an exact, disclosed payout function. An instrument is not admissible merely because its metadata looks like a binary market.

Let `M` = user isolated margin, `L` = quote leverage, `N=L M` = initial synthetic reference notional, `p0` = locked executable entry reference price in `(0,1)`, `Q=N/p0` = **synthetic reference units**, and `F(t)` = disclosed charge accrued. `N-M` may be used to calculate holding fees, but is a **virtual financing base**, not a legal claim against a borrower.

Conservative executable-close equity using depth-weighted reference bid `b(Q)` after estimated synthetic/hedge unwind costs `C(Q)`:

`raw_PnL = Q * (b(Q) - p0) - C(Q) - F`

`E_user = max(0, M + raw_PnL)`; `user_profit = E_user - M`, bounded below by `-M` **without a +M ceiling**. For binary outcomes, final payoff in `[0,1]` still yields a finite event-derived bound: `max_user_profit_before_fees = Q*(1-p0) = L*M*(1-p0)/p0`; `max_total_user_payout = M + Q*(1-p0)`. Use the exact approved payout vector for nonbinary instruments. Partial closes must preserve the economically correct remaining exposure and **must never reinstate a +100% gain ceiling**.

**Example, before fees:** `M=$100`, `p0=$0.50`, `L=5x` gives `N=$500`, `Q=1,000` YES units. At `$0.60` the trader has **+$100 profit and may remain open**; at YES resolution `$1.00`, profit is **+$500** and total payout **$600**. At NO resolution `$0.00`, the trader receives `$0` and cannot be charged beyond their `$100` margin. An unhedged vault bears the full `$500` winning-trader transfer. A vault hedge of 1,000 YES shares costs `$500`: it earns `$500` if YES wins, but loses `$500` if NO wins, offset by only `$100` forfeited margin, leaving approximately `$400` vault loss before costs.

**Pool-only reserve:** A `$100`, `5x`, `$0.50` binary long needs up to **$500 of additional LP profit-loss capacity**, plus protective costs and portfolio stress headroom—not `$100`. Trader margin is already held and must not be counted twice as LP risk capital. Actual vault exposure is scenario-based and may be mitigated by separately accounted hedges; neither hedge purchases nor an assumed margin cap may substitute for capital sufficiency.

**GMX-inspired reserve rule (proposed):** For an unhedged binary outcome, `max_positive_trader_PnL = L*M*(1-p0)/p0` and `max_cash_payout = M + max_positive_trader_PnL` before charges. Reserve the **maximum incremental LP loss** across relevant terminal and intermediate paths, plus liquidation costs, fees owed and correlation buffers. A same-outcome hedge changes both winning and losing states, so compute net risk across trader claim **and** hedge rather than blindly subtracting hedge notional. Hard gate each open on available free capital and per-event/portfolio solvency budgets.

**Portfolio stress rule:** For each allowed price path/scenario `s`, compute `TraderPnL(s)=Σ(E_i(s)-M_i)` using **unclipped positive** equity, `HedgePnL(s)` for actual vault-owned inventory including liquidation/basis failure, and `Costs(s)`. `LP_Loss(s)=max(0,TraderPnL(s)-HedgePnL(s)+Costs(s))`; reserve `R=max_s LP_Loss(s)` over correlated paths. In the example, unhedged maximum direct loss is `$500`; exact-share same-direction hedge can reduce winning-state losses to near zero but create `$400` adverse-state loss. Do not net incompatible settlement instruments or assume perfect hedge execution.

**GMX-style controls:** Configured per-market/side open interest and max-payout liability limits; reserved-capital utilization; spreads and impact reflecting adverse selection; market-specific financing/holding fees; `CLOSE_ONLY` when fresh capacity is insufficient; and liquidation keepers triggered by inadequate **losing-position** maintenance equity. **Do not forcibly close a profitable position at +100% (or any profit multiple), and do not include discretionary profitable-position ADL in v1.** Risk managers must constrain *new* trades, leverage and withdrawals before solvency deteriorates; any future mandatory profitable close would require explicit product-owner authorization and a disclosed contract redesign.

**Fair-pricing stop gate:** For binary YES at `$0.80`, `M=$100`, `L=5x` yields `Q=625`. YES settlement pays `$225` total (**+$125** trader gain), while NO settlement pays `$0` (**-$100**). At a naive implied YES probability of 80%, the trader's expected P&L before fees is `0.8*125 - 0.2*100 = +$80`, i.e. vault expected loss `$80`. This is not automatically an arbitrage—marks need not equal true outcome probabilities, and the liquidation/fee/exit paths matter—but is a strong warning against selling naive leveraged nonrecourse exposure without risk-adjusted quoting. Reject quotes that fail fair-value and solvency tests.

**Profit treatment — DECIDED:** There is **no mandatory +100%-of-margin profit take**, no plateau in positive P&L and no operator-initiated profitable close/ADL in v1. Traders may submit explicit user-chosen take-profit orders, and positions otherwise remain live subject to normal risk/liquidation rules until user exit or event settlement. Liquidations apply to losing positions whose executable maintenance equity breaches approved terms.

**Pricing warning:** `max(0,M+raw_PnL)` creates **nonrecourse leveraged exposure with a downside floor and full upside to the instrument payout**, not a symmetric leveraged bet. The embedded loss floor has value; naive `L×spot` exposure is not guaranteed fair and can systematically harm LPs. Price entry/exit, optional hedge risk, bankruptcy gaps, liquidity and early exercise under an explicit expected-return and stress model.

**Liquidation trigger** (new model; thresholds to calibrate): base maintenance on **uncapped signed synthetic equity**, actual cost to unwind vault hedges, market-specific jump risk and a cash maintenance buffer; liquidation must occur before the zero user-equity floor when executable. The old secured-loan formula is **not valid** under synthetic nonrecourse payouts. Use executable depth, not TWAP alone; TWAP is an anomaly/risk reference. No deterministic liquidation price guarantees fills.

**Tick sensitivity** (illustrative): for binary tick `δ`, a tick moves raw P&L by `Q*δ=(L*M/p0)*δ`. Ignoring fees/maintenance, roughly `k_loss=p0/(L*δ)` adverse ticks consume initial margin. **No corresponding `k_cap` favorable-tick stop exists**. Actual leverage must pass price precision, depth, event-jump, maintenance buffer and available vault-capital tests. One-cent ticks do not prevent instant multi-tick gaps.

For a binary reference mark with tick `δ`, each tick changes raw synthetic P&L by `Q*δ=(L*M/p0)*δ`. Ignoring fees and maintenance, roughly `k_loss=p0/(L*δ)` adverse ticks consume deposited margin. **There is no favorable-tick profit-cap barrier.** A target of at least `k` adverse ticks supplies only an illustrative sensitivity ceiling `L <= p0/(k*δ)`. Apply maintenance, depth, stress, event jumps and capital capacity. Actual `L <= min(L_protocol_safety, L_market_policy, L_tick_sensitivity, L_depth, L_stress)`. Tick precision does not limit sudden multi-tick jumps.

**Jump stress:** value both (a) vault-owned hedges' path-dependent P&L and (b) the **full nonrecourse trader claim without any upper profit clamp**. Exact same-outcome share hedges can offset the trader's unlimited-in-margin upside but leave `(L-1)*M` downside in an adverse terminal outcome; proxy and partial hedges add basis and execution risk. Before opening enforce:

- `incremental_stress_loss(candidate | portfolio) <= free_stress_budget`, including both YES and NO terminal outcomes, liquidation slippage and custody/basis failures;
- `R_event_used + incremental_loss <= R_event_cap(V, I, market)`;
- `R_global_used + incremental_loss <= R_global_cap(V, I)` under grouped correlated scenarios, not sum of independent percentages;
- `vault_hedge_cost + synthetic_payout_reserve + fees + cash_reserve <= appropriately_available_assets` **under a consistent asset/liability accounting basis**; prove asset conservation and no double counting of user margin, hedge assets, user payable claims or insurance;
- `market_depth_for_exit >= required_fraction * Q` under explicitly measured worst-case spreads (otherwise reject/reduce leverage).

Illustrative **not production-approved** `$100,000` vault sandbox: single-event stress budget 2% NAV = `$2,000`, portfolio stress budget 10% NAV = `$10,000`. At `p0=$0.50`, `L=5x`, an **unhedged** `$500` margin position has max winning-trader P&L `$2,500`, so it **fails** the `$2,000` event budget; at `$100` margin max positive P&L is `$500`, before costs and existing exposure. An exact-share hedge may change the limiting scenario to the unfavorable event, with `(L-1)*M` loss before costs. Limits require calibration before real funds.

**No internal matching:** every synthetic user fill is against the **Basis-AMM counterparty vault**, not a matched opposing Basis-AMM user. An external venue hedge fill occurs only when the chosen strategy requires it. For portfolio stress purposes the risk engine may account for correlated/offsetting economic exposures, but that is analytic aggregation, **not** internal order matching, an order book or cross-user pledge of collateral. Never label a book delta-neutral solely because YES and NO notional counts match; model path-dependent liability and optional hedge exposure.

**Per-market action gates:** Entry, increase, reduce, close and liquidation eligibility are derived from the current approved policy, venue status and freshness. Examples: high-frequency crypto may admit only small low-leverage positions if an executable book survives stress; an in-play sports market may remain open under a low-risk policy, or close to new entry around volatile action; an election market may offer long holding periods with wider financing and event-proximity buffers; Fed meeting or CPI contracts may have jump-catalyst windows. None is universally included or excluded in contract code. No policy may prevent users from claiming finalized settlements or adding safety collateral while technically possible.

## 6. Fee contract

Separate **fee assessed**, **fee collected**, **fee allocated**, and **owed fee** states. Default fee dimensions, each product-owner approved:

- Open `F_open = notional * rate_open + pass-through execution cost`, bounded by user-signed maximum and actual receipt.
- Close `F_close = realized proceeds * rate_close + pass-through execution cost`, never exceed remaining proceeds or create user debt.
- Synthetic exposure/holding `F_hold = V * r_annual(time, utilization, concentration, event_risk) * elapsed_seconds / seconds_per_year`, where `V` is a clearly disclosed *virtual* financing/exposure fee base defined by the approved policy (for example `max(0,(L-1)M)`), **not a real user loan**. Computed with fixed-point accumulation and anti-retroactivity snapshots.
- Risk premium `F_risk` quoted **before open**, based on measured stress budget use, concentration, and liquidity; cannot make a prohibited position admissible.
- Liquidation reward from positive residual equity only, bounded by fixed and percentage caps, with separately funded keeper subsidies if necessary.

Split collected fees among LP NAV, insurance funding, protocol treasury and actual executor fees per versioned distribution parameters. Do not promise fee yield until after hedge costs, bad debt, and impairment. Support rebates/discounts only if specifically approved.

## 7. LP token and withdrawals

**Initial design: one transferable `bLP` share token** representing residual claim on vault NAV, not a stablecoin or promise of positive return. Provisional token symbol pending collision/trademark review. A second senior/junior tranche is **out of v1** unless owner explicitly chooses otherwise.

`NAV_LP = liquid_assets + conservative_vault_owned_hedge_value + verified_collectible_assets - current_synthetic_user_payout_liabilities - external_payables - queued_LP_withdrawal_claims - expected_hedge_unwind_costs - segregated_insurance_claim` on **one consistently defined balance sheet**. User-posted margin increases cash assets but is not LP profit: the corresponding synthetic user claim is a liability. At inception a fair, zero-fee position should not magically raise LP NAV merely from receiving margin. Do not count a hypothetical user loan receivable; no such loan exists. Independently reserve worst-case scenario capital on top of current book-valued liabilities. `bLP_share_price = NAV_LP / circulating_supply`. Include negative NAV insolvency controls, stale hedge marks, disputed settlement and insurance segregation; prove conservation numerically at every state change.

Withdrawal requested → queued until settlement or enough free capital; never redeem against LP capital currently **reserved to fund nonrecourse synthetic payouts or optional hedge losses**. Determine liquidity haircut/fee at request and payout with signed min-out; prevent withdrawal bank-run pricing advantage by freezing on stale NAV. Bankruptcy waterfall must explicitly identify bLP exposure.

## 8. User flows and UI

Visual direction: restrained white/black/gray typography, no unnecessary borders, minimal chrome; dark mode optional. Panels: Markets, Trade, Positions, Vault/bLP, Activity, Risks (public transparency), Protocol Health, Admin/Risk.

- Markets: any *admitted* event category, configurable outcome choices, start/end, price, executable depth, dynamically offered leverage, fee preview, `OPEN`/`CLOSE_ONLY`/`SUSPENDED`, resolution source and explicit plain-English reason for restrictions.
- Market rules sheet (available **before** entry, linked from each asset): current approved policy version, allowed entry/exit windows, whether event is in-play, max leverage and why it may shrink, fees, margin, close/stop execution guarantees/limits, event-specific resolution/dispute rules, user maximum loss and risk status. Show effective time and relevant restrictions on every trade confirmation and in the position detail even after policy versions change.
- Trade composer: margin, dynamically constrained leverage slider, fill range, **partial fills ON by default with opt-out**, estimated liquidation threshold, **max loss = posted margin**, **potential profit and total payout computed from the instrument's final payoff and entry quote** (not 2× margin), fee/holding-rate preview, jump-risk warning and quote expiry. Show that +100% gain does not automatically close the position.
- Positions: actual weighted reference entry, synthetic exposure units, margin, event-derived theoretical maximum payoff on **remaining exposure**, executable mark, full positive unrealized equity without a +M cap, accrued fees, liquidation threshold, optional user-chosen stop/take-profit triggers, partial close, add margin and close; distinguish indicative from executable values. No UI implies the user owns the vault's external hedge shares.
- Vault: bLP share price, NAV and components, free vs reserved liquidity, insurance coverage, event concentration, stress-loss budgets, realized fees/losses, withdrawal queue and claim status.
- Errors: `MARKET_CLOSE_ONLY`, `PRICE_STALE`, `HEDGE_REJECTED`, `PARTIAL_FILL`, `RISK_LIMIT`, `SLIPPAGE`, `LIQUIDATION_PENDING`, `ORACLE_DISPUTED`, `SETTLEMENT_PENDING`, `VAULT_PAUSED`, `POLYGON_RECONCILIATION_FAILED`.

No UI may claim an OPEN position before NEAR finalization and applicable policy/price/risk-reserve checks; **hedge confirmation is required only in `HEDGE_REQUIRED` mode**, never in `POOL_ONLY`. No UI may label the pool risk-free or guaranteed delta-neutral.

## 9. Data models and API contracts

Canonical typed structures: `MarketDescriptor`, `OutcomeInstrument`, `MarketPolicy`, `StrategyProfile`, `AdapterVersion`, `PolicyApproval`, `OrderIntent`, `Quote`, `ExecutionInstruction`, `ExecutionFillReceipt`, `SyntheticPosition`, `NonrecoursePayoffTerms`, `VaultHedgeAllocation`, `SyntheticLiabilityLedger`, `VaultLedger`, `InsuranceLedger`, `RiskConfig`, `OracleReport`, `RiskDecision`, `LiquidationAttempt`, `FinalResolutionProof`, `LPDeposit`, `LPWithdrawal`, `GovernanceAction`, `AuditEvent`. **Do not implement `LoanLedger`, borrower debt or user-pledged venue collateral in v1.** The core schema must not contain a switch statement limited to crypto/sports/election, nor a binary-only side enum in its externally versioned abstract instrument interface.

Require stable IDs and explicit chain/domain in every external reference. All money/price arithmetic fixed-point integer with declared decimals; reject overflow, underflow, negative prices, NaN-style serialization, stale nonces and rounding benefiting an adversary. Events are append-only, replayable, and linked to chain transaction hashes; offchain projections reconcile to onchain state.

Expose REST/OpenAPI + WebSocket read model for UI and workers. Write requests prepare wallet transaction, never pretend a backend HTTP response replaces user consent or blockchain finality.

## 10. Safety, legal and operational gates

- **Nonrecourse user margin:** no user debt beyond isolated posted collateral. User losses include only separately authorized upfront fees; additional margin never drawn automatically.
- **Synthetic event-derived payout:** show leverage and effective P&L sensitivity, margin, unlimited-in-margin profit potential up to the event's finite payout limit, maximum loss `-M`, and event-derived payout maximum. Hedge shares remain vault-owned. There is no loan receivable, debt collection or recourse beyond margin; trader receives the complete synthetic formula payoff but has no separate claim to unrelated vault hedge profits.
- **Policy transparency:** human-readable and machine-verifiable market rules are always presented before user signature; changes are versioned, attributed, auditable and pinned to each affected position. A fresh quote cannot silently switch to a new adapter/risk model after the signature; emergency halts are explicitly logged.
- **Oracle security:** stale/incomplete/disputed reports block new openings. Independent finalized settlement proof uses actual underlying venue adjudication, not arbitrary offchain TEE opinion.
- **Executor custody:** multisig and allowlisted bounded spenders; automatic circuit breakers and daily exposure caps; proven key rotation and emergency evacuation; no admin with unlimited user-fund withdrawal permission.
- **Market and regulatory eligibility:** jurisdictional and age gates, sanctions, collateral/custody and derivatives/exchange legal analysis before offering to real users. Demo on testnet and synthetic funds; no real-money launch without counsel and security audit.
- **Chain failure recovery:** external fill success + NEAR failure, NEAR intent success + Polygon failure, stale quote, partial fill, reorg, bridge pause, duplicate keeper action, oracle timeout, disputed finality, RPC compromise, rapid multi-tick jump, gap to $0, insurance exhaustion, high correlation, withdrawal run.
- **Emergency:** guardian `pause_opens`, `pause_market`, `set_close_only`, `pause_lp_mint_burn`; cannot confiscate balances. Document recovery, backfill and audit trail.

## 11. Verification plan

### Unit/property tests

Fixed-point math, slippage and fee bounds, precise settlement, all state transitions and idempotency; **user loss floor at -M and full uncapped profitable P&L** under opening/closing/resolving/partial fills; no counterfeit bLP; conservation of assets across transfers; fee accrual; user margin isolation; synthetic liability and LP NAV invariants; loss waterfall; permissions; nonces; zero shares/zero supply cases. Invariants: no loss beyond posted margin; winning settlement must equal payoff formula without an artificial +M clamp, no negative user balances, no phantom user loans, no double-counted hedge gain, no LP NAV increase just from margin deposit.

### Adversarial tests

- Hedge fills at unexpected price, different market/token, stale block or insufficient depth.
- Duplicate or forged operator receipt; Polygon reorg; NEAR callback delayed/replayed; partial and orphan fills.
- Mark manipulation and thin-book wash trades; 1-cent tick does not cap multi-tick jumps; sports gap to zero.
- Correlated opposing YES/NO exposures (even without internal order matching), limited-liability failures, and fee reserve depletion.
- Add a completely new election market and Fed-rate market through validated adapter/manifest configuration alone, with no redeployment or market-category code changes; reject market if its payout vector/settlement semantics are not proven.
- Valid partial execution with default-on settings, minimum-fill bound, **proportionally scaled synthetic notional, margin and event-derived payout maximum**, unused reservation refund; explicit default-off all-or-none rejection and venue partial-fill unwind; changed policy hash during an in-flight fill.
- LP withdrawal during open reserve, delayed oracle/settlement, market cancellation, event adjudication dispute.
- Keeper front-running, liquidation loops, over-liquidation and gas/execution failure.

### Historical backtesting and simulation

Use actual quote/depth/trade timelines (not chart-only bars), event schedules/outcomes and conservative unavailable-order-book assumptions. Compare margin-financed exact-share escrow, vault-owned exact-share hedges, supplementary correlated-asset hedges, and cash reserves **as separate controlled strategies**. Do not simulate internal trader matching. Stress binary and multi-outcome catalysts across sports scores, election reports, Fed decisions and crypto moves. Track: realized net NAV, worst jump shortfall, bankruptcies per 10k trades, peak loss, CVaR, liquidity coverage, keeper success latency, execution costs, LP APY net of impairments, fee decomposition, and trader utility. No production cap derived solely from a synthetic backtest.

### E2E acceptance demo

1. Deploy contracts on NEAR testnet; register synthetic/allowlisted market and deploy mock Polygon hedge executor.
2. Deposit vault liquidity, mint bLP, show free/reserved liquidity and insurance accounting.
3. Open a `5x` YES `POOL_ONLY` position at `p0=$0.50` with `$100` user margin and **$500 gross maximum LP profit reserve** (plus buffers), no Polygon hedge; prove onchain reservation, quote integrity and fee accounting. Separately exercise `HEDGE_REQUIRED` reconciliation.
4. Update price and show dynamic margin/liquidation trigger; show early close, stop and take-profit with executable bids.
5. Simulate NO resolution at `$0.00` (trader loses `$100`) and favorable mark `$0.60` (trader +$100, **position remains open**) followed by YES resolution `$1.00` (trader +$500, total payout `$600`). Show unhedged LP counterparty loss `$500` at YES; contrast exact-share hedge and its downside loss `$400` at NO, before costs.
6. Open opposing YES/NO user orders **via separate venue fills**; show no internal matching, and demonstrate correct combined stress/liability exposure.
7. Admit a sports event and an election or Fed-decision event via offchain market policy without deploying a new NEAR contract. Configure different action restrictions, then alter a policy to `CLOSE_ONLY` during a catalyst while accurately disclosing the current rule and retaining the version bound to previously opened positions.
8. Show partial venue fill default ON, actual executed exposure/margin/dynamic payout-liability scaling and unused margin refund; default-OFF all-or-none rejection/unwind. Verify trader loses no more than posted margin and can profit **more** than it; refuse stale/tampered policy.
9. Verify Oracle TEE measurement/provenance and show that it does **not** substitute for source truth.
10. Exercise orphan execution, stale mark, failed callback, settlement dispute and paused withdrawals.
11. Load `$0.80` YES, `$100` margin, `5x` leverage: verify `$125` winning-trader profit, `$225` winning payout, `$100` losing margin, and naive implied-probability expected trader gain `$80`; fair-price engine must reject or reprice adverse-to-vault terms.
12. Show `$100,000` synthetic pool: demonstrate that reserves depend on `L`, `p0`, full event payout and optional hedge P&L, not a constant `M`; enforce event/portfolio stress capacity and reject manipulated shallow-book marks.

**Hackathon minimum if real Polymarket hedge is not technically available:** honest demo with NEAR testnet contracts + deterministic mock executor, explicit labeled integration gap. Never present simulated fills as production real fills. A live validated Polygon execution/receipt path is a separately required milestone before public production.

## 12. Suggested monorepo

```text
basis-amm/
  contracts/
    registry/ vault/ margin/ oracle/ insurance/     # near-sdk Rust
  crates/
    basis-types/ basis-math/ basis-risk/ basis-oracle/
    basis-reconciliation/ basis-executor-contracts/
  services/
    venue-adapters/ policy-registry/ quote-engine/ executor/
    oracle-worker/ risk-keeper/ reconciler/ indexer-api/
  adapters/
    polymarket-ctf/ mock-venue/                  # typed exchange + custody interface
  policies/
    examples/                                    # examples, never compiled market restrictions
  apps/web/                                       # TypeScript frontend
  schemas/                                        # versioned typed IRs/OpenAPI
  tests/
    near-sandbox/ polygon-mock/ adversarial/ e2e/
  research/
    market-data-backtests/ scenarios/
  infra/
    local-dev/ testnet/ monitoring/
  docs/
    threat-model.md risk-policy.md deployment.md
    integration-proofs.md deviations.md
  Cargo.toml package.json pnpm-workspace.yaml
```

## 13. Phased build and stop gates

0. **Evidence/contracts:** verify current NEAR SDK APIs, Polymarket contract/order API, token standards, Polygon custody model and settlement finality. Decide trust model and product-owner section 14. Gate: all assumptions recorded with testable source.
1. **NEAR vault/margin primitives:** fixed-point ledger, bLP, deposits, risk reservation, positions, simulated finalization. Gate: property tests and loss-cap invariants.
2. **Configurable risk engine:** typed and versioned market policy schema, category-independent risk constraints, market onboarding without contract deployment, **event-derived maximum synthetic payout reserve per position, per-event and portfolio reserve budget**, nonrecourse payoff fair pricing, dynamic maintenance, event controls, fees, insurance waterfall. Gate: an unhedged position reserves full possible winning P&L, a chosen hedge carries separate loss budget, and a clearly underpriced $0.80 YES claim cannot open just because reserves are sufficient.
3. **Pool counterparty execution and optional hedge adapters:** run `POOL_ONLY` end to end on NEAR testnet using an authenticated mock price/oracle without Polygon transactions; separately test `POOL_PLUS_HEDGE` and `HEDGE_REQUIRED` using the Polymarket adapter and reconciliation. Optional attested OutLayer risk reports. Gate: never require or misreport a hedge fill for pool-mode opening, and never allow an unbounded external hedge strategy to consume pre-reserved user payout capital.
4. **Liquidation/settlement:** keeper, early close, partial close, resolved outcomes, loss waterfall, LP withdrawals. Gate: gap-to-zero survives as accounted loss; user nonrecourse guaranteed by contract.
5. **UI and demo:** trading and LP UX; scenario panel, tests, documentation, testnet demo; optional production audit later. Gate: all demo actions and accounting traces reproducible.

## 14. **Product-owner decisions required before implementation freeze**

The implementing agent must **not decide these itself**. Joshua must approve choices, after which remove this section or mark each with binding answers and regression tests.

1. **MVP demonstration market set (without hardcoding support):** Which three or four *concrete* events should the first integration tests demonstrate? Candidate categories: a daily crypto event, a live/pregame sports event, an election, and a Fed-rate event. All use the same extensible market engine; the answer determines test fixtures/adapter priority, not a permanent whitelist.
2. **Market listing and rule authority:** Can an operator admit any event after running automated risk checks, or must Joshua approve each market? Who may edit offchain execution and leverage policies, what timelock/second approval is needed, and what changes may affect positions already open?
3. **Leverage policy:** No category-specific numerical constants in code. Do you want an absolute protocol safety ceiling configurable through timelocked governance (recommended) with stricter per-market risk policy, or only per-market caps? The actual offered leverage must always be constrained by the onchain loss budget, executable depth and approved liquidation curve.
4. **LP token:** single `bLP` (recommended) or senior/junior two-tranche structure; should bLP be transferable before external risk audit?
5. **Insurance:** initial seed reserve, min funding ratio, fee percentage allocation, replenishment and insolvency shutdown. Is it funded from vault TVL, external seed, or both? Decide whether to prohibit any market opening until insurance is funded.
6. **Vault-size and exposure caps:** agree provisional `R_event=2% NAV`, `R_portfolio=10% NAV` only for synthetic testnet; owner must authorize empirical calibration before production. Max % NAV to spend on hedge inventory and max individual trader margin are separate limits.
7. **Initial fee schedule:** opening, closing, borrowing APR, risk surcharge, keeper liquidation fee, insurance share and LP/protocol fee split. Choose whether keeper subsidy may come from insurance even with zero positive equity.
8. **Custody/execution:** controlled Polygon executor wallet (simplest MVP), OutLayer/TEE executor, or NEAR Chain Signatures + bounded signer. Which trust/custody model is acceptable in hackathon and eventual real-money product? If model A, custody must support lender-controlled collateral pledge and sale/redemption.
9. **Cross-chain collateral:** user/LP deposits native NEAR USDC (with selected token ID), bridged pUSD/USDC, or other supported token. Who bears conversion/bridge costs and risk? Can the vault hold hedge inventory on Polygon rather than inside NEAR?
10. **Partial execution — DECIDED:** Default ON with user opt-out; never activate greater exposure than actually executed. **Still open:** minimum allowed fill fraction (e.g. 25%/50%/user slider), whether the executor may attempt repeated child fills until deadline, maximum execution reservation duration, and who bears unavoidable losses if the user selected all-or-none but venue gave partial inventory before unwind.
11. **Internal opposing flow — DECIDED:** No trader-to-trader matching, no internal order book, no resting Basis-AMM orders. All synthetic positions are against the **vault**, potentially with independent optional external hedge trades. Opposite user exposures are accounted for together under scenario tests, not paired as counterparty fills.
12. **Early exit and liquidation:** market close/reduce only when executable; allow keeper partial liquidation or require full close? Should user-configured stop-loss/take-profit be best-effort market triggers (recommended), never guaranteed fills?
13. **LP withdrawals:** immediate when free liquidity allows and otherwise queued; withdrawal fees/epochs/maximum queue age? Who bears hedge-sale cost of emergency liquidity?
14. **Market pricing oracle trust:** one attested TEE + independent safety source for MVP, or threshold independent reporters; should a default price staleness threshold (e.g. 3 sec) be stricter for crypto than sports?
15. **Market resolution handling:** should disputes/invalid markets freeze all settlement, or allow provisional claims subject to clawback? Recommended: do not settle until finalized and redeemable.
16. **Upgrade/governance model:** immutable contracts with migration, upgradeable timelocked governance, emergency guardian powers, admin keys and disclosure. Decide what may be upgraded while user positions exist.
17. **Deployment intent:** (A) hackathon **testnet/synthetic only** (recommended), (B) limited mainnet funds after independent audit/legal review. Jurisdictional restrictions, venue terms and derivatives registration require professional legal work before public deployment.
18. **Brand/token naming:** adopt `Basis-AMM` / `bLP` / `bINS` (insurance is ledger unit, not necessarily token), or choose another naming scheme. Verify collisions/trademarks before domain/token deployment.
19. **Economic model — DECIDED:** synthetic Basis-AMM leveraged claim held by the user; vault owns the external hedge. Direct margin loans and user-owned venue shares are not part of v1.
20. **Hedging strategies:** (A) exact same-event outcome shares only initially (**recommended for accounting trust**), or (B) allow supplementary dynamic BTC/ETH perps, rates futures, etc., as additional *imperfect* hedges with explicit basis-risk budgets? Any synthetic hedge strategy must be separately approved, never inferred from market category alone.
21. **Market-policy UX:** (A) show a clear compact summary of market-specific rules on the trade screen with expandable complete terms (**recommended**), or (B) require a full rules modal acknowledgment on every new market? Can policy changes affect already-open positions except for narrowly scoped emergency safety pauses?
22. **Multi-outcome markets:** launch implementation with binary YES/NO venue tokens first but design schemas for arbitrary mutually exclusive outcomes (**recommended**), or require live multi-outcome execution/settlement in the first release? This is an adapter and stress-proof requirement, not a contract-code category restriction.
23. **Profit/loss treatment — DECIDED:** net loss cannot exceed isolated margin `M`; positive synthetic P&L has **no +100%-of-margin cap**. At event resolution, payouts follow the approved instrument's finite payout vector, not a synthetic 2M ceiling. Fees are deducted under user-signed bounds. No mandatory profitable-position close/ADL.
24. **GMX-style counterparty-pool proposal — CONFIRM BEFORE CODING:** (A) `POOL_ONLY` default with full *scenario-derived* LP profit reserve, plus optional `POOL_PLUS_HEDGE` and market-specific `HEDGE_REQUIRED` (**recommended architecture**) or (B) require an actual external outcome-share purchase for every trade. Reservations must scale with margin, leverage, entry price, outcome and existing portfolio; never assume `R=M`.
25. **Automatic +100%-profit barrier — REMOVED:** No mandatory take-profit and no positive P&L clamp. Optional user-configured TP/SL remain best-effort. Design liquidation price/maintenance buffer only for losing positions and disclose gap risk.
26. **Oracle pricing vs execution:** Should `POOL_ONLY` quotes be validated from size-adjusted market executable depth and a delayed oracle/commit system (recommended), with closes refused or dynamically spread-widened under stale/thin books? Confirm no guarantee that a third-party prediction-market mark is independently executable or manipulation-resistant.

## 15. Agent implementation instruction

Implement **only the confirmed components and non-mutating research** until Joshua answers §14. **Firm requirements:** market-agnostic policy/adapter registry; market-specific constraints visible to traders; no category-based hardcoded cutoff, required time horizon or fixed leverage tier; partial fills default ON with user opt-out; no internal matching or order book; **nonrecourse synthetic claims: losses stop at posted margin, wins continue to the event-derived maximum, and no forced +100%-profit close**. Vault is a potential GMX-style direct counterparty and may separately hold optional hedge inventory; **do not mandate 5x external hedge share purchases for 5x synthetic exposure** unless Joshua expressly rejects `POOL_ONLY`. Do not create real margin loans or hand users actual venue shares. Do not select arbitrary fee percentages, risk coefficients, custody keys, market admission thresholds, minimum fill fraction, pricing oracle shortcuts or jurisdiction policies. Do not claim an attested backend is trustless or a payout reserve makes a quote fair. Use deterministic unit/property/failure tests with synthetic crypto, election, sports and macro market data and show asset conservation on NEAR testnet. Preserve the user's vault funds and existing repos. Any expansion to real funds, external custodial signing, live counterparties or production exchanges requires explicit authorization and professional review. Report blockers and implementation deviations to Joshua rather than silently simplifying the protocol.
