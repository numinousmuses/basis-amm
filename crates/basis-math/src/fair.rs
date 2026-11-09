//! Fair-pricing stop gate (spec section 5).
//!
//! `max(0, M + raw_PnL)` is nonrecourse leveraged exposure: the loss floor is an embedded option
//! with positive value. The hold-to-resolution trader expected P&L under the mark-implied
//! scenario probabilities is an upper bound on that value, because liquidation or early exit can
//! only stop a martingale price path earlier. The quote engine and the contract charge a risk
//! premium of `coverage_bps` of this bound (policy-configured) and reject the quote when the
//! premium exceeds the user's signed maximum fee. Reserves never make an underpriced quote fair.

use crate::fixed::*;
use crate::position::Terms;

/// Normalise non-negative scenario weights (for example best-bid/ask midpoints of each exclusive
/// outcome) into probabilities in ppm that sum to exactly `PPM`.
pub fn implied_probabilities(weights: &[u128]) -> MathResult<Vec<u128>> {
    let total = weights.iter().try_fold(0u128, |a, w| add(a, *w))?;
    if total == 0 {
        return Err(MathError::DivisionByZero);
    }
    let mut out: Vec<u128> = weights.iter().map(|w| mul_div_floor(*w, PPM, total)).collect::<MathResult<_>>()?;
    let assigned: u128 = out.iter().sum();
    // Give the rounding remainder to the largest weight so the vector sums to PPM.
    let idx = (0..weights.len()).max_by_key(|i| weights[*i]).unwrap_or(0);
    out[idx] += PPM - assigned;
    Ok(out)
}

/// Expected trader P&L before fees if held to resolution:
/// `sum_s prob[s] * max(-M, Q*payout[s] - N)`. Positive results are rounded up (conservative for
/// the vault), negative results rounded toward zero.
pub fn hold_to_resolution_ev(terms: &Terms, outcome_payouts: &[u128], probs_ppm: &[u128]) -> MathResult<i128> {
    if outcome_payouts.len() != probs_ppm.len() {
        return Err(MathError::InvalidScenario);
    }
    let mut gain: u128 = 0;
    let mut loss: u128 = 0;
    for (p, w) in outcome_payouts.iter().zip(probs_ppm) {
        let pnl = terms.scenario_pnl(*p)?;
        if pnl >= 0 {
            gain = add(gain, mul_div_floor(pnl as u128, *w, 1)?)?;
        } else {
            loss = add(loss, mul_div_floor((-pnl) as u128, *w, 1)?)?;
        }
    }
    if gain >= loss {
        to_i128((gain - loss).div_ceil(PPM))
    } else {
        Ok(-to_i128((loss - gain) / PPM)?)
    }
}

/// Required risk premium `ceil(max(0, EV) * coverage_bps / BPS)`.
pub fn required_risk_premium(ev: i128, coverage_bps: u128) -> MathResult<u128> {
    mul_div_ceil(pos(ev), coverage_bps, BPS)
}

/// Largest leverage (LEV_SCALE, stepping by `step`) in `[LEV_SCALE, max_leverage]` whose total
/// upfront charge `open_fee + risk_premium` fits within `max_fee`. Used by the quote engine to
/// reprice instead of only rejecting. Returns `None` if even 1x does not fit.
pub fn max_fair_leverage(
    margin: u128,
    entry_price: u128,
    outcome_payouts: &[u128],
    probs_ppm: &[u128],
    coverage_bps: u128,
    open_bps: u128,
    max_fee: u128,
    max_leverage: u128,
    step: u128,
) -> MathResult<Option<u128>> {
    let mut best = None;
    let mut l = LEV_SCALE;
    while l <= max_leverage {
        let t = Terms::open(margin, l, entry_price)?;
        let ev = hold_to_resolution_ev(&t, outcome_payouts, probs_ppm)?;
        let charge = add(required_risk_premium(ev, coverage_bps)?, crate::fees::open_fee(t.notional, open_bps)?)?;
        if charge <= max_fee {
            best = Some(l);
        } else {
            break;
        }
        l = add(l, step.max(1))?;
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: u128 = USD;

    /// Spec 11.11: $0.80 YES, $100, 5x -> naive implied-probability EV = +$80 for the trader.
    #[test]
    fn spec_080_expected_gain_is_80() {
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 800_000).unwrap();
        let probs = implied_probabilities(&[800_000, 200_000]).unwrap();
        assert_eq!(probs, vec![800_000, 200_000]);
        let ev = hold_to_resolution_ev(&t, &[PRICE_SCALE, 0], &probs).unwrap();
        assert_eq!(ev, 80 * D as i128);
        // Full coverage requires an $80 premium: a $5 max fee must be rejected.
        assert_eq!(required_risk_premium(ev, BPS).unwrap(), 80 * D);
        assert!(required_risk_premium(ev, BPS).unwrap() > 5 * D);
    }

    /// At 1x there is no embedded floor value when entry equals the mark.
    #[test]
    fn one_x_is_fair() {
        let t = Terms::open(100 * D, LEV_SCALE, 500_000).unwrap();
        let ev = hold_to_resolution_ev(&t, &[PRICE_SCALE, 0], &[500_000, 500_000]).unwrap();
        assert_eq!(ev, 0);
    }

    /// EV of the floor grows as (L-1)*M*(1-p0) when entry equals the mark.
    #[test]
    fn floor_value_formula() {
        for (l, p0) in [(2u128, 500_000u128), (5, 500_000), (5, 800_000), (3, 250_000)] {
            let t = Terms::open(100 * D, l * LEV_SCALE, p0).unwrap();
            let probs = implied_probabilities(&[p0, PRICE_SCALE - p0]).unwrap();
            let ev = hold_to_resolution_ev(&t, &[PRICE_SCALE, 0], &probs).unwrap();
            let want = ((l - 1) * 100 * D * (PRICE_SCALE - p0) / PRICE_SCALE) as i128;
            assert!((ev - want).abs() <= 1, "l={l} p0={p0} ev={ev} want={want}");
        }
    }

    #[test]
    fn reprices_to_lower_leverage() {
        // $100 margin @0.80, coverage 10%, open fee 0.1%, max fee $5.
        let l = max_fair_leverage(100 * D, 800_000, &[PRICE_SCALE, 0], &[800_000, 200_000], 1_000, 10, 5 * D, 10 * LEV_SCALE, LEV_SCALE / 2)
            .unwrap()
            .unwrap();
        // EV at L is (L-1)*20; premium 10% -> 2*(L-1); open fee 0.1*L. 2(L-1)+0.1L<=5 -> L<=3.33
        assert_eq!(l, 3 * LEV_SCALE);
        assert!(max_fair_leverage(100 * D, 800_000, &[PRICE_SCALE, 0], &[800_000, 200_000], BPS, 10, 0, 10 * LEV_SCALE, LEV_SCALE).unwrap().is_none());
    }

    #[test]
    fn probabilities_sum_exactly() {
        let p = implied_probabilities(&[1, 1, 1]).unwrap();
        assert_eq!(p.iter().sum::<u128>(), PPM);
        assert!(implied_probabilities(&[0, 0]).is_err());
    }
}
