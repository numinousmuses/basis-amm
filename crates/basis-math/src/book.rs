//! Executable depth walks over an order-book snapshot carried in an oracle MARK report.
//! An API midpoint or last trade is not executable; opens price off asks, exits and
//! liquidations off bids, walked level by level for the requested size.

use crate::fixed::*;

/// One price level: `price` in price scale, `size` in micro-units available at that price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Level {
    pub price: u128,
    pub size: u128,
}

/// Result of a depth walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    /// Units obtained (buy) or sold (sell).
    pub units: u128,
    /// Notional spent (buy) or proceeds received (sell), micro-USD.
    pub notional: u128,
    /// True when the whole request was satisfied by the available depth.
    pub complete: bool,
}

fn check_levels(levels: &[Level], ascending: bool) -> MathResult<()> {
    for w in levels.windows(2) {
        let ok = if ascending { w[0].price <= w[1].price } else { w[0].price >= w[1].price };
        if !ok {
            return Err(MathError::InvalidPrice);
        }
    }
    for l in levels {
        check_price(l.price)?;
        if l.price == 0 {
            return Err(MathError::InvalidPrice);
        }
    }
    Ok(())
}

/// Spend up to `notional` buying along ascending `asks`. Units are floored per level, so the
/// average price is never better than the book.
pub fn buy_notional(asks: &[Level], notional: u128) -> MathResult<Fill> {
    check_levels(asks, true)?;
    let mut remaining = notional;
    let mut units = 0u128;
    for l in asks {
        if remaining == 0 {
            break;
        }
        let level_cost = mul_div_ceil(l.size, l.price, PRICE_SCALE)?;
        if level_cost <= remaining {
            units = add(units, l.size)?;
            remaining -= level_cost;
        } else {
            let u = mul_div_floor(remaining, PRICE_SCALE, l.price)?;
            units = add(units, u)?;
            remaining = 0;
        }
    }
    Ok(Fill { units, notional: notional - remaining, complete: remaining == 0 })
}

/// Sell up to `units` along descending `bids`. Proceeds are floored per level.
pub fn sell_units(bids: &[Level], units: u128) -> MathResult<Fill> {
    check_levels(bids, false)?;
    let mut remaining = units;
    let mut proceeds = 0u128;
    for l in bids {
        if remaining == 0 {
            break;
        }
        let take = remaining.min(l.size);
        proceeds = add(proceeds, mul_div_floor(take, l.price, PRICE_SCALE)?)?;
        remaining -= take;
    }
    Ok(Fill { units: units - remaining, notional: proceeds, complete: remaining == 0 })
}

/// Total units available across levels.
pub fn depth_units(levels: &[Level]) -> MathResult<u128> {
    levels.iter().try_fold(0u128, |acc, l| add(acc, l.size))
}

/// Absolute spread `ask - bid` in bps of a full $1 payout (100 bps == one cent). Prediction-market
/// prices live in [0, 1], so a relative spread would brand a normal one-cent spread on a $0.10
/// outcome as 10%. Returns `BPS` when either side is empty or the book is crossed.
pub fn spread_bps(best_bid: u128, best_ask: u128) -> MathResult<u128> {
    if best_ask == 0 || best_bid == 0 || best_bid > best_ask {
        return Ok(BPS);
    }
    mul_div_ceil(best_ask - best_bid, BPS, PRICE_SCALE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn lv(p: u128, s: u128) -> Level {
        Level { price: p, size: s * UNIT }
    }

    #[test]
    fn walks_asks() {
        let asks = [lv(500_000, 600), lv(510_000, 1_000)];
        // $500 buys 600 units at 0.50 ($300) and 392.15 at 0.51.
        let f = buy_notional(&asks, 500 * USD).unwrap();
        assert!(f.complete);
        assert_eq!(f.notional, 500 * USD);
        assert_eq!(f.units, 600 * UNIT + 392_156_862);
        // Too little depth.
        let f = buy_notional(&asks[..1], 500 * USD).unwrap();
        assert!(!f.complete);
        assert_eq!(f.units, 600 * UNIT);
        assert_eq!(f.notional, 300 * USD);
    }

    #[test]
    fn walks_bids() {
        let bids = [lv(600_000, 500), lv(590_000, 1_000)];
        let f = sell_units(&bids, 1_000 * UNIT).unwrap();
        assert!(f.complete);
        assert_eq!(f.notional, 300 * USD + 295 * USD);
    }

    #[test]
    fn rejects_unsorted_books() {
        assert!(buy_notional(&[lv(510_000, 1), lv(500_000, 1)], USD).is_err());
        assert!(sell_units(&[lv(500_000, 1), lv(510_000, 1)], UNIT).is_err());
        assert!(buy_notional(&[lv(0, 1)], USD).is_err());
    }

    #[test]
    fn spread() {
        assert_eq!(spread_bps(490_000, 500_000).unwrap(), 100);
        assert_eq!(spread_bps(90_000, 100_000).unwrap(), 100);
        assert_eq!(spread_bps(0, 500_000).unwrap(), BPS);
    }

    proptest! {
        #[test]
        fn buy_never_beats_best_price(
            p in 1u128..PRICE_SCALE, s in 1u128..1_000_000u128, n in 1u128..1_000_000 * USD,
        ) {
            let f = buy_notional(&[Level { price: p, size: s * UNIT }], n).unwrap();
            // value of units at p never exceeds what was spent
            prop_assert!(mul_div_floor(f.units, p, PRICE_SCALE).unwrap() <= f.notional);
            prop_assert!(f.notional <= n);
        }

        #[test]
        fn sell_never_beats_best_price(
            p in 1u128..PRICE_SCALE, s in 1u128..1_000_000u128, u in 1u128..1_000_000 * UNIT,
        ) {
            let f = sell_units(&[Level { price: p, size: s * UNIT }], u).unwrap();
            prop_assert!(f.notional <= mul_div_floor(f.units, p, PRICE_SCALE).unwrap());
            prop_assert!(f.units <= u);
        }
    }
}
