import { describe, expect, it } from "vitest";
import type { StoredMark } from "@basis/sdk";
import { bpsPct, cents, depthUsd, fmtSeconds, isSimulatedSource, levX, markDepthUsd, midOf, ppmPct, priceUsd, ratioPct, shortHash, signedUsd, timeAgo, units, usd } from "./format";
import { errorCode, explainError, explainReason } from "./errors";
import { parseHash } from "./app";
import { fmtDetail } from "../pages/Activity";

const mark = (outcomes: Array<{ bid: string; ask: string; size?: string }>): StoredMark =>
  ({
    report: { source_chain: "mock-venue:polygon-sim", outcomes: outcomes.map((o, i) => ({ outcome_id: i, bids: [{ price: o.bid, size: o.size ?? "1000000" }], asks: [{ price: o.ask, size: o.size ?? "1000000" }] })) },
  }) as unknown as StoredMark;

describe("money and price formatting", () => {
  it("formats micro-unit money with the SDK formatter", () => {
    expect(usd("100000000")).toBe("$100.00");
    expect(usd(1_234_567_890n)).toBe("$1,234.56");
    expect(usd("-2500000")).toBe("-$2.50");
    expect(usd(null)).toBe("$0.00");
    expect(usd("1500000", 0)).toBe("$1");
  });
  it("signs P&L", () => {
    expect(signedUsd("100000000")).toBe("+$100.00");
    expect(signedUsd("-1")).toBe("-$0.00");
    expect(signedUsd("0")).toBe("$0.00");
  });
  it("prices in 1e6", () => {
    expect(cents("505000")).toBe("50.5¢");
    expect(cents(500000n)).toBe("50¢");
    expect(cents(null)).toBe("n/a");
    expect(priceUsd("505000")).toBe("$0.5050");
    expect(priceUsd("1000000")).toBe("$1.0000");
  });
  it("leverage, ppm, bps, units", () => {
    expect(levX("30000")).toBe("3x");
    expect(levX("25000")).toBe("2.5x");
    expect(ppmPct("500000")).toBe("50%");
    expect(ppmPct("1000000", 0)).toBe("100%");
    expect(bpsPct(10)).toBe("0.10%");
    expect(bpsPct(1000)).toBe("10.00%");
    expect(units("600000000")).toBe("600");
  });
  it("ratios and durations", () => {
    expect(ratioPct(1n, 4n)).toBe(25);
    expect(ratioPct(5n, 0n)).toBe(0);
    expect(ratioPct(9n, 4n)).toBe(100);
    expect(fmtSeconds(59)).toBe("59s");
    expect(fmtSeconds(61)).toBe("1m 1s");
    expect(fmtSeconds(7200)).toBe("2h 0m");
    expect(timeAgo(1000, 1000)).toBe("just now");
    expect(timeAgo(0, 30_000)).toBe("30s ago");
    expect(shortHash("abcdef0123456789abcdef", 4)).toBe("abcd…cdef");
  });
  it("mids and depth from a signed mark", () => {
    const m = mark([{ bid: "490000", ask: "500000", size: "2000000" }, { bid: "500000", ask: "510000" }]);
    expect(midOf(m, 0)).toBe(495_000n);
    expect(midOf(m, 1)).toBe(505_000n);
    expect(midOf(m, 2)).toBeNull();
    expect(midOf(null, 0)).toBeNull();
    expect(depthUsd([{ price: "500000", size: "2000000" }])).toBe(1_000_000n);
    expect(markDepthUsd(m)).toBe(980_000n + 1_000_000n + 500_000n + 510_000n);
    expect(isSimulatedSource("mock-venue:polygon-sim")).toBe(true);
    expect(isSimulatedSource("polygon:137:polymarket-clob")).toBe(false);
  });
});

describe("error mapping", () => {
  it("extracts codes from contract panics", () => {
    expect(errorCode("Smart contract panicked: PARTIAL_FILL: all-or-none requires minimum_acceptable_fill_ppm = 1000000")).toBe("PARTIAL_FILL");
    expect(errorCode("RISK_LIMIT: leverage")).toBe("RISK_LIMIT");
    expect(errorCode("ft_transfer_call: POLICY_MISMATCH: sign the current policy hash")).toBe("POLICY_MISMATCH");
    expect(errorCode("SOMETHING_NEW: x")).toBe("SOMETHING_NEW");
  });
  it("maps every spec error code to plain English", () => {
    for (const c of ["MARKET_CLOSE_ONLY", "PRICE_STALE", "HEDGE_REJECTED", "PARTIAL_FILL", "RISK_LIMIT", "SLIPPAGE", "LIQUIDATION_PENDING", "ORACLE_DISPUTED", "SETTLEMENT_PENDING", "VAULT_PAUSED", "POLYGON_RECONCILIATION_FAILED", "FAIR_VALUE", "POLICY_MISMATCH"]) {
      const e = explainError(`${c}: detail`);
      expect(e.code).toBe(c);
      expect(e.message.length).toBeGreaterThan(30);
      expect(e.message).not.toMatch(/[A-Z]{4,}_[A-Z]+/);
    }
  });
  it("keeps the raw reason and surfaces the inner restriction", () => {
    const e = explainError('OPEN_NOT_ALLOWED: ["GUARDIAN_CLOSE_ONLY"]');
    expect(e.code).toBe("GUARDIAN_CLOSE_ONLY");
    expect(e.raw).toContain("OPEN_NOT_ALLOWED");
    const f = explainError("FAIR_VALUE: required risk premium 4900000 + open fee 300000 exceeds signed max_fee 10000");
    expect(f.title).toMatch(/Fee cap/);
    expect(f.raw).toContain("4900000");
    expect(explainError(new Error("boom")).message).toBe("boom");
  });
  it("explains market restriction reasons", () => {
    expect(explainReason("SETTLEMENT_PENDING")).toMatch(/resolving/);
    expect(explainReason("EVENT_WINDOW_CLOSE_ONLY: halftime")).toMatch(/event window/i);
    expect(explainReason("UNHEARD_OF")).toBe("UNHEARD_OF");
  });
});

describe("routing and activity", () => {
  it("parses hash routes", () => {
    expect(parseHash("")).toEqual({ page: "markets", arg: undefined });
    expect(parseHash("#/trade/pm-btc-above-100k-daily")).toEqual({ page: "trade", arg: "pm-btc-above-100k-daily" });
    expect(parseHash("#/admin/mock")).toEqual({ page: "admin", arg: "mock" });
  });
  it("formats audit event details by field type", () => {
    const s = fmtDetail({ position_id: 3, margin: "100000000", entry_price: "505000", leverage: "30000", pnl: "-2500000", fill_fraction_ppm: "500000", nested: { x: 1 } });
    expect(s).toContain("margin $100.00");
    expect(s).toContain("entry_price 50.5¢");
    expect(s).toContain("leverage 3x");
    expect(s).toContain("pnl -$2.50");
    expect(s).toContain("fill_fraction 50%");
    expect(s).not.toContain("nested");
  });
});
