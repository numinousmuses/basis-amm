//! bLP share math with a virtual-share offset that neutralises first-depositor inflation attacks.
//! Deposits round shares down; withdrawals round assets down: rounding never benefits the actor.

use crate::fixed::*;

pub const VIRTUAL_SHARES: u128 = 1_000_000;
pub const VIRTUAL_ASSETS: u128 = 1_000_000;

/// Shares minted for `amount` collateral given conservative `nav` and `supply`.
pub fn shares_for_deposit(amount: u128, supply: u128, nav: u128) -> MathResult<u128> {
    mul_div_floor(amount, add(supply, VIRTUAL_SHARES)?, add(nav, VIRTUAL_ASSETS)?)
}

/// Collateral redeemable for `shares`.
pub fn assets_for_shares(shares: u128, supply: u128, nav: u128) -> MathResult<u128> {
    mul_div_floor(shares, add(nav, VIRTUAL_ASSETS)?, add(supply, VIRTUAL_SHARES)?)
}

/// Share price in price scale (`PRICE_SCALE` == 1 USD per bLP when decimals match).
pub fn share_price(supply: u128, nav: u128) -> MathResult<u128> {
    mul_div_floor(add(nav, VIRTUAL_ASSETS)?, PRICE_SCALE, add(supply, VIRTUAL_SHARES)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn first_deposit_is_one_to_one() {
        assert_eq!(shares_for_deposit(100_000 * USD, 0, 0).unwrap(), 100_000 * USD);
        assert_eq!(share_price(0, 0).unwrap(), PRICE_SCALE);
    }

    #[test]
    fn donation_attack_is_unprofitable() {
        // Attacker deposits 1 micro-unit, then donates $10k to inflate NAV.
        let s_att = shares_for_deposit(1, 0, 0).unwrap();
        let nav = 1 + 10_000 * USD;
        let s_victim = shares_for_deposit(5_000 * USD, s_att, nav).unwrap();
        assert!(s_victim > 0);
        let supply = s_att + s_victim;
        let nav2 = nav + 5_000 * USD;
        let att_out = assets_for_shares(s_att, supply, nav2).unwrap();
        // Attacker cannot recover the donation.
        assert!(att_out < 10_000 * USD);
    }

    proptest! {
        #[test]
        fn round_trip_never_profits(amount in 1u128..1_000_000_000 * USD, supply in 0u128..1_000_000_000 * USD, nav in 0u128..1_000_000_000 * USD) {
            let s = shares_for_deposit(amount, supply, nav).unwrap();
            let back = assets_for_shares(s, supply + s, nav + amount).unwrap();
            prop_assert!(back <= amount);
        }
    }
}
