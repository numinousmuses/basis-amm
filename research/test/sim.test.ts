import { describe, expect, it } from "vitest";
import { openTerms, equity, PRICE_SCALE } from "@basis/sdk";
import { DEFAULTS, runFamily, simulateTrade } from "../src/sim.js";
import { FAMILIES, mulberry32, simulatePath } from "../src/paths.js";

describe("simulator", () => {
  it("is deterministic for a seed", () => {
    const a = runFamily(FAMILIES[0], { ...DEFAULTS, eventsPerFamily: 20 });
    const b = runFamily(FAMILIES[0], { ...DEFAULTS, eventsPerFamily: 20 });
    expect(a).toEqual(b);
  });

  it("never charges a trader more than margin, and some traders win more than margin", () => {
    const r = mulberry32(1);
    let beat = 0;
    for (let e = 0; e < 200; e++) {
      const p = simulatePath(FAMILIES[1], r);
      for (let k = 0; k < 20; k++) {
        const t = simulateTrade(p, FAMILIES[1], DEFAULTS, r);
        expect(t.payout).toBeGreaterThanOrEqual(0);
        // POOL_ONLY vault P&L from one trade is at most margin + upfront fees and at least -maxProfit.
        expect(t.vaultPnl.POOL_ONLY).toBeLessThanOrEqual(t.margin + t.fees.open + t.fees.premium + 1e-9);
        expect(t.vaultPnl.POOL_ONLY).toBeGreaterThanOrEqual(-t.maxProfit - 1e-9);
        if (t.payout > 2 * t.margin) beat++;
      }
    }
    expect(beat).toBeGreaterThan(0);
  });

  it("resolution payoff matches the contract's fixed-point formula", () => {
    const t = openTerms(100_000_000n, 50_000n, 500_000n);
    expect(Number(equity(t, PRICE_SCALE)) / 1e6).toBe(100 + (500 / 0.5) * (1 - 0.5));
  });

  it("exact hedges trade winning-state risk for adverse-state risk", () => {
    const rep = runFamily(FAMILIES[0], { ...DEFAULTS, eventsPerFamily: 60 });
    expect(rep.strategies.EXACT_HEDGE.worstEventLoss).not.toBe(rep.strategies.POOL_ONLY.worstEventLoss);
    expect(rep.strategies.MARGIN_ESCROW.totalPnl).toBe(rep.strategies.EXACT_HEDGE.totalPnl);
    expect(rep.strategies.MARGIN_ESCROW.peakCapitalPerEvent).toBeLessThan(rep.strategies.EXACT_HEDGE.peakCapitalPerEvent);
  });
});
