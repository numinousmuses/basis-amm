import { describe, expect, it } from "vitest";
import { buildIntent, defaultMaxFee, effectiveMinFill, intentDeadlineNs, leverageCap, leverageCapReason, maxEntryWithSlippage, minExitWithSlippage, nextNonce, orderTimeline, parseOrderResult } from "./intent";

const policy = { max_order_lifetime_ns: "600000000000", min_fill_floor_ppm: "100000", max_hedge_slippage_bps: 200 };
const base = {
  marketId: "pm-btc",
  outcomeId: 0,
  policyHash: "ab".repeat(32),
  policy,
  margin: 100_000_000n,
  leverage: 30_000n,
  maxFee: 8_000_000n,
  maxEntryPrice: 520_000n,
  allowPartialFill: true,
  minFillPpm: 500_000n,
  quoteId: "q-1",
  nowMs: 1_700_000_000_000,
  nonce: 42n,
};

describe("buildIntent", () => {
  it("builds the exact OrderIntent the contract expects", () => {
    const i = buildIntent(base);
    expect(i).toEqual({
      nonce: "42",
      market_id: "pm-btc",
      outcome_id: 0,
      margin_amount: "100000000",
      requested_leverage: "30000",
      max_entry_price: "520000",
      max_hedge_slippage_bps: 200,
      max_fee: "8000000",
      deadline_ns: (1_700_000_000_000n * 1_000_000n + 300_000_000_000n).toString(),
      take_profit_price: null,
      stop_loss_price: null,
      allow_partial_fill: true,
      minimum_acceptable_fill_ppm: "500000",
      policy_hash: "ab".repeat(32),
      quote_id: "q-1",
    });
  });

  it("locks the minimum fill at 100% when partial fills are off", () => {
    const i = buildIntent({ ...base, allowPartialFill: false, minFillPpm: 300_000n });
    expect(i.allow_partial_fill).toBe(false);
    expect(i.minimum_acceptable_fill_ppm).toBe("1000000");
  });

  it("clamps the minimum fill to the policy floor", () => {
    expect(buildIntent({ ...base, minFillPpm: 1_000n }).minimum_acceptable_fill_ppm).toBe("100000");
    expect(buildIntent({ ...base, minFillPpm: 2_000_000n }).minimum_acceptable_fill_ppm).toBe("1000000");
  });

  it("serializes triggers and rejects invalid input", () => {
    const i = buildIntent({ ...base, takeProfit: 900_000n, stopLoss: 300_000n });
    expect(i.take_profit_price).toBe("900000");
    expect(i.stop_loss_price).toBe("300000");
    expect(() => buildIntent({ ...base, margin: 0n })).toThrow(/Margin/);
    expect(() => buildIntent({ ...base, leverage: 9_999n })).toThrow(/Leverage/);
    expect(() => buildIntent({ ...base, maxEntryPrice: 1_000_000n })).toThrow(/entry/);
    expect(() => buildIntent({ ...base, takeProfit: 1_000_001n })).toThrow(/Trigger/);
  });

  it("keeps the deadline inside the policy order lifetime", () => {
    expect(intentDeadlineNs(0, 600_000_000_000n)).toBe(300_000_000_000n);
    expect(intentDeadlineNs(0, 60_000_000_000n)).toBe(50_000_000_000n);
    expect(intentDeadlineNs(1, 600_000_000_000n)).toBe(1_000_000n + 300_000_000_000n);
  });
});

describe("helpers", () => {
  it("issues strictly increasing nonces even within one millisecond", () => {
    const a = nextNonce(1000);
    const b = nextNonce(1000);
    const c = nextNonce(999);
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
  });

  it("effectiveMinFill", () => {
    expect(effectiveMinFill(false, 0n, 100_000n)).toBe(1_000_000n);
    expect(effectiveMinFill(true, 50_000n, 100_000n)).toBe(100_000n);
    expect(effectiveMinFill(true, 750_000n, 100_000n)).toBe(750_000n);
    expect(effectiveMinFill(true, 0n, 0n)).toBe(1n);
  });

  it("default fee cap is 1.5x the upfront fee plus a cent, rounded up to a cent", () => {
    expect(defaultMaxFee(5_200_000n)).toBe(7_810_000n);
    expect(defaultMaxFee(0n)).toBe(10_000n);
    expect(defaultMaxFee(1n) % 10_000n).toBe(0n);
  });

  it("slippage bounds", () => {
    expect(maxEntryWithSlippage(500_000n, 200)).toBe(510_000n);
    expect(maxEntryWithSlippage(985_000n, 200)).toBe(990_000n);
    expect(minExitWithSlippage(500_000n, 300)).toBe(485_000n);
    expect(minExitWithSlippage(0n, 300)).toBe(0n);
  });

  it("leverage cap is the minimum of policy, protocol and tick ceilings", () => {
    const p = { policy_max_leverage: "50000", protocol_max_leverage: "100000", tick_leverage_ceiling: "32000" };
    expect(leverageCap(p)).toBe(32_000n);
    expect(leverageCapReason(p)).toMatch(/Tick-sensitivity/);
    expect(leverageCapReason({ ...p, tick_leverage_ceiling: "90000" })).toMatch(/policy/);
    expect(leverageCapReason({ policy_max_leverage: "200000", protocol_max_leverage: "100000", tick_leverage_ceiling: "150000" })).toMatch(/Protocol/);
  });
});

describe("order results", () => {
  it("parses contract result strings", () => {
    expect(parseOrderResult({ state: "Executed", result: "OPEN position 7 fill_ppm 1000000", position_id: "7" })).toEqual({ kind: "open", positionId: "7", fillPpm: 1_000_000n });
    expect(parseOrderResult({ state: "Executed", result: "OPEN position 1 hedged fill_ppm 500000", position_id: "1" })).toEqual({ kind: "open", positionId: "1", fillPpm: 500_000n });
    expect(parseOrderResult({ state: "Executed", result: "CLOSED:7:partial", position_id: "7" })).toEqual({ kind: "closed", positionId: "7", full: false });
    expect(parseOrderResult({ state: "Rejected", result: "FAIR_VALUE: required risk premium 1 + open fee 2 exceeds signed max_fee 0", position_id: null })).toMatchObject({ kind: "rejected" });
    expect(parseOrderResult({ state: "Expired", result: null, position_id: null })).toEqual({ kind: "rejected", reason: "EXPIRED" });
    expect(parseOrderResult({ state: "Requested", result: null, position_id: null })).toEqual({ kind: "none" });
    expect(parseOrderResult({ state: "Hedging", result: null, position_id: null })).toEqual({ kind: "reserved" });
  });

  it("pool-only timeline never claims a hedge step happened", () => {
    const req = orderTimeline("Requested", "PoolOnly");
    expect(req.map((s) => s.status)).toEqual(["done", "skipped", "skipped", "skipped", "active"]);
    const done = orderTimeline("Executed", "PoolOnly");
    expect(done.map((s) => s.status)).toEqual(["done", "skipped", "skipped", "skipped", "done"]);
    const rej = orderTimeline("Rejected", "PoolOnly", "RISK_LIMIT: no vault capacity");
    expect(rej.at(-1)).toMatchObject({ state: "Rejected", status: "failed", note: "RISK_LIMIT: no vault capacity" });
    expect(rej[4].status).toBe("pending");
  });

  it("hedge-required timeline walks every state", () => {
    expect(orderTimeline("Hedging", "HedgeRequired").map((s) => s.status)).toEqual(["done", "done", "active", "pending", "pending"]);
    expect(orderTimeline("Submitting", "HedgeRequired").every((s) => s.status === "pending")).toBe(true);
  });
});
