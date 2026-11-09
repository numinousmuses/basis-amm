/** Indexer: tails the contract's onchain audit ring buffer (`get_events`) into SQLite, snapshots
 * vault NAV, and records every signed mark. Feeds the REST/WebSocket read API. */
import type { NodeContext } from "./context.js";
import type { Store } from "./store.js";
import type { OracleWorker } from "./oracle.js";

export class Indexer {
  listeners = new Set<(msg: unknown) => void>();
  private markCursor = 0;
  constructor(
    readonly ctx: NodeContext,
    readonly store: Store,
    readonly oracle: OracleWorker,
  ) {}

  emit(msg: unknown) {
    for (const l of this.listeners) l(msg);
  }

  async tickEvents() {
    let from = this.store.lastSeq() + 1;
    for (let i = 0; i < 10; i++) {
      const batch = await this.ctx.anon.getEvents(from, 100);
      if (!batch.length) break;
      for (const e of batch) {
        this.store.insertEvent(e);
        let data: unknown = e.data;
        try {
          data = JSON.parse(e.data);
        } catch {
          /* keep raw */
        }
        this.emit({ type: "event", seq: e.seq, kind: e.kind, ts_ns: e.ts_ns, data });
      }
      from = Number(batch[batch.length - 1].seq) + 1;
      if (batch.length < 100) break;
    }
  }

  tickMarks() {
    const h = this.oracle.history;
    for (; this.markCursor < h.length; this.markCursor++) {
      const m = h[this.markCursor];
      const s = this.oracle.latest.get(m.marketId);
      const books = s?.report.outcomes ?? [];
      this.store.insertMark({
        market: m.marketId,
        ts_ms: Number(m.ts / 1_000_000n),
        mids: m.mids.map(String),
        bids: books.map((b) => b.bids[0]?.price ?? "0"),
        asks: books.map((b) => b.asks[0]?.price ?? "0"),
        report_id: m.reportId,
        source_chain: s?.report.source_chain ?? "",
      });
      this.emit({ type: "mark", market: m.marketId, ts_ms: Number(m.ts / 1_000_000n), mids: m.mids.map(String) });
    }
    if (this.markCursor > 15_000) {
      this.oracle.history.splice(0, this.markCursor);
      this.markCursor = 0;
    }
  }

  async tickVault() {
    const v = await this.ctx.anon.getVaultSummary();
    const row = {
      ts_ms: Date.now(),
      nav: v.nav,
      share_price: v.share_price,
      free: v.free_liquidity,
      reserve: v.payout_reserve,
      stress: v.stress_loss,
      insurance: v.insurance_balance,
      supply: v.blp_supply,
      open_margin: v.open_margin,
      fees: v.fees_assessed,
    };
    this.store.insertVault(row);
    this.emit({ type: "vault", ...row });
  }
}
