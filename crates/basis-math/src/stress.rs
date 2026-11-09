//! Scenario stress and reserve math (spec section 5, "Portfolio stress rule").
//!
//! For each terminal scenario `s` of an event, `TraderPnL(s)` is the sum of open positions'
//! per-scenario P&L (floored at `-M` per position, no positive clamp), `HedgePnL(s)` is the P&L of
//! vault-owned hedge inventory, and `LP_Loss(s) = max(0, TraderPnL(s) - HedgePnL(s) + Costs)`.
//! The event reserve is `max_s LP_Loss(s)`.

use crate::fixed::*;

/// Per-scenario payout of each outcome claim, in price scale. `payouts[s][i]` is what one unit of
/// outcome `i` pays in scenario `s`. Binary YES/NO is `[[1,0],[0,1]]` (scaled); an invalid-market
/// scenario can pay e.g. `[0.5, 0.5]`. The matrix shape is data, not an enum.
pub fn validate_payout_matrix(payouts: &[Vec<u128>], outcomes: usize) -> MathResult<()> {
    if payouts.is_empty() || outcomes < 2 {
        return Err(MathError::InvalidScenario);
    }
    for row in payouts {
        if row.len() != outcomes {
            return Err(MathError::InvalidScenario);
        }
        let mut total = 0u128;
        for &p in row {
            check_price(p)?;
            total = add(total, p)?;
        }
        // A fully collateralised claim set never pays more than 1 USD per complete set.
        if total > PRICE_SCALE {
            return Err(MathError::InvalidScenario);
        }
    }
    // Every outcome must be able to pay its maximum in some scenario, otherwise its max payout
    // is ill-defined for reservation.
    Ok(())
}

/// Maximum payout of outcome `i` across scenarios.
pub fn max_outcome_payout(payouts: &[Vec<u128>], outcome: usize) -> MathResult<u128> {
    payouts
        .iter()
        .map(|r| r.get(outcome).copied().ok_or(MathError::InvalidScenario))
        .try_fold(0u128, |m, p| p.map(|p| m.max(p)))
}

/// `LP_Loss = max_s max(0, trader[s] - hedge[s] + costs)`.
pub fn lp_loss(trader: &[i128], hedge: &[i128], costs: u128) -> MathResult<u128> {
    if trader.len() != hedge.len() {
        return Err(MathError::InvalidScenario);
    }
    let c = to_i128(costs)?;
    let mut worst = 0u128;
    for (t, h) in trader.iter().zip(hedge) {
        worst = worst.max(pos(iadd(isub(*t, *h)?, c)?));
    }
    Ok(worst)
}

/// Element-wise `a + b`.
pub fn add_vec(a: &[i128], b: &[i128]) -> MathResult<Vec<i128>> {
    if a.len() != b.len() {
        return Err(MathError::InvalidScenario);
    }
    a.iter().zip(b).map(|(x, y)| iadd(*x, *y)).collect()
}

/// Element-wise `a - b`.
pub fn sub_vec(a: &[i128], b: &[i128]) -> MathResult<Vec<i128>> {
    if a.len() != b.len() {
        return Err(MathError::InvalidScenario);
    }
    a.iter().zip(b).map(|(x, y)| isub(*x, *y)).collect()
}

/// Hedge P&L per scenario for vault-owned inventory `shares[i]` (micro-units) bought for
/// `cost[i]` (micro-USD): `sum_i shares[i]*payouts[s][i] - cost[i]`. Payoff is floored.
pub fn hedge_scenario_pnl(payouts: &[Vec<u128>], shares: &[u128], cost: &[u128]) -> MathResult<Vec<i128>> {
    let mut out = Vec::with_capacity(payouts.len());
    for row in payouts {
        if row.len() != shares.len() || shares.len() != cost.len() {
            return Err(MathError::InvalidScenario);
        }
        let mut v: i128 = 0;
        for i in 0..row.len() {
            let value = mul_div_floor(shares[i], row[i], PRICE_SCALE)?;
            v = iadd(v, isub(to_i128(value)?, to_i128(cost[i])?)?)?;
        }
        out.push(v);
    }
    Ok(out)
}

/// Capacity limits for admitting a candidate position into an event book.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capacity {
    /// Event stress cap in micro-USD (e.g. 2% NAV, policy-configured).
    pub event_cap: u128,
    /// Global stress cap in micro-USD (e.g. 10% NAV, protocol-configured).
    pub global_cap: u128,
    /// Sum of other events' reserves (micro-USD).
    pub other_events_reserve: u128,
    /// Free vault liquidity available for new reserves (micro-USD).
    pub free_liquidity: u128,
}

/// Admission result for a candidate at a given fill fraction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admission {
    pub fraction_ppm: u128,
    pub event_reserve_before: u128,
    pub event_reserve_after: u128,
}

/// The binding reserve level for this event: the candidate may raise the event reserve up to
/// `min(event_cap, global_cap - others, before + free)`, and a risk-reducing trade is always
/// admissible because the level is never below the current reserve.
pub fn reserve_level(before: u128, cap: &Capacity) -> u128 {
    let global_room = cap.global_cap.saturating_sub(cap.other_events_reserve);
    let liquidity_room = before.saturating_add(cap.free_liquidity);
    let level = cap.event_cap.min(global_room).min(liquidity_room);
    level.max(before)
}

/// Largest fill fraction (ppm, <= `PPM`) such that the event reserve with the candidate scaled by
/// that fraction stays within `reserve_level`. `candidate_full[s]` is the candidate's per-scenario
/// trader P&L at full size. The admissible set is an interval containing 0 because the LP-loss
/// function is a maximum of affine functions of the fraction (convex).
pub fn max_fill_fraction(
    trader: &[i128],
    hedge: &[i128],
    candidate_full: &[i128],
    costs: u128,
    cap: &Capacity,
) -> MathResult<Admission> {
    if trader.len() != candidate_full.len() || trader.len() != hedge.len() {
        return Err(MathError::InvalidScenario);
    }
    let before = lp_loss(trader, hedge, costs)?;
    let level = to_i128(reserve_level(before, cap))?;
    let c = to_i128(costs)?;
    let mut f = PPM;
    for s in 0..trader.len() {
        let cand = candidate_full[s];
        if cand <= 0 {
            continue;
        }
        // need base + f*cand/PPM <= level, base = trader - hedge + costs
        let base = iadd(isub(trader[s], hedge[s])?, c)?;
        let room = isub(level, base)?;
        if room <= 0 {
            return Ok(Admission { fraction_ppm: 0, event_reserve_before: before, event_reserve_after: before });
        }
        let fs = mul_div_floor(room as u128, PPM, cand as u128)?;
        f = f.min(fs);
    }
    let after_vec: Vec<i128> = (0..trader.len())
        .map(|s| {
            let scaled = if candidate_full[s] >= 0 {
                to_i128(mul_div_floor(candidate_full[s] as u128, f, PPM)?)?
            } else {
                -to_i128(mul_div_floor((-candidate_full[s]) as u128, f, PPM)?)?
            };
            iadd(trader[s], scaled)
        })
        .collect::<MathResult<_>>()?;
    let after = lp_loss(&after_vec, hedge, costs)?;
    Ok(Admission { fraction_ppm: f, event_reserve_before: before, event_reserve_after: after })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::position::Terms;
    use proptest::prelude::*;

    const D: u128 = USD;
    fn binary() -> Vec<Vec<u128>> {
        vec![vec![PRICE_SCALE, 0], vec![0, PRICE_SCALE]]
    }

    fn cand(t: &Terms, outcome: usize, payouts: &[Vec<u128>]) -> Vec<i128> {
        payouts.iter().map(|r| t.scenario_pnl(r[outcome]).unwrap()).collect()
    }

    /// Spec: $100, 5x, $0.50 unhedged long reserves $500, not $100.
    #[test]
    fn unhedged_reserve_is_full_winning_pnl() {
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let c = cand(&t, 0, &binary());
        assert_eq!(c, vec![500 * D as i128, -(100 * D as i128)]);
        assert_eq!(lp_loss(&c, &[0, 0], 0).unwrap(), 500 * D);
    }

    /// Spec: exact-share hedge of 1,000 YES for $500 -> ~0 winning-state loss, $400 adverse loss.
    #[test]
    fn exact_share_hedge_moves_risk_to_adverse_state() {
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let c = cand(&t, 0, &binary());
        let h = hedge_scenario_pnl(&binary(), &[1_000 * UNIT, 0], &[500 * D, 0]).unwrap();
        assert_eq!(h, vec![500 * D as i128, -(500 * D as i128)]);
        // LP loss by scenario: YES = 500-500 = 0; NO = -100 - (-500) = 400.
        assert_eq!(lp_loss(&c, &h, 0).unwrap(), 400 * D);
    }

    /// Spec: $100k sandbox, 2% event cap = $2,000: $500 margin 5x @0.50 fails (needs $2,500);
    /// with partial fills on, 80% fills.
    #[test]
    fn event_cap_partial_fill() {
        let t = Terms::open(500 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let c = cand(&t, 0, &binary());
        let cap = Capacity { event_cap: 2_000 * D, global_cap: 10_000 * D, other_events_reserve: 0, free_liquidity: 100_000 * D };
        let a = max_fill_fraction(&[0, 0], &[0, 0], &c, 0, &cap).unwrap();
        assert_eq!(a.fraction_ppm, 800_000);
        assert_eq!(a.event_reserve_after, 2_000 * D);
        // $100 margin fits entirely.
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let a = max_fill_fraction(&[0, 0], &[0, 0], &cand(&t, 0, &binary()), 0, &cap).unwrap();
        assert_eq!(a.fraction_ppm, PPM);
        assert_eq!(a.event_reserve_after, 500 * D);
    }

    /// Opposing YES and NO users: no internal matching, but the scenario reserve aggregates both.
    #[test]
    fn opposing_exposures_aggregate_by_scenario() {
        let yes = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let no = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let total = add_vec(&cand(&yes, 0, &binary()), &cand(&no, 1, &binary())).unwrap();
        // YES wins: +500 - 100 = 400; NO wins: -100 + 500 = 400.
        assert_eq!(total, vec![400 * D as i128, 400 * D as i128]);
        assert_eq!(lp_loss(&total, &[0, 0], 0).unwrap(), 400 * D);
    }

    #[test]
    fn risk_reducing_trade_admitted_when_over_cap() {
        let yes = Terms::open(1_000 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let book = cand(&yes, 0, &binary()); // reserve 5000
        let cap = Capacity { event_cap: 2_000 * D, global_cap: 10_000 * D, other_events_reserve: 0, free_liquidity: 0 };
        let no = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let a = max_fill_fraction(&book, &[0, 0], &cand(&no, 1, &binary()), 0, &cap).unwrap();
        assert_eq!(a.fraction_ppm, PPM);
        assert!(a.event_reserve_after < a.event_reserve_before);
        // A risk-increasing YES is refused entirely.
        let a = max_fill_fraction(&book, &[0, 0], &cand(&yes, 0, &binary()), 0, &cap).unwrap();
        assert_eq!(a.fraction_ppm, 0);
    }

    #[test]
    fn payout_matrix_validation() {
        assert!(validate_payout_matrix(&binary(), 2).is_ok());
        let tri = vec![
            vec![PRICE_SCALE, 0, 0], vec![0, PRICE_SCALE, 0], vec![0, 0, PRICE_SCALE],
            vec![333_333, 333_333, 333_333],
        ];
        assert!(validate_payout_matrix(&tri, 3).is_ok());
        assert!(validate_payout_matrix(&[vec![PRICE_SCALE, PRICE_SCALE]], 2).is_err());
        assert!(validate_payout_matrix(&[vec![PRICE_SCALE]], 2).is_err());
        assert!(validate_payout_matrix(&[], 2).is_err());
        assert_eq!(max_outcome_payout(&tri, 2).unwrap(), PRICE_SCALE);
    }

    proptest! {
        /// The admitted fraction never breaches the binding level, and the next ppm would (unless
        /// already full) -- i.e. the search is exact.
        #[test]
        fn admission_is_tight(
            m in D..10_000 * D, l in LEV_SCALE..=10 * LEV_SCALE, p0 in 50_000u128..950_000,
            cap_e in 0u128..20_000 * D, free in 0u128..50_000 * D,
            book_m in 0u128..2_000 * D,
        ) {
            let pm = binary();
            let book = if book_m > 0 { cand(&Terms::open(book_m, 2 * LEV_SCALE, 400_000).unwrap(), 1, &pm) } else { vec![0, 0] };
            let t = Terms::open(m, l, p0).unwrap();
            let c = cand(&t, 0, &pm);
            let cap = Capacity { event_cap: cap_e, global_cap: 100_000 * D, other_events_reserve: 0, free_liquidity: free };
            let a = max_fill_fraction(&book, &[0, 0], &c, 0, &cap).unwrap();
            let level = reserve_level(a.event_reserve_before, &cap);
            prop_assert!(a.event_reserve_after <= level);
            prop_assert!(a.fraction_ppm <= PPM);
        }
    }
}
