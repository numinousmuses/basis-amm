# Deviations from spec v0.1 and known gaps

Every place where the implementation differs from the spec's suggested shape, or stops short of
it, with the reason. Nothing here weakens a loss-cap, reserve or nonrecourse invariant.

## Structure

1. **One deployable instead of five contracts.** Section 3 suggests `registry`, `vault`, `margin`,
   `oracle` and `insurance` as separate accounts and explicitly allows "separate modules in a
   single deployable if asynchronous cross-contract invariants become too risky". They are modules
   of `contracts/basis-core`. Reserving payout capacity and opening a position then happen in one
   receipt, so no callback can strand a reservation or double-commit the vault. The insurance
   ledger is segregated inside the same balance sheet (`Ledger.insurance` is never counted as free
   liquidity).
2. **Postgres replaced by SQLite.** The read model in `services/basis-node` uses `node:sqlite`. It
   is a projection of onchain events, marks and vault snapshots and is never an accounting
   authority, as the spec requires. Swapping in Postgres changes one file (`store.ts`).
3. **No OpenAPI generator.** The REST surface is small and typed through `@basis/sdk`; routes are
   listed in `docs/api.md`.

## Economics and risk

4. **Fair-price gate model.** The spec asks for a fair-value test but leaves the model open. The
   contract charges a risk premium of `floor_coverage_bps` of the hold-to-resolution trader EV
   under mark-implied scenario probabilities, and rejects with `FAIR_VALUE` when that premium plus
   the open fee exceeds the user's signed `max_fee`. It is an upper bound on the floor's value, not
   a calibrated price. See `docs/decisions.md`.
5. **Liquidity reserve gives no credit for hedges.** Section 5 nets hedge P&L in `LP_Loss(s)`. The
   contract keeps two numbers per event: `stress_loss` (nets vault-owned hedge P&L, used for the NAV
   risk budgets, exactly as the spec writes it) and `payout_reserve` (no hedge credit, used to gate
   free liquidity). Hedge proceeds sit off-chain with the executor until returned, and section 4
   requires synthetic claims to stay payable "even when a hedge execution or cross-chain callback
   fails".
6. **Spread guard is absolute.** `max_spread_bps` is measured in bps of a $1 payout (100 bps = one
   cent). A relative spread would reject a normal one-cent spread on a $0.10 outcome.
7. **Intermediate paths.** Reserves use terminal scenarios. For long-only outcome claims the
   largest trader claim on any path is bounded by the terminal maximum, so this is conservative for
   the trader side. Path-dependent hedge losses before resolution are not separately stressed.
8. **Resolving markets in NAV.** While a market waits out its dispute window there is no
   executable book. NAV values its claims at their event maximum and its hedges at zero instead of
   marking NAV stale for every market.
9. **Full liquidation only.** No keeper partial liquidation (decision 12).

## Oracle and execution

10. **Mark reporter is a single dev key.** Reports are ed25519-signed and verified onchain with a
    domain-separated digest. There is no OutLayer/TEE deployment; `attestation_measurement` is
    recorded as `dev:unattested`. Resolution supports a reporter quorum and a dispute window.
11. **Execution is keeper-only.** `execute_open` / `execute_close` are restricted to keeper or
    executor accounts so a user cannot pick the most favorable of several valid marks. Liquidation
    is permissionless.
12. **Hedge venue is a deterministic mock.** No Polygon transaction is ever signed. Receipts carry
    `simulated: true` and `tx_hash` values prefixed `sim:`. The Polymarket adapter in
    `services/basis-node/src/feeds.ts` reads live public order books and Gamma market metadata
    read-only (discovery and shadow marks) and never trades. A validated Polygon execution and
    receipt path remains a separate milestone before public production, as section 11 says.
13. **Executor receipts are trusted operator assertions.** The contract validates market, token,
    chain, price against the fresh mark plus signed slippage, timing against the order commit and
    deadline, overfill and custody budget. It cannot verify Polygon inclusion; that would need a
    light client or proof system.

## Operations

14. **Event log is a bounded ring buffer onchain** (`event_log_capacity`, 4,000 on sandbox, 300 on
    testnet to limit staked storage). Every event is also emitted as an NEP-297 log.
15. **No upgrade entry point, but testnet deploys keep a full-access key.** Contracts deploy
    without an `upgrade` method; a new version is a new deployment. The testnet deployer still
    holds the full-access key of the contract account, which can redeploy code. A production
    deployment must delete that key (a locked contract) or hand it to a timelocked multisig.
    Section 14.16 is open.
16. **bLP storage.** LPs are auto-registered on bLP by the contract on first deposit, bounded by
    `min_lp_deposit`. Force-unregister is disabled so bLP can never be burned outside the ledger.
17. **Historical backtest is synthetic.** `research/` simulates the three strategies on generated
    paths with jumps and can replay real Polymarket price history fetched read-only. It does not
    have full historical order-book depth, which section 11 asks for before setting production
    caps.
