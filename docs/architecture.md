# Architecture

```text
 trader wallet ──ft_transfer_call(margin + max_fee, signed OrderIntent)──┐
 LP wallet ─────ft_transfer_call(lp_deposit)─────────────────────────────┤
                                                                         ▼
                              ┌──────────────── basis-core (NEAR) ────────────────┐
                              │ registry   markets, payout matrices, policies,    │
                              │            timelocked approvals, guardian         │
                              │ oracle     ed25519 reporter keys, MARK checks,    │
                              │            resolution quorum + dispute window     │
                              │ margin     orders, positions, close, triggers,    │
                              │            liquidation, settlement                │
                              │ vault      cash, NAV, bLP (NEP-141), withdrawals  │
                              │ hedge      receipts, custody, reconciliation      │
                              │ insurance  segregated ledger, loss waterfall      │
                              └──────▲──────────────▲─────────────────▲───────────┘
                     execute_* + mark │   push_mark   │ hedge receipts  │ views
                              ┌───────┴──────────────┴─────────────────┴───────────┐
                              │ basis-node: keeper, oracle worker, mock executor,  │
                              │ reconciler, indexer (SQLite), quote engine, API/WS │
                              └───────▲───────────────────────────────▲────────────┘
                        venue books   │                               │ REST + WS
                     (mock or Polymarket read-only)              apps/web dashboard
```

## Order lifecycle

1. The trader signs one NEAR transaction: `tUSDC.ft_transfer_call(core, margin + max_fee, msg)`
   where `msg` carries the `OrderIntent` (outcome, margin, leverage, max entry price, max fee,
   deadline, partial-fill choice and minimum, TP/SL, current policy hash, nonce). The token
   contract proves the amount; the contract stores the order as `Requested` with its commit time.
2. A keeper calls `execute_open(order_id, signed_mark)`. The mark must be signed by a registered
   reporter, fresh under the market policy, observed after the commit, and inside the spread
   guard. The contract walks the ask book for the requested notional, checks the entry price
   against the signed bound, the tick-sensitivity leverage ceiling, exit depth, open interest and
   payout-liability caps, then sizes the fill to the event and global stress budgets and to free
   liquidity. If the admissible fraction is below 100% it fills only with partial fills on and at
   or above the user's minimum. It then runs the fair-price gate and opens, refunding unused
   margin and fee budget. Any rejection refunds the escrow in full and records the reason.
3. `HEDGE_REQUIRED` markets stop at `RiskReserved`: payout capacity and a bounded hedge budget are
   reserved, the executor commits the budget to custody, posts venue fill receipts
   (`HedgedProvisional`) and finalizes exactly once; the position is sized to the executed hedge.
4. Closing is the same commit-then-execute pattern at the bid. Triggers and liquidation take a
   fresh mark; liquidation is permissionless and only applies to losing positions.
5. Resolution: reporters submit `FINAL_RESOLUTION` votes while the venue reports `Resolved` or
   `Invalid`; at quorum a dispute window starts; anyone finalizes after it; anyone settles open
   positions against the exact payout vector.

## Balance sheet

Every collateral micro-unit the contract holds is in exactly one bucket:
`cash + order_escrow + claimable + in_flight + insurance + treasury`, and the e2e suite checks
that sum against `ft_balance_of(core)` after every step. `hedge_custody_cash` is vault capital the
executor holds off-contract. NAV is `cash + custody + hedge inventory at bid - open claims at ask`.
Free liquidity is `cash - open margin - payout reserve`. LP withdrawals and new reserves can only
draw on free liquidity.

## Per-event reserves

For each event the contract keeps, per payout scenario, the sum of open positions' terminal P&L
(each floored at `-M`, no positive cap). `payout_reserve = max_s max(0, trader_pnl[s])` gates
liquidity and gives no credit for off-chain hedges. `stress_loss = max_s max(0, trader_pnl[s] -
hedge_pnl[s])` is checked against `event_stress_cap_bps` of NAV and, summed over events, against
`global_stress_cap_bps`. Opening a NO next to a YES therefore shows up as the scenario-wise sum,
never as "delta neutral".
