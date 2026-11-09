//! Nonrecourse synthetic position economics.
//!
//! Symbols follow spec section 5: `M` margin, `L` leverage, `N = L*M` reference notional,
//! `p0` locked entry reference price, `Q = N / p0` synthetic reference units, `F` accrued charges.
//! User equity is `max(0, M + Q*(price - p0) - F)`: loss is floored at `-M`, profit has no +M cap.

use crate::fixed::*;

/// Immutable economic terms of an isolated synthetic position (or a fill fraction of one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Terms {
    /// Isolated posted margin `M` (micro-USD).
    pub margin: u128,
    /// Reference notional `N = L*M` (micro-USD).
    pub notional: u128,
    /// Synthetic reference units `Q` (micro-units).
    pub units: u128,
    /// Execution-weighted entry reference price `p0` (price scale).
    pub entry_price: u128,
    /// Leverage in `LEV_SCALE`.
    pub leverage: u128,
}

impl Terms {
    /// Build terms from margin, leverage and the locked entry price. Units are floored so the
    /// rounding never favours the trader against the vault.
    pub fn open(margin: u128, leverage: u128, entry_price: u128) -> MathResult<Terms> {
        check_entry_price(entry_price)?;
        if leverage < LEV_SCALE {
            return Err(MathError::InvalidLeverage);
        }
        if margin == 0 {
            return Err(MathError::Negative);
        }
        let notional = mul_div_floor(margin, leverage, LEV_SCALE)?;
        let units = mul_div_floor(notional, PRICE_SCALE, entry_price)?;
        Ok(Terms { margin, notional, units, entry_price, leverage })
    }

    /// Build terms from an executed notional and executed units (depth-walked fill). The entry
    /// price is the execution-weighted average `N / Q` rounded up (vault-favourable).
    pub fn from_fill(margin: u128, notional: u128, units: u128, leverage: u128) -> MathResult<Terms> {
        if units == 0 {
            return Err(MathError::InsufficientDepth);
        }
        let entry_price = mul_div_ceil(notional, PRICE_SCALE, units)?;
        check_entry_price(entry_price)?;
        Ok(Terms { margin, notional, units, entry_price, leverage })
    }

    /// Value of the reference units at `price`, floored (micro-USD).
    pub fn value_at(&self, price: u128) -> MathResult<u128> {
        check_price(price)?;
        mul_div_floor(self.units, price, PRICE_SCALE)
    }

    /// Raw, unfloored trader P&L at `price` before charges: `Q*price - N`.
    pub fn raw_pnl(&self, price: u128) -> MathResult<i128> {
        isub(to_i128(self.value_at(price)?)?, to_i128(self.notional)?)
    }

    /// Nonrecourse user equity at `price` after charges `fees`: `max(0, M + raw_pnl - F)`.
    pub fn equity(&self, price: u128, fees: u128) -> MathResult<u128> {
        let e = isub(iadd(to_i128(self.margin)?, self.raw_pnl(price)?)?, to_i128(fees)?)?;
        Ok(pos(e))
    }

    /// Signed user profit `equity - M`, bounded below by `-M`, unbounded above by margin.
    pub fn profit(&self, price: u128, fees: u128) -> MathResult<i128> {
        isub(to_i128(self.equity(price, fees)?)?, to_i128(self.margin)?)
    }

    /// Terminal trader P&L before fees at a settlement payout `payout` (price scale), floored at
    /// `-M`. This is the per-scenario liability contribution used by the stress engine.
    pub fn scenario_pnl(&self, payout: u128) -> MathResult<i128> {
        let raw = self.raw_pnl(payout)?;
        let floor = -to_i128(self.margin)?;
        Ok(if raw < floor { floor } else { raw })
    }

    /// Event-derived maximum gross user profit before fees: `Q*(max_payout - p0)`.
    /// For a binary claim this is `L*M*(1-p0)/p0`.
    pub fn max_profit(&self, max_payout: u128) -> MathResult<u128> {
        Ok(pos(self.raw_pnl(max_payout)?))
    }

    /// Maximum total cash payout `M + max_profit` before fees.
    pub fn max_payout(&self, max_payout: u128) -> MathResult<u128> {
        add(self.margin, self.max_profit(max_payout)?)
    }

    /// Virtual financing base `(L-1)*M = N - M` used only to compute holding fees. This is not a
    /// loan and creates no receivable.
    pub fn virtual_financing_base(&self) -> u128 {
        self.notional.saturating_sub(self.margin)
    }

    /// Scale terms to an executed fraction (ppm). Margin, notional and units are floored.
    pub fn scale(&self, fraction_ppm: u128) -> MathResult<Terms> {
        if fraction_ppm == 0 || fraction_ppm > PPM {
            return Err(MathError::InvalidFraction);
        }
        Ok(Terms {
            margin: mul_div_floor(self.margin, fraction_ppm, PPM)?,
            notional: mul_div_floor(self.notional, fraction_ppm, PPM)?,
            units: mul_div_floor(self.units, fraction_ppm, PPM)?,
            entry_price: self.entry_price,
            leverage: self.leverage,
        })
    }

    /// Split off a fraction (ppm) for a partial close. Returns (closed, remaining) such that the
    /// two parts sum exactly to the original margin, notional and units, so no exposure is lost or
    /// created, and the remaining part keeps its full uncapped upside.
    pub fn split(&self, fraction_ppm: u128) -> MathResult<(Terms, Terms)> {
        if fraction_ppm == 0 || fraction_ppm > PPM {
            return Err(MathError::InvalidFraction);
        }
        let closed = Terms {
            margin: mul_div_floor(self.margin, fraction_ppm, PPM)?,
            notional: mul_div_floor(self.notional, fraction_ppm, PPM)?,
            units: mul_div_floor(self.units, fraction_ppm, PPM)?,
            entry_price: self.entry_price,
            leverage: self.leverage,
        };
        let remaining = Terms {
            margin: sub(self.margin, closed.margin)?,
            notional: sub(self.notional, closed.notional)?,
            units: sub(self.units, closed.units)?,
            entry_price: self.entry_price,
            leverage: self.leverage,
        };
        Ok((closed, remaining))
    }

    /// Maintenance check for losing positions: liquidatable when equity at the executable bid is at
    /// or below `maintenance_bps` of current position value plus a fixed cash buffer.
    pub fn is_liquidatable(
        &self,
        bid: u128,
        fees: u128,
        maintenance_bps: u128,
        maintenance_fixed: u128,
    ) -> MathResult<bool> {
        let equity_signed = isub(iadd(to_i128(self.margin)?, self.raw_pnl(bid)?)?, to_i128(fees)?)?;
        let req = add(mul_div_ceil(self.value_at(bid)?, maintenance_bps, BPS)?, maintenance_fixed)?;
        Ok(equity_signed <= to_i128(req)?)
    }

    /// Indicative liquidation bid, the price `x` where `M + Q*x - N - F = mbps*Q*x + fixed`:
    /// `x = (N - M + F + fixed) / (Q*(1 - mbps))`, floored: the highest bid at which
    /// `is_liquidatable` holds (up to one micro-unit of rounding). Jumps can skip this level.
    pub fn liquidation_price(
        &self,
        fees: u128,
        maintenance_bps: u128,
        maintenance_fixed: u128,
    ) -> MathResult<u128> {
        if maintenance_bps >= BPS {
            return Err(MathError::InvalidFraction);
        }
        let numer = add(add(self.virtual_financing_base(), fees)?, maintenance_fixed)?;
        let denom = mul_div_floor(self.units, BPS - maintenance_bps, BPS)?;
        if denom == 0 {
            return Ok(PRICE_SCALE);
        }
        let x = mul_div_floor(numer, PRICE_SCALE, denom)?;
        Ok(x.min(PRICE_SCALE))
    }
}

/// Illustrative tick-sensitivity leverage ceiling `L <= p0 / (k * tick)`, in `LEV_SCALE`.
pub fn tick_leverage_ceiling(entry_price: u128, tick: u128, min_adverse_ticks: u128) -> MathResult<u128> {
    let d = tick.checked_mul(min_adverse_ticks).ok_or(MathError::Overflow)?;
    mul_div_floor(entry_price, LEV_SCALE, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const D: u128 = USD;

    /// Spec section 5 example: M=$100, p0=$0.50, 5x -> N=$500, Q=1,000 units.
    #[test]
    fn spec_example_half_price_5x() {
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        assert_eq!(t.notional, 500 * D);
        assert_eq!(t.units, 1_000 * UNIT);
        // Mark 0.60: +$100 profit and still open (no cap).
        assert_eq!(t.profit(600_000, 0).unwrap(), 100 * D as i128);
        // YES resolution: +$500, payout $600.
        assert_eq!(t.profit(PRICE_SCALE, 0).unwrap(), 500 * D as i128);
        assert_eq!(t.equity(PRICE_SCALE, 0).unwrap(), 600 * D);
        assert_eq!(t.max_profit(PRICE_SCALE).unwrap(), 500 * D);
        assert_eq!(t.max_payout(PRICE_SCALE).unwrap(), 600 * D);
        // NO resolution: equity 0, loss exactly M.
        assert_eq!(t.equity(0, 0).unwrap(), 0);
        assert_eq!(t.profit(0, 0).unwrap(), -(100 * D as i128));
        assert_eq!(t.scenario_pnl(0).unwrap(), -(100 * D as i128));
        assert_eq!(t.virtual_financing_base(), 400 * D);
    }

    /// Spec fair-pricing example: $0.80 YES, M=$100, 5x -> Q=625, win +$125/$225, loss -$100.
    #[test]
    fn spec_example_080() {
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 800_000).unwrap();
        assert_eq!(t.units, 625 * UNIT);
        assert_eq!(t.profit(PRICE_SCALE, 0).unwrap(), 125 * D as i128);
        assert_eq!(t.equity(PRICE_SCALE, 0).unwrap(), 225 * D);
        assert_eq!(t.profit(0, 0).unwrap(), -(100 * D as i128));
    }

    #[test]
    fn profit_above_margin_is_not_capped() {
        let t = Terms::open(100 * D, 10 * LEV_SCALE, 200_000).unwrap();
        // Max profit = 10*100*(0.8)/0.2 = $4,000, i.e. 40x margin.
        assert_eq!(t.max_profit(PRICE_SCALE).unwrap(), 4_000 * D);
        assert!(t.profit(500_000, 0).unwrap() > 100 * D as i128);
    }

    #[test]
    fn tick_ceiling_matches_spec_formula() {
        // p0=0.50, tick 0.01, k=10 adverse ticks -> L <= 5x.
        assert_eq!(tick_leverage_ceiling(500_000, 10_000, 10).unwrap(), 5 * LEV_SCALE);
    }

    #[test]
    fn liquidation_price_is_consistent_with_check() {
        let t = Terms::open(100 * D, 5 * LEV_SCALE, 500_000).unwrap();
        let lp = t.liquidation_price(0, 500, 0).unwrap();
        assert!(t.is_liquidatable(lp, 0, 500, 0).unwrap());
        assert!(!t.is_liquidatable(lp + 10_000, 0, 500, 0).unwrap());
        // Without maintenance, liquidation at 0.40 consumes all margin: k_loss = p0/(L*tick) = 10.
        assert_eq!(t.liquidation_price(0, 0, 0).unwrap(), 400_000);
    }

    #[test]
    fn rejects_bad_inputs() {
        assert_eq!(Terms::open(D, LEV_SCALE - 1, 500_000), Err(MathError::InvalidLeverage));
        assert_eq!(Terms::open(D, LEV_SCALE, 0), Err(MathError::InvalidPrice));
        assert_eq!(Terms::open(D, LEV_SCALE, PRICE_SCALE), Err(MathError::InvalidPrice));
        assert_eq!(Terms::open(0, LEV_SCALE, 500_000), Err(MathError::Negative));
        let t = Terms::open(D, LEV_SCALE, 500_000).unwrap();
        assert_eq!(t.value_at(PRICE_SCALE + 1), Err(MathError::InvalidPrice));
        assert_eq!(t.scale(0), Err(MathError::InvalidFraction));
        assert_eq!(t.split(PPM + 1), Err(MathError::InvalidFraction));
    }

    proptest! {
        /// Invariant: loss never exceeds margin, at any price and any fee.
        #[test]
        fn loss_floor_is_minus_margin(
            m in 1u128..10_000_000 * D,
            l in LEV_SCALE..=50 * LEV_SCALE,
            p0 in 1u128..PRICE_SCALE,
            price in 0u128..=PRICE_SCALE,
            fees in 0u128..1_000_000 * D,
        ) {
            let t = Terms::open(m, l, p0).unwrap();
            let profit = t.profit(price, fees).unwrap();
            prop_assert!(profit >= -(m as i128));
            prop_assert!(t.equity(price, fees).unwrap() <= t.max_payout(PRICE_SCALE).unwrap());
        }

        /// Invariant: winning settlement equals the payoff formula exactly, no +M clamp.
        #[test]
        fn winning_settlement_matches_formula(
            m in 1u128..10_000_000 * D,
            l in LEV_SCALE..=50 * LEV_SCALE,
            p0 in 1u128..PRICE_SCALE,
        ) {
            let t = Terms::open(m, l, p0).unwrap();
            let expected = (t.units as i128) - (t.notional as i128); // Q*1 - N
            prop_assert_eq!(t.profit(PRICE_SCALE, 0).unwrap(), expected.max(-(m as i128)));
            // Rounding never favours the trader: Q*p0 <= N.
            prop_assert!(t.value_at(p0).unwrap() <= t.notional);
            // And loses at most one price tick of a micro-unit relative to exact math.
            prop_assert!(t.notional - t.value_at(p0).unwrap() <= 1);
        }

        /// Partial close conserves exposure exactly and keeps the remaining upside uncapped.
        #[test]
        fn split_conserves(
            m in 1u128..10_000_000 * D,
            l in LEV_SCALE..=20 * LEV_SCALE,
            p0 in 1u128..PRICE_SCALE,
            f in 1u128..=PPM,
        ) {
            let t = Terms::open(m, l, p0).unwrap();
            let (a, b) = t.split(f).unwrap();
            prop_assert_eq!(a.margin + b.margin, t.margin);
            prop_assert_eq!(a.notional + b.notional, t.notional);
            prop_assert_eq!(a.units + b.units, t.units);
            // At full payout one unit is worth one micro-USD, so the parts' P&L sums exactly.
            prop_assert_eq!(
                a.raw_pnl(PRICE_SCALE).unwrap() + b.raw_pnl(PRICE_SCALE).unwrap(),
                t.raw_pnl(PRICE_SCALE).unwrap()
            );
            // The remaining part keeps its full event-derived upside.
            prop_assert_eq!(b.max_profit(PRICE_SCALE).unwrap(),
                (b.units as i128 - b.notional as i128).max(0) as u128);
        }

        /// Liquidation check is monotone: lower bid never makes a position safer.
        #[test]
        fn liquidation_monotone(
            m in D..1_000_000 * D,
            l in LEV_SCALE..=20 * LEV_SCALE,
            p0 in 10_000u128..990_000,
            b1 in 0u128..=PRICE_SCALE,
            b2 in 0u128..=PRICE_SCALE,
            mbps in 0u128..2_000,
        ) {
            let t = Terms::open(m, l, p0).unwrap();
            let (lo, hi) = if b1 <= b2 { (b1, b2) } else { (b2, b1) };
            if t.is_liquidatable(hi, 0, mbps, 0).unwrap() {
                prop_assert!(t.is_liquidatable(lo, 0, mbps, 0).unwrap());
            }
        }
    }
}
