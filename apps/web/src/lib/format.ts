/** Display helpers. Every amount from the contract is a bigint string in fixed point:
 * money in micro-units (6 decimals), prices in 1e6, leverage in 1e4, fractions in ppm. Money
 * formatting goes through the SDK formatters so the UI and the SDK never disagree. */
import { fmtUsd, fixedToDecimal, type BookLevel, type OutcomeBook, type StoredMark } from "@basis/sdk";

export type Big = bigint | string | number;
export const big = (v: Big | null | undefined): bigint => (v === null || v === undefined || v === "" ? 0n : BigInt(v));

/** "$1,234.56" with the SDK formatter. */
export const usd = (v: Big | null | undefined, frac = 2) => fmtUsd(big(v), frac);

/** "+$12.00" / "-$3.10" / "$0.00" for P&L values. */
export function signedUsd(v: Big | null | undefined, frac = 2): string {
  const b = big(v);
  if (b === 0n) return fmtUsd(0n, frac);
  return b > 0n ? `+${fmtUsd(b, frac)}` : fmtUsd(b, frac);
}

/** Price in 1e6 shown in cents: 505000 -> "50.5¢". */
export function cents(p: Big | null | undefined): string {
  if (p === null || p === undefined) return "n/a";
  return `${fixedToDecimal(big(p), 4, 1)}¢`;
}

/** Price in 1e6 as a dollar price with 4 decimals: 505000 -> "$0.5050". */
export function priceUsd(p: Big | null | undefined): string {
  if (p === null || p === undefined) return "n/a";
  const s = fixedToDecimal(big(p), 6, 4);
  const [w, f = ""] = s.split(".");
  return `$${w}.${f.padEnd(4, "0")}`;
}

/** Leverage in 1e4: 30000 -> "3x", 25000 -> "2.5x". */
export const levX = (v: Big) => `${fixedToDecimal(big(v), 4, 2)}x`;

/** Parts per million as a percent: 500000 -> "50%". */
export const ppmPct = (v: Big, frac = 2) => `${fixedToDecimal(big(v), 4, frac)}%`;

/** Basis points as a percent: 10 -> "0.10%". */
export function bpsPct(v: Big): string {
  const s = fixedToDecimal(big(v), 2, 2);
  const [w, f = ""] = s.split(".");
  return `${w}.${f.padEnd(2, "0")}%`;
}

/** Micro units (6 decimals) as a plain number string: 10000000 -> "10". */
export const units = (v: Big, frac = 2) => fixedToDecimal(big(v), 6, frac);

/** bigint ratio as a JS percent number for bar widths, clamped to [0, 100]. */
export function ratioPct(num: Big, den: Big): number {
  const d = big(den);
  if (d <= 0n) return 0;
  const r = Number((big(num) * 10_000n) / d) / 100;
  return Math.max(0, Math.min(100, r));
}

export const nsToMs = (ns: Big) => Number(big(ns) / 1_000_000n);

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${fmtSeconds(-s)}`;
  if (s < 5) return "just now";
  return `${fmtSeconds(s)} ago`;
}

export function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Duration in nanoseconds as words: 600000000000 -> "10m 0s". */
export const fmtDurationNs = (ns: Big) => fmtSeconds(Math.round(Number(big(ns) / 1_000_000n) / 1000));

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const shortHash = (h: string | null | undefined, n = 8) => (!h ? "n/a" : h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-4)}`);

export const bestBid = (b: OutcomeBook | undefined): bigint => big(b?.bids[0]?.price);
export const bestAsk = (b: OutcomeBook | undefined): bigint => big(b?.asks[0]?.price);

/** Executable mid of one outcome from a signed mark: (best bid + best ask) / 2. */
export function midOf(mark: StoredMark | null | undefined, outcomeId: number): bigint | null {
  const b = mark?.report.outcomes.find((o) => o.outcome_id === outcomeId);
  if (!b || !b.bids.length || !b.asks.length) return null;
  return (bestBid(b) + bestAsk(b)) / 2n;
}

/** Dollar depth on one side of a book: sum(price * size) in micro-USD. */
export function depthUsd(levels: BookLevel[]): bigint {
  return levels.reduce((a, l) => a + (big(l.price) * big(l.size)) / 1_000_000n, 0n);
}

/** Both sides, every outcome. */
export function markDepthUsd(mark: StoredMark | null | undefined): bigint {
  if (!mark) return 0n;
  return mark.report.outcomes.reduce((a, o) => a + depthUsd(o.bids) + depthUsd(o.asks), 0n);
}

/** True when the report came from the simulated venue, so the UI must label it. */
export const isSimulatedSource = (sourceChain: string | null | undefined) => !!sourceChain && sourceChain.startsWith("mock-venue");

export function minBig(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (a < b ? a : b));
}
