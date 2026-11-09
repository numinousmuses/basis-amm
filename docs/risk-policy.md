# Risk policy

All numbers are policy data. Shipped values are provisional (see `decisions.md`).

## Per-position limits

- Leverage: `min(protocol ceiling, market max, p0 / (k * tick))`. With a one-cent tick and k = 10
  adverse ticks, a position at $0.45 cannot exceed 4.5x.
- Margin between the market's `min_margin` and `max_margin`.
- Maintenance: a losing position is liquidatable when equity at the executable bid is at or below
  `maintenance_bps` of position value plus `maintenance_fixed`. A profitable position is never
  liquidated or closed by the protocol.
- Exit depth: the bid side must hold `exit_depth_bps` of the position's units, or the fill shrinks.

## Vault limits

- Event stress cap: `event_stress_cap_bps` of NAV (2%) on `stress_loss`.
- Global stress cap: `global_stress_cap_bps` of NAV (10%) on the sum of event stress losses.
- Free liquidity must cover every new payout reserve and every withdrawal.
- Opens stop while insurance is below `min_insurance_for_opens`.
- Hedge budget per market: `hedge_budget_bps` of NAV.

## Pricing

- Open fee on notional, close fee on proceeds, holding fee on the virtual base `(L-1)M`.
- Risk premium: `floor_coverage_bps` of the hold-to-resolution trader EV under mark-implied
  probabilities. The order is refused (`FAIR_VALUE`) when premium + open fee exceeds the signed
  `max_fee`. The quote engine suggests the highest leverage that fits.
- Fees split LP / insurance / treasury per market policy.

## Loss waterfall

Trader margin is the first loss on a losing claim. Hedge write-offs (lost inventory or custody
cash) are paid from the insurance ledger first and impair LP NAV only for the remainder. A
trader is never charged beyond posted margin.

## Calibration status

Leverage caps (3-4x per family, 5x protocol ceiling) and floor coverage (15-55%) are calibrated
with `research/` on synthetic paths; LPs profit in 18 of 20 seeded runs at the shipped values
(`docs/decisions.md`). Recalibrate on real order-book history before real funds.
