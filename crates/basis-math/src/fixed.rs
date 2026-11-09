//! Fixed-point primitives. Every amount is an unsigned integer with a declared scale.
//! No floating point anywhere in this crate.

use core::fmt;

/// Collateral amounts are integer micro-units of a 6-decimal stablecoin (1 USD = 1_000_000).
pub const USD: u128 = 1_000_000;
/// Prices of outcome claims are in `[0, PRICE_SCALE]`; a claim paying 1 USD at resolution trades at
/// `PRICE_SCALE` when certain. `$0.50` is `500_000`.
pub const PRICE_SCALE: u128 = 1_000_000;
/// Synthetic reference units are micro-units: `UNIT` micro-units pay `PRICE_SCALE` micro-USD at
/// full payout. Value in micro-USD is `units * price / PRICE_SCALE`.
pub const UNIT: u128 = 1_000_000;
/// Basis points denominator.
pub const BPS: u128 = 10_000;
/// Leverage is expressed in basis points of 1x: `5x == 50_000`.
pub const LEV_SCALE: u128 = 10_000;
/// Fill fractions are parts per million.
pub const PPM: u128 = 1_000_000;
/// Nanoseconds in a 365-day year, used for holding-fee accrual.
pub const YEAR_NS: u128 = 365 * 24 * 3600 * 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    DivisionByZero,
    InvalidPrice,
    InvalidLeverage,
    InvalidFraction,
    InvalidScenario,
    InsufficientDepth,
    Negative,
}

impl fmt::Display for MathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            MathError::Overflow => "MATH_OVERFLOW",
            MathError::DivisionByZero => "MATH_DIV_ZERO",
            MathError::InvalidPrice => "INVALID_PRICE",
            MathError::InvalidLeverage => "INVALID_LEVERAGE",
            MathError::InvalidFraction => "INVALID_FRACTION",
            MathError::InvalidScenario => "INVALID_SCENARIO",
            MathError::InsufficientDepth => "INSUFFICIENT_DEPTH",
            MathError::Negative => "NEGATIVE_VALUE",
        };
        f.write_str(s)
    }
}

pub type MathResult<T> = Result<T, MathError>;

/// 256-bit product of two u128 values as (hi, lo).
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a_hi, a_lo) = (a >> 64, a & mask);
    let (b_hi, b_lo) = (b >> 64, b & mask);
    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;
    let mid = (ll >> 64) + (lh & mask) + (hl & mask);
    let lo = (ll & mask) | ((mid & mask) << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
    (hi, lo)
}

/// Divide a 256-bit value by a u128 with restoring long division. Returns (quotient, remainder).
/// Fails if the quotient does not fit in u128.
fn div_wide(hi: u128, lo: u128, d: u128) -> MathResult<(u128, u128)> {
    if d == 0 {
        return Err(MathError::DivisionByZero);
    }
    if hi >= d {
        return Err(MathError::Overflow);
    }
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    Ok((q, rem))
}

/// `floor(a * b / d)` with full 256-bit intermediate precision.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> MathResult<u128> {
    if d == 0 {
        return Err(MathError::DivisionByZero);
    }
    if let Some(p) = a.checked_mul(b) {
        return Ok(p / d);
    }
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, d).map(|(q, _)| q)
}

/// `ceil(a * b / d)` with full 256-bit intermediate precision.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> MathResult<u128> {
    if d == 0 {
        return Err(MathError::DivisionByZero);
    }
    if let Some(p) = a.checked_mul(b) {
        let q = p / d;
        return if p % d == 0 { Ok(q) } else { q.checked_add(1).ok_or(MathError::Overflow) };
    }
    let (hi, lo) = mul_wide(a, b);
    let (q, r) = div_wide(hi, lo, d)?;
    if r == 0 { Ok(q) } else { q.checked_add(1).ok_or(MathError::Overflow) }
}

pub fn add(a: u128, b: u128) -> MathResult<u128> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

pub fn sub(a: u128, b: u128) -> MathResult<u128> {
    a.checked_sub(b).ok_or(MathError::Negative)
}

pub fn to_i128(a: u128) -> MathResult<i128> {
    i128::try_from(a).map_err(|_| MathError::Overflow)
}

pub fn iadd(a: i128, b: i128) -> MathResult<i128> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

pub fn isub(a: i128, b: i128) -> MathResult<i128> {
    a.checked_sub(b).ok_or(MathError::Overflow)
}

/// Clamp a signed value at zero and return it unsigned.
pub fn pos(a: i128) -> u128 {
    if a > 0 { a as u128 } else { 0 }
}

/// Validate a price is a probability-like claim price in `[0, PRICE_SCALE]`.
pub fn check_price(p: u128) -> MathResult<u128> {
    if p > PRICE_SCALE { Err(MathError::InvalidPrice) } else { Ok(p) }
}

/// Validate an entry price: strictly inside `(0, PRICE_SCALE)`.
pub fn check_entry_price(p: u128) -> MathResult<u128> {
    if p == 0 || p >= PRICE_SCALE { Err(MathError::InvalidPrice) } else { Ok(p) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn wide_path_matches_small_path() {
        assert_eq!(mul_div_floor(7, 9, 4).unwrap(), 15);
        assert_eq!(mul_div_ceil(7, 9, 4).unwrap(), 16);
        assert_eq!(mul_div_ceil(8, 9, 4).unwrap(), 18);
        let big = u128::MAX / 3;
        // big * 6 / 6 overflows the fast path but not the result.
        assert_eq!(mul_div_floor(big, 6, 6).unwrap(), big);
        assert_eq!(mul_div_ceil(big, 6, 6).unwrap(), big);
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX).unwrap(), u128::MAX);
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), Err(MathError::Overflow));
        assert_eq!(mul_div_floor(1, 1, 0), Err(MathError::DivisionByZero));
    }

    proptest! {
        #[test]
        fn wide_matches_reference(a in any::<u64>(), b in any::<u64>(), c in 1u64..) {
            // Reference with u128 since u64*u64 fits.
            let (a, b, c) = (a as u128, b as u128, c as u128);
            let want_floor = a * b / c;
            let want_ceil = (a * b).div_ceil(c);
            // Force the wide path by scaling a and c by 2^64 (keeps the ratio).
            let s = 1u128 << 64;
            prop_assert_eq!(mul_div_floor(a * s, b, c * s).unwrap(), want_floor);
            prop_assert_eq!(mul_div_floor(a, b, c).unwrap(), want_floor);
            prop_assert_eq!(mul_div_ceil(a, b, c).unwrap(), want_ceil);
        }

        #[test]
        fn wide_division_is_exact(a in any::<u128>(), b in any::<u128>(), d in 1u128..) {
            if let Ok(q) = mul_div_floor(a, b, d) {
                // q*d <= a*b < (q+1)*d, verified in 256 bits.
                let (qh, ql) = mul_wide(q, d);
                let (ph, pl) = mul_wide(a, b);
                prop_assert!((qh, ql) <= (ph, pl));
                if let Some(q1) = q.checked_add(1) {
                    let (nh, nl) = mul_wide(q1, d);
                    prop_assert!((nh, nl) > (ph, pl));
                }
            }
        }
    }
}
