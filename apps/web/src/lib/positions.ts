/** Position helpers: the pre-resolution maintenance ramp and the realized P&L series. */
import type { Position, PositionView } from "@basis/sdk";
import { big, fmtDate, nsToMs } from "./format";

/** Basis points as a short percent: 500 -> "5%", 250 -> "2.5%", 1234 -> "12.34%". */
export function shortPct(bps: number | bigint): string {
  const v = Number(bps) / 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
}

export type RampPhase = "none" | "before" | "ramping" | "done";

type RampFields = Pick<Position, "maintenance_bps" | "ramp_maintenance_bps" | "ramp_start_ns" | "ramp_end_ns">;

/** True when maintenance rises before resolution (same test as the contract's
 * `effective_maintenance_bps`). */
export function hasRamp(p: RampFields): boolean {
  return !!p.ramp_maintenance_bps && p.ramp_maintenance_bps > p.maintenance_bps && big(p.ramp_end_ns ?? 0) > big(p.ramp_start_ns ?? 0);
}

/** Where the position is on its ramp at `nowMs`. The ramp is pinned at open, so later policy
 * versions never change it. */
export function rampPhase(p: RampFields, nowMs = Date.now()): RampPhase {
  if (!hasRamp(p)) return "none";
  const start = nsToMs(p.ramp_start_ns);
  const end = nsToMs(p.ramp_end_ns);
  if (nowMs < start) return "before";
  if (nowMs < end) return "ramping";
  return "done";
}

/** One plain sentence about the ramp, e.g. "Maintenance for losing positions rises from 5% to 50%
 * between Nov 14, 10:00 AM and Nov 16, 10:00 AM." */
export function rampText(p: RampFields, fmt: (ms: number) => string = fmtDate): string {
  if (!hasRamp(p)) return `Maintenance stays at ${shortPct(p.maintenance_bps)}; this position has no pre-resolution ramp.`;
  return `Maintenance for losing positions rises from ${shortPct(p.maintenance_bps)} to ${shortPct(p.ramp_maintenance_bps)} between ${fmt(nsToMs(p.ramp_start_ns))} and ${fmt(nsToMs(p.ramp_end_ns))}.`;
}

const PHASE_NOTE: Record<RampPhase, string> = {
  none: "no ramp",
  before: "ramp not started",
  ramping: "ramping, applies while losing",
  done: "ramp complete, applies while losing",
};

/** Short note on where the ramp stands, e.g. "ramp not started". */
export const rampNote = (p: RampFields, nowMs = Date.now()) => PHASE_NOTE[rampPhase(p, nowMs)];

/** Effective maintenance (from the contract view) with the ramp note: "5% now · ramp not started". */
export function rampStatus(v: Pick<PositionView, "effective_maintenance_bps"> & { position: RampFields }, nowMs = Date.now()): string {
  return `${shortPct(v.effective_maintenance_bps ?? v.position.maintenance_bps)} now · ${rampNote(v.position, nowMs)}`;
}

export interface PnlPoint {
  x: number;
  /** cumulative realized P&L in micro-USD */
  y: bigint;
  positionId?: string;
}

/** Cumulative realized P&L over close time. Each close adds a step: the line holds the previous
 * total until `closed_ns`, then jumps by that position's realized P&L. The series starts at zero at
 * the first closed position's open time. Positions without `closed_ns` are skipped and counted. */
export function realizedPnlSeries(positions: Array<Pick<PositionView, "position">>): { points: PnlPoint[]; total: bigint; skipped: number } {
  const closed = positions.map((v) => v.position).filter((p) => p.state !== "Open");
  const timed = closed.filter((p) => p.closed_ns !== null && p.closed_ns !== undefined && big(p.closed_ns) > 0n).sort((a, b) => (big(a.closed_ns!) < big(b.closed_ns!) ? -1 : big(a.closed_ns!) > big(b.closed_ns!) ? 1 : 0));
  const skipped = closed.length - timed.length;
  if (!timed.length) return { points: [], total: 0n, skipped };
  const firstOpen = timed.reduce((a, p) => (big(p.opened_ns) < a ? big(p.opened_ns) : a), big(timed[0].closed_ns!));
  const points: PnlPoint[] = [{ x: nsToMs(firstOpen), y: 0n }];
  let total = 0n;
  for (const p of timed) {
    const x = nsToMs(p.closed_ns!);
    points.push({ x, y: total });
    total += big(p.realized_pnl);
    points.push({ x, y: total, positionId: p.position_id });
  }
  return { points, total, skipped };
}
