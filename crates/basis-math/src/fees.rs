//! Fee formulas (spec section 6). Every fee is rounded up (in the vault's favour) and bounded so
//! it never creates user debt: fees are charged against posted funds or positive equity only.

use crate::fixed::*;

/// `F_open = notional * rate_open`, rounded up.
pub fn open_fee(notional: u128, open_bps: u128) -> MathResult<u128> {
    mul_div_ceil(notional, open_bps, BPS)
}

/// `F_close = proceeds * rate_close`, rounded up, never above the proceeds.
pub fn close_fee(proceeds: u128, close_bps: u128) -> MathResult<u128> {
    Ok(mul_div_ceil(proceeds, close_bps, BPS)?.min(proceeds))
}

/// Holding fee on the disclosed virtual financing base:
/// `F_hold = base * apr * elapsed / year`, rounded up.
pub fn holding_fee(base: u128, apr_bps: u128, elapsed_ns: u128) -> MathResult<u128> {
    let per_year = mul_div_ceil(base, apr_bps, BPS)?;
    mul_div_ceil(per_year, elapsed_ns, YEAR_NS)
}

/// Keeper liquidation reward, paid from positive residual equity only:
/// `min(residual * bps, cap)`, floored.
pub fn liquidation_reward(residual_equity: u128, reward_bps: u128, cap: u128) -> MathResult<u128> {
    Ok(mul_div_floor(residual_equity, reward_bps, BPS)?.min(cap).min(residual_equity))
}

/// Split collected fees into (LP, insurance, treasury). LP receives the remainder so the parts
/// always sum exactly to the input.
pub fn split_fee(amount: u128, insurance_bps: u128, treasury_bps: u128) -> MathResult<(u128, u128, u128)> {
    if add(insurance_bps, treasury_bps)? > BPS {
        return Err(MathError::InvalidFraction);
    }
    let ins = mul_div_floor(amount, insurance_bps, BPS)?;
    let tre = mul_div_floor(amount, treasury_bps, BPS)?;
    Ok((amount - ins - tre, ins, tre))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn examples() {
        assert_eq!(open_fee(500 * USD, 10).unwrap(), 500_000); // 0.10% of $500 = $0.50
        assert_eq!(close_fee(3, 5_000).unwrap(), 2);
        assert_eq!(close_fee(1, BPS * 2).unwrap(), 1);
        // $400 base at 10% APR for half a year = $20.
        assert_eq!(holding_fee(400 * USD, 1_000, YEAR_NS / 2).unwrap(), 20 * USD);
        assert_eq!(liquidation_reward(100 * USD, 500, 2 * USD).unwrap(), 2 * USD);
        assert_eq!(liquidation_reward(10 * USD, 500, 2 * USD).unwrap(), 500_000);
        assert_eq!(split_fee(101, 2_000, 1_000).unwrap(), (71, 20, 10));
        assert!(split_fee(1, 6_000, 5_000).is_err());
    }

    proptest! {
        #[test]
        fn split_conserves(a in 0u128..u64::MAX as u128, i in 0u128..=5_000, t in 0u128..=5_000) {
            let (l, ins, tre) = split_fee(a, i, t).unwrap();
            prop_assert_eq!(l + ins + tre, a);
        }

        #[test]
        fn holding_fee_monotone(base in 0u128..1_000_000 * USD, apr in 0u128..10_000, t1 in 0u128..YEAR_NS, t2 in 0u128..YEAR_NS) {
            let (lo, hi) = if t1 <= t2 { (t1, t2) } else { (t2, t1) };
            prop_assert!(holding_fee(base, apr, lo).unwrap() <= holding_fee(base, apr, hi).unwrap());
        }
    }
}
