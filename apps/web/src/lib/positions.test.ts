import { describe, expect, it } from "vitest";
import type { Position, PositionView } from "@basis/sdk";
import { hasRamp, rampNote, rampPhase, rampStatus, rampText, realizedPnlSeries, shortPct } from "./positions";

const S = 1_000_000_000n; // ns per second
const iso = (ms: number) => new Date(ms).toISOString();
const START_S = 1_794_600_000n;
const END_S = START_S + 172_800n; // two days
const ramp = { maintenance_bps: 500, ramp_maintenance_bps: 5000, ramp_start_ns: (START_S * S).toString(), ramp_end_ns: (END_S * S).toString() };

describe("maintenance ramp", () => {
  it("formats bps as short percents", () => {
    expect(shortPct(500)).toBe("5%");
    expect(shortPct(5000)).toBe("50%");
    expect(shortPct(250)).toBe("2.5%");
    expect(shortPct(1234)).toBe("12.34%");
  });
  it("says what the ramp does and when, in one sentence", () => {
    expect(rampText(ramp, iso)).toBe(`Maintenance for losing positions rises from 5% to 50% between ${iso(Number(START_S) * 1000)} and ${iso(Number(END_S) * 1000)}.`);
  });
  it("says when there is no ramp", () => {
    expect(hasRamp({ ...ramp, ramp_maintenance_bps: 500 })).toBe(false);
    expect(rampText({ ...ramp, ramp_maintenance_bps: 500 }, iso)).toBe("Maintenance stays at 5%; this position has no pre-resolution ramp.");
    // top below base is not a ramp either (contract uses max(base, top))
    expect(hasRamp({ ...ramp, ramp_maintenance_bps: 300 })).toBe(false);
    // degenerate window
    expect(hasRamp({ ...ramp, ramp_end_ns: ramp.ramp_start_ns })).toBe(false);
    expect(hasRamp({ ...ramp, ramp_maintenance_bps: 0 })).toBe(false);
  });
  it("tracks the phase", () => {
    const at = (s: bigint) => Number(s) * 1000;
    expect(rampPhase(ramp, at(START_S - 10n))).toBe("before");
    expect(rampPhase(ramp, at(START_S + 10n))).toBe("ramping");
    expect(rampPhase(ramp, at(END_S))).toBe("done");
    expect(rampNote(ramp, at(START_S - 10n))).toBe("ramp not started");
    expect(rampStatus({ effective_maintenance_bps: 2750, position: ramp }, at(START_S + 86_400n))).toBe("27.5% now · ramping, applies while losing");
    expect(rampStatus({ effective_maintenance_bps: 500, position: { ...ramp, ramp_maintenance_bps: 500 } })).toBe("5% now · no ramp");
  });
});

const pos = (id: string, state: Position["state"], openedS: number, closedS: number | null, pnl: string): Pick<PositionView, "position"> =>
  ({ position: { position_id: id, state, opened_ns: (BigInt(openedS) * S).toString(), closed_ns: closedS === null ? null : (BigInt(closedS) * S).toString(), realized_pnl: pnl } }) as unknown as Pick<PositionView, "position">;

describe("cumulative realized P&L series", () => {
  it("steps at each close time, sorted, starting from zero at the first open", () => {
    const r = realizedPnlSeries([pos("3", "Closed", 150, 400, "-5000000"), pos("1", "Closed", 100, 200, "12000000"), pos("2", "Open", 120, null, "0"), pos("4", "Settled", 110, 300, "3000000")]);
    expect(r.total).toBe(10_000_000n);
    expect(r.skipped).toBe(0);
    expect(r.points.map((p) => [p.x / 1000, Number(p.y) / 1e6])).toEqual([
      [100, 0],
      [200, 0],
      [200, 12],
      [300, 12],
      [300, 15],
      [400, 15],
      [400, 10],
    ]);
    expect(r.points.at(-1)?.positionId).toBe("3");
  });
  it("is empty with no closed positions and counts closes without a time", () => {
    expect(realizedPnlSeries([pos("1", "Open", 1, null, "0")])).toEqual({ points: [], total: 0n, skipped: 0 });
    const r = realizedPnlSeries([pos("1", "Liquidated", 1, null, "-1"), pos("2", "Closed", 5, 10, "2000000")]);
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(2_000_000n);
    expect(r.points).toHaveLength(3);
  });
});
