/** Risk keeper: executes committed orders with a mark observed after the commit, runs user
 * triggers, liquidates losing positions, expires stale orders, settles finalized markets and
 * queued withdrawals. Idempotent: every action re-reads contract state and tolerates races. */
import type { Order } from "@basis/sdk";
import type { NodeContext } from "./context.js";
import { log } from "./log.js";
import type { OracleWorker } from "./oracle.js";

export interface KeeperStats {
  executedOpens: number;
  executedCloses: number;
  rejected: number;
  liquidations: number;
  triggers: number;
  settlements: number;
  expired: number;
  errors: number;
}

export class Keeper {
  stats: KeeperStats = { executedOpens: 0, executedCloses: 0, rejected: 0, liquidations: 0, triggers: 0, settlements: 0, expired: 0, errors: 0 };
  private busy = new Set<string>();
  constructor(
    readonly ctx: NodeContext,
    readonly oracle: OracleWorker,
  ) {}

  private async freshMark(marketId: string) {
    const m = await this.ctx.anon.getMarket(marketId);
    if (!m) throw new Error(`unknown market ${marketId}`);
    return this.oracle.sign(m);
  }

  async processOrder(o: Order) {
    const id = o.order_id;
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      if ("Open" in o.kind) {
        const intent = o.kind.Open.intent;
        if (o.state === "Requested") {
          if (nowNs > BigInt(intent.deadline_ns)) {
            await this.ctx.keeper.expireOrder(id);
            this.stats.expired++;
            return;
          }
          const r = await this.ctx.keeper.executeOpen(id, await this.freshMark(intent.market_id));
          const v = String(r.value);
          if (v.startsWith("OPEN:") || v.startsWith("RISK_RESERVED:")) this.stats.executedOpens++;
          else this.stats.rejected++;
          log("info", "keeper", "execute_open", { order: id, result: v, tx: r.hash });
        }
      } else if (o.state === "Requested") {
        const c = o.kind.Close;
        if (nowNs > BigInt(c.deadline_ns)) {
          await this.ctx.keeper.expireOrder(id);
          this.stats.expired++;
          return;
        }
        const pos = await this.ctx.anon.getPosition(c.position_id);
        if (!pos) return;
        const r = await this.ctx.keeper.executeClose(id, await this.freshMark(pos.position.market_id));
        const v = String(r.value);
        if (v.startsWith("CLOSED")) this.stats.executedCloses++;
        else this.stats.rejected++;
        log("info", "keeper", "execute_close", { order: id, result: v, tx: r.hash });
      }
    } catch (e: any) {
      this.stats.errors++;
      log("warn", "keeper", "order failed", { order: id, err: String(e?.message ?? e) });
    } finally {
      this.busy.delete(id);
    }
  }

  async tickOrders() {
    const pending = await this.ctx.anon.getPendingOrders();
    for (const o of pending) if (o.state === "Requested") await this.processOrder(o);
  }

  /** Liquidations and user triggers across all open positions. */
  async tickPositions() {
    const markets = await this.ctx.anon.getMarkets();
    for (const m of markets) {
      if (!["Active", "CloseOnly"].includes(m.state)) continue;
      const open = await this.ctx.anon.getOpenPositions(m.descriptor.market_id);
      if (!open.length) continue;
      const mark = await this.oracle.sign(m);
      const books = mark.report.outcomes;
      for (const pv of open) {
        const p = pv.position;
        if (p.state !== "Open") continue;
        const bid = BigInt(books.find((b) => b.outcome_id === p.outcome_id)?.bids[0]?.price ?? "0");
        try {
          if (pv.liquidatable || bid <= BigInt(pv.liquidation_price)) {
            const r = await this.ctx.keeper.call<string>("liquidate", { position_id: p.position_id, signed: mark }, { allowFailure: true });
            if (String(r.value).startsWith("LIQUIDATED")) {
              this.stats.liquidations++;
              log("info", "keeper", "liquidated", { position: p.position_id, tx: r.hash });
              continue;
            }
          }
          const tp = p.take_profit_price ? bid >= BigInt(p.take_profit_price) : false;
          const sl = p.stop_loss_price ? bid <= BigInt(p.stop_loss_price) : false;
          if (tp || sl) {
            const r = await this.ctx.keeper.executeTrigger(p.position_id, mark);
            this.stats.triggers++;
            log("info", "keeper", "trigger", { position: p.position_id, kind: tp ? "take_profit" : "stop_loss", tx: r.hash });
          }
        } catch (e: any) {
          this.stats.errors++;
          log("warn", "keeper", "position action failed", { position: p.position_id, err: String(e?.message ?? e) });
        }
      }
    }
  }

  async tickSettlement() {
    const markets = await this.ctx.anon.getMarkets();
    for (const m of markets) {
      const id = m.descriptor.market_id;
      if (m.state === "Resolving") {
        const r = await this.ctx.anon.getResolution(id);
        if (r?.status === "Pending" && BigInt(Date.now()) * 1_000_000n > BigInt(r.finalize_after_ns)) {
          try {
            await this.ctx.keeper.finalizeResolution(id);
            log("info", "keeper", "finalized", { market: id });
          } catch (e: any) {
            log("warn", "keeper", "finalize failed", { market: id, err: String(e?.message ?? e) });
          }
        }
      }
      if (m.state === "Settled") {
        const open = await this.ctx.anon.getOpenPositions(id);
        if (open.some((p) => p.position.state === "Open")) {
          const r = await this.ctx.keeper.call<number>("settle_positions", { market_id: id, limit: 25 }, { allowFailure: true });
          this.stats.settlements += Number(r.value ?? 0);
          log("info", "keeper", "settled", { market: id, n: r.value, tx: r.hash });
        }
      }
    }
    const q = await this.ctx.anon.getQueuedWithdrawals();
    if (q.length) await this.ctx.keeper.call("settle_withdrawals", { limit: 20 }, { allowFailure: true });
  }
}
