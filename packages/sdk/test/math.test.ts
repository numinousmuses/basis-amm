import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as m from "../src/math.js";
import { BPS, PRICE_SCALE, USD } from "../src/units.js";

const vectors = JSON.parse(readFileSync(new URL("../../../crates/basis-math/vectors/vectors.json", import.meta.url), "utf8"));

describe("TS math mirrors Rust basis-math bit for bit", () => {
  for (const v of vectors) {
    it(`M=${v.margin} L=${v.leverage} p0=${v.entry}`, () => {
      const t = m.openTerms(BigInt(v.margin), BigInt(v.leverage), BigInt(v.entry));
      expect(t.notional.toString()).toBe(v.notional);
      expect(t.units.toString()).toBe(v.units);
      expect(m.equity(t, 600_000n).toString()).toBe(v.equity_at_060);
      expect(m.profit(t, PRICE_SCALE).toString()).toBe(v.profit_at_1);
      expect(m.scenarioPnl(t, 0n).toString()).toBe(v.scenario_pnl_0);
      expect(m.maxProfit(t).toString()).toBe(v.max_profit);
      expect(m.liquidationPrice(t, 0n, 500n, 0n).toString()).toBe(v.liq_price_500bps);
      expect(m.openFee(t.notional, 10n).toString()).toBe(v.open_fee_10bps);
      expect(m.holdingFee(m.financingBase(t), 1000n, 30n * 24n * 3600n * 1_000_000_000n).toString()).toBe(v.hold_fee_1000bps_30d);
      const probs = m.impliedProbabilities([t.entryPrice, PRICE_SCALE - t.entryPrice]);
      expect(probs.map(String)).toEqual(v.probs);
      const ev = m.holdToResolutionEv(t, [PRICE_SCALE, 0n], probs);
      expect(ev.toString()).toBe(v.ev);
      expect(m.requiredRiskPremium(ev, BPS).toString()).toBe(v.premium_full);
      expect(m.sharesForDeposit(BigInt(v.margin), 0n, 0n).toString()).toBe(v.shares_first);
      expect(m.sharesForDeposit(BigInt(v.margin), 1000n * USD, 1100n * USD).toString()).toBe(v.shares_after);
    });
  }

  it("spec section 5 example", () => {
    const t = m.openTerms(100n * USD, 50_000n, 500_000n);
    expect(m.profit(t, 600_000n)).toBe(100n * USD);
    expect(m.equity(t, PRICE_SCALE)).toBe(600n * USD);
    expect(m.equity(t, 0n)).toBe(0n);
  });
});
