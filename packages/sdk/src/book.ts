/** Order-book snapshots and MARK report construction for venue adapters and the mock venue. */
import type { BookLevel, OracleReport, OutcomeBook, VenueStatus } from "./types.js";
import { PRICE_SCALE, UNIT } from "./units.js";
import { sourceHash } from "./report.js";

export interface LadderSpec {
  /** best bid / best ask in price scale */
  bid: bigint;
  ask: bigint;
  /** units (micro) per level */
  size: bigint;
  levels?: number;
  tick?: bigint;
}

/** Symmetric ladder: `levels` levels each side stepping one tick away from the touch. */
export function ladder(spec: LadderSpec): Pick<OutcomeBook, "bids" | "asks"> {
  const n = spec.levels ?? 5;
  const tick = spec.tick ?? 10_000n;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < n; i++) {
    const b = spec.bid - tick * BigInt(i);
    const a = spec.ask + tick * BigInt(i);
    if (b > 0n) bids.push({ price: b.toString(), size: spec.size.toString() });
    if (a < PRICE_SCALE) asks.push({ price: a.toString(), size: spec.size.toString() });
  }
  return { bids, asks };
}

/** Binary book around a YES mid: NO is the complement. */
export function binaryBooks(yesMid: bigint, halfSpread = 5_000n, size = 100_000n * UNIT, levels = 5): OutcomeBook[] {
  const yes = ladder({ bid: yesMid - halfSpread, ask: yesMid + halfSpread, size, levels });
  const noMid = PRICE_SCALE - yesMid;
  const no = ladder({ bid: noMid - halfSpread, ask: noMid + halfSpread, size, levels });
  return [
    { outcome_id: 0, ...yes },
    { outcome_id: 1, ...no },
  ];
}

/** Multi-outcome books from mids that should sum to ~1. */
export function multiBooks(mids: bigint[], halfSpread = 5_000n, size = 100_000n * UNIT, levels = 5): OutcomeBook[] {
  return mids.map((m, i) => ({ outcome_id: i, ...ladder({ bid: m - halfSpread, ask: m + halfSpread, size, levels }) }));
}

export interface MarkOpts {
  marketId: string;
  books: OutcomeBook[];
  sourceChain?: string;
  observedBlock?: bigint;
  sourceTsNs: bigint;
  validForNs?: bigint;
  status?: VenueStatus;
  tick?: bigint;
  attestationRef?: string;
  reportId?: string;
  provenance?: unknown;
}

export function markReport(o: MarkOpts): OracleReport {
  const provenance = o.provenance ?? { books: o.books, ts: o.sourceTsNs.toString() };
  return {
    kind: "Mark",
    report_id: o.reportId ?? `mark-${o.marketId}-${o.sourceTsNs}`,
    market_id: o.marketId,
    source_chain: o.sourceChain ?? "mock-venue:sandbox",
    observed_block: (o.observedBlock ?? 0n).toString(),
    source_timestamp_ns: o.sourceTsNs.toString(),
    fetch_timestamp_ns: o.sourceTsNs.toString(),
    valid_until_ns: (o.sourceTsNs + (o.validForNs ?? 60_000_000_000n)).toString(),
    outcomes: o.books,
    fee_schedule_version: 1,
    tick_size: (o.tick ?? 10_000n).toString(),
    market_status: o.status ?? "Open",
    final_scenario: null,
    source_hash: sourceHash(provenance),
    attestation_ref: o.attestationRef ?? "none:dev-reporter",
  };
}

export function resolutionReport(o: { marketId: string; scenario: number; sourceTsNs: bigint; status?: VenueStatus; sourceChain?: string; provenance?: unknown; attestationRef?: string }): OracleReport {
  return {
    kind: "FinalResolution",
    report_id: `final-${o.marketId}-${o.sourceTsNs}`,
    market_id: o.marketId,
    source_chain: o.sourceChain ?? "mock-venue:sandbox",
    observed_block: "0",
    source_timestamp_ns: o.sourceTsNs.toString(),
    fetch_timestamp_ns: o.sourceTsNs.toString(),
    valid_until_ns: (o.sourceTsNs + 3_600_000_000_000n).toString(),
    outcomes: [],
    fee_schedule_version: 1,
    tick_size: "10000",
    market_status: o.status ?? "Resolved",
    final_scenario: o.scenario,
    source_hash: sourceHash(o.provenance ?? { scenario: o.scenario }),
    attestation_ref: o.attestationRef ?? "none:dev-reporter",
  };
}
