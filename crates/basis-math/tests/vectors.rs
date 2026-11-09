//! Generates deterministic cross-language test vectors consumed by `packages/sdk/test/math.test.ts`.
//! Run `cargo test -p basis-math --test vectors` to refresh `vectors/vectors.json`.

use basis_math::*;
use basis_math::position::Terms;

#[test]
fn write_vectors() {
    let cases: &[(u128, u128, u128)] = &[
        (100 * USD, 5 * LEV_SCALE, 500_000),
        (100 * USD, 5 * LEV_SCALE, 800_000),
        (250 * USD, 3 * LEV_SCALE, 333_333),
        (1_234_567, 25_000, 71_000),
        (10 * USD, 10 * LEV_SCALE, 950_000),
        (99_999 * USD, 2 * LEV_SCALE, 10_000),
    ];
    let mut out = vec![];
    for (m, l, p) in cases {
        let t = Terms::open(*m, *l, *p).unwrap();
        let probs = fair::implied_probabilities(&[*p, PRICE_SCALE - *p]).unwrap();
        let ev = fair::hold_to_resolution_ev(&t, &[PRICE_SCALE, 0], &probs).unwrap();
        out.push(serde_json::json!({
            "margin": m.to_string(), "leverage": l.to_string(), "entry": p.to_string(),
            "notional": t.notional.to_string(), "units": t.units.to_string(),
            "equity_at_060": t.equity(600_000, 0).unwrap().to_string(),
            "profit_at_1": t.profit(PRICE_SCALE, 0).unwrap().to_string(),
            "scenario_pnl_0": t.scenario_pnl(0).unwrap().to_string(),
            "max_profit": t.max_profit(PRICE_SCALE).unwrap().to_string(),
            "liq_price_500bps": t.liquidation_price(0, 500, 0).unwrap().to_string(),
            "open_fee_10bps": fees::open_fee(t.notional, 10).unwrap().to_string(),
            "hold_fee_1000bps_30d": fees::holding_fee(t.virtual_financing_base(), 1_000, 30 * 24 * 3600 * 1_000_000_000).unwrap().to_string(),
            "probs": probs.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
            "ev": ev.to_string(),
            "premium_full": fair::required_risk_premium(ev, BPS).unwrap().to_string(),
            "shares_first": vault::shares_for_deposit(*m, 0, 0).unwrap().to_string(),
            "shares_after": vault::shares_for_deposit(*m, 1_000 * USD, 1_100 * USD).unwrap().to_string(),
        }));
    }
    let s = serde_json::to_string_pretty(&out).unwrap();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/vectors.json");
    std::fs::write(path, s + "\n").unwrap();
}
