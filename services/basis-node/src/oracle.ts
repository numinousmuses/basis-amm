/** Oracle worker: fetches books from the market's feed, signs typed MARK reports with the
 * registered reporter key and relays them. A TEE/OutLayer deployment would run this same code
 * inside an attested enclave; attestation proves the code, not the truth of the source. */
import { markReport, nowNs, type Market, type SignedReport } from "@basis/sdk";
import type { NodeContext } from "./context.js";
import { log } from "./log.js";

export class OracleWorker {
  latest = new Map<string, SignedReport>();
  history: Array<{ marketId: string; ts: bigint; mids: bigint[]; reportId: string }> = [];
  constructor(readonly ctx: NodeContext) {}

  feedFor(id: string) {
    return this.ctx.feeds.get(id) ?? this.ctx.feed;
  }

  /** Build and sign a fresh MARK for `market` observed now. */
  async sign(m: Market): Promise<SignedReport> {
    const snap = await this.feedFor(m.descriptor.market_id).snapshot(m);
    const ts = nowNs();
    const r = markReport({
      marketId: m.descriptor.market_id,
      books: snap.books,
      sourceChain: snap.sourceChain,
      observedBlock: snap.observedBlock,
      sourceTsNs: ts,
      validForNs: 60_000_000_000n,
      status: snap.status,
      attestationRef: "basis-node@0.1:unattested-dev",
      provenance: snap.provenance,
      reportId: `mark-${m.descriptor.market_id}-${ts}`,
    });
    const s = this.ctx.markReporter.sign(this.ctx.stack.contractId, r);
    this.latest.set(m.descriptor.market_id, s);
    const mids = snap.books.map((b) => (BigInt(b.bids[0]?.price ?? 0) + BigInt(b.asks[0]?.price ?? 0)) / 2n);
    this.history.push({ marketId: m.descriptor.market_id, ts, mids, reportId: r.report_id });
    if (this.history.length > 20_000) this.history.splice(0, 5_000);
    return s;
  }

  /** Push fresh marks for every tradable market so NAV stays fresh. */
  async tick() {
    const markets = await this.ctx.anon.getMarkets();
    for (const m of markets) {
      if (!["Active", "CloseOnly", "Suspended"].includes(m.state)) continue;
      try {
        const s = await this.sign(m);
        await this.ctx.keeper.pushMark(s);
      } catch (e: any) {
        log("warn", "oracle", "mark push failed", { market: m.descriptor.market_id, err: String(e?.message ?? e) });
      }
    }
  }
}
