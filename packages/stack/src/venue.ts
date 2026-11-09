/** Deterministic mock venue: per-market order books the dev oracle worker signs into MARK
 * reports. Clearly labeled `mock-venue:*` in every report's `source_chain`. */
import { binaryBooks, markReport, multiBooks, nowNs, ReporterKey, type OutcomeBook, type SignedReport, type VenueStatus } from "@basis/sdk";

export interface MockMarketState {
  mids: bigint[];
  halfSpread: bigint;
  size: bigint;
  levels: number;
  status: VenueStatus;
  /** Optional override books (thin/manipulated books for adversarial tests). */
  books?: OutcomeBook[];
}

export class MockVenue {
  markets = new Map<string, MockMarketState>();
  block = 1_000_000n;
  constructor(
    readonly contractId: string,
    readonly reporter: ReporterKey,
  ) {}

  set(marketId: string, s: Partial<MockMarketState> & { mids: bigint[] }) {
    const prev = this.markets.get(marketId);
    this.markets.set(marketId, {
      halfSpread: 5_000n,
      size: 100_000_000_000n,
      levels: 5,
      status: "Open",
      ...prev,
      books: undefined,
      ...s,
    });
  }

  books(marketId: string): OutcomeBook[] {
    const s = this.markets.get(marketId);
    if (!s) throw new Error(`mock venue: unknown market ${marketId}`);
    if (s.books) return s.books;
    if (s.mids.length === 2) return binaryBooks(s.mids[0], s.halfSpread, s.size, s.levels);
    return multiBooks(s.mids, s.halfSpread, s.size, s.levels);
  }

  /** Signed MARK report observed now (or at `tsNs`). */
  mark(marketId: string, tsNs: bigint = nowNs(), validForNs = 60_000_000_000n): SignedReport {
    const s = this.markets.get(marketId)!;
    this.block += 1n;
    const r = markReport({
      marketId,
      books: this.books(marketId),
      sourceChain: "mock-venue:polygon-sim",
      observedBlock: this.block,
      sourceTsNs: tsNs,
      validForNs,
      status: s.status,
      attestationRef: "mock-venue@1:deterministic",
    });
    return this.reporter.sign(this.contractId, r);
  }
}
