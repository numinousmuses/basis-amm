/** Hedge executor and reconciler.
 *
 * The executor runs the vault side of every hedged market:
 * - HEDGE_REQUIRED orders: commit the reserved budget, buy the exact outcome shares on the venue
 *   within the user's signed slippage, post the fill receipt, finalize the position;
 * - unwind: when a hedged position closes or is liquidated, sell its shares; inventory left by a
 *   rejected order (orphan) is sold the same way;
 * - redeem: after the market settles, redeem remaining shares at the resolved payout and return
 *   custody cash to the vault.
 * The venue is chosen per market: `MockHedgeVenue` for mock-venue fixtures, and for live
 * Polymarket markets either paper (live book, no order) or live (real Polygon orders). */
import { nowNs, type HedgeFillReceipt, type Market, type Order } from "@basis/sdk";
import type { NodeContext } from "./context.js";
import { log } from "./log.js";
import type { OracleWorker } from "./oracle.js";
import type { Store } from "./store.js";
import { liveRefs } from "./polymarket/refs.js";
import { walk, type HedgeVenue, type VenueFill } from "./polymarket/venues.js";

/** Fills at the oracle's latest mock-venue book (sandbox fixture markets). */
export class MockHedgeVenue implements HedgeVenue {
  readonly name = "mock-venue";
  readonly simulated = true;
  fillRatioPpm = 1_000_000n;
  private seq = 0;
  constructor(readonly oracle: OracleWorker) {}
  private book(m: Market, outcome: number) {
    const s = this.oracle.latest.get(m.descriptor.market_id);
    return s?.report.outcomes.find((b) => b.outcome_id === outcome);
  }
  private mk(units: bigint, price: bigint, side: string): VenueFill {
    this.seq++;
    const notional = (units * price) / 1_000_000n;
    return {
      units,
      notional,
      avgPrice: price,
      fee: 0n,
      txHash: `sim:0x${Buffer.from(`${side}-${this.seq}-${Date.now()}`).toString("hex").slice(0, 40)}`,
      orderId: `sim-order-${this.seq}`,
      block: BigInt(Date.now()),
      simulated: true,
    };
  }
  async buy(m: Market, outcome: number, units: bigint, maxPrice: bigint) {
    const ask = BigInt(this.book(m, outcome)?.asks[0]?.price ?? "0");
    if (ask === 0n || ask > maxPrice) return null;
    const u = (units * this.fillRatioPpm) / 1_000_000n;
    return u === 0n ? null : this.mk(u, ask, "buy");
  }
  async sell(m: Market, outcome: number, units: bigint, minPrice: bigint) {
    const b = this.book(m, outcome);
    if (!b) return null;
    const w = walk(b.bids, units, minPrice, "sell");
    return w.filled === 0n ? null : { ...this.mk(w.filled, w.avgPrice, "sell"), notional: w.notional };
  }
  async redeem(_m: Market, _o: number, units: bigint, payoutPpm: bigint) {
    return { txHash: `sim:redeem-${Date.now()}`, proceeds: (units * payoutPpm) / 1_000_000n };
  }
}

export interface SimFill {
  fillId: string;
  orderId: string | null;
  marketId: string;
  outcomeId: number;
  units: bigint;
  price: bigint;
  txHash: string;
  side: "buy" | "sell" | "redeem";
  simulated: boolean;
}

export class HedgeExecutor {
  /** Venue-side holdings per market and outcome (what the venue says we hold). */
  custody = new Map<string, bigint[]>();
  fills: SimFill[] = [];
  private attempts = new Map<string, number>();
  readonly mockVenue: MockHedgeVenue;
  constructor(
    readonly ctx: NodeContext,
    readonly oracle: OracleWorker,
    readonly store?: Store,
    readonly polymarketVenue?: HedgeVenue,
  ) {
    this.mockVenue = new MockHedgeVenue(oracle);
    for (const f of store?.fills() ?? []) this.hold(f.market, f.outcome, (f.side === "buy" ? 1n : -1n) * BigInt(f.units), f.outcome + 1);
  }

  /** Back-compat knob used by tests: fraction of each mock hedge the venue fills. */
  get fillRatioPpm() {
    return this.mockVenue.fillRatioPpm;
  }
  set fillRatioPpm(v: bigint) {
    this.mockVenue.fillRatioPpm = v;
  }

  venueFor(m: Market): HedgeVenue {
    if (liveRefs(m)) {
      if (!this.polymarketVenue) throw new Error(`${m.descriptor.market_id}: live Polymarket market but no Polymarket venue configured`);
      return this.polymarketVenue;
    }
    return this.mockVenue;
  }

  private hold(marketId: string, outcome: number, delta: bigint, n: number) {
    const v = this.custody.get(marketId) ?? [];
    while (v.length < n) v.push(0n);
    v[outcome] += delta;
    this.custody.set(marketId, v);
  }

  private receipt(m: Market, outcome: number, fill: VenueFill, buy: boolean, orderId: string | null, venue: HedgeVenue): HedgeFillReceipt {
    return {
      fill_id: `${venue.name}:${fill.orderId}:${buy ? "b" : "s"}`,
      market_id: m.descriptor.market_id,
      outcome_id: outcome,
      venue_token_ref: m.descriptor.outcomes[outcome].venue_token_ref,
      side_buy: buy,
      units: fill.units.toString(),
      price: fill.avgPrice.toString(),
      fee: fill.fee.toString(),
      venue_order_id: fill.orderId,
      tx_hash: fill.txHash,
      chain: m.descriptor.chain,
      block_number: fill.block.toString(),
      order_id: orderId,
      executed_ns: nowNs().toString(),
      simulated: fill.simulated,
    };
  }

  private record(m: Market, outcome: number, fill: VenueFill, side: "buy" | "sell", orderId: string | null, fillId: string) {
    const n = m.descriptor.outcomes.length;
    this.hold(m.descriptor.market_id, outcome, side === "buy" ? fill.units : -fill.units, n);
    this.store?.insertFill({ fill_id: fillId, order_id: orderId, market: m.descriptor.market_id, outcome, units: fill.units.toString(), price: fill.avgPrice.toString(), tx: fill.txHash, side, simulated: fill.simulated });
    this.fills.push({ fillId, orderId, marketId: m.descriptor.market_id, outcomeId: outcome, units: fill.units, price: fill.avgPrice, txHash: fill.txHash, side, simulated: fill.simulated });
  }

  async processOrder(o: Order) {
    if (!("Open" in o.kind) || o.mode !== "HedgeRequired") return;
    const intent = o.kind.Open.intent;
    const id = o.order_id;
    try {
      if (o.state === "RiskReserved") {
        await this.ctx.executor.commitHedge(id);
        log("info", "executor", "hedge committed", { order: id, budget: o.reserved_hedge_budget });
        return;
      }
      if (o.state === "Hedging" && o.reserved_terms) {
        const m = await this.ctx.anon.getMarket(intent.market_id);
        if (!m) return;
        const policy = await this.ctx.anon.getPolicy(m.policy_hash);
        const mark = await this.oracle.sign(m);
        await this.ctx.keeper.pushMark(mark);
        const ask = BigInt(mark.report.outcomes.find((b) => b.outcome_id === intent.outcome_id)?.asks[0]?.price ?? "0");
        const slip = BigInt(Math.min(policy?.max_hedge_slippage_bps ?? 0, intent.max_hedge_slippage_bps));
        const byIntent = (BigInt(intent.max_entry_price) * (10_000n + slip)) / 10_000n;
        const byBook = (ask * (10_000n + slip)) / 10_000n;
        const bound = byIntent < byBook ? byIntent : byBook;
        const want = BigInt(o.reserved_terms.units) - BigInt(o.hedge_units);
        const venue = this.venueFor(m);
        const fill = ask > 0n ? await venue.buy(m, intent.outcome_id, want, bound) : null;
        if (!fill) {
          const n = (this.attempts.get(id) ?? 0) + 1;
          this.attempts.set(id, n);
          if (n >= 3 || nowNs() > BigInt(intent.deadline_ns)) await this.ctx.executor.abandonHedge(id, `${venue.name}: no executable liquidity within the signed bound`);
          return;
        }
        const r = this.receipt(m, intent.outcome_id, fill, true, id, venue);
        this.record(m, intent.outcome_id, fill, "buy", id, r.fill_id);
        try {
          await this.ctx.executor.submitHedgeFill(r);
        } catch (e) {
          this.hold(m.descriptor.market_id, intent.outcome_id, -fill.units, m.descriptor.outcomes.length);
          throw e;
        }
        log("info", "executor", "hedge fill", { order: id, venue: venue.name, units: fill.units, price: fill.avgPrice, tx: fill.txHash, simulated: fill.simulated });
        return;
      }
      if (o.state === "HedgedProvisional") {
        const r = await this.ctx.executor.finalizeOpenHedged(id);
        log("info", "executor", "finalized", { order: id, result: r.value, tx: r.hash });
      }
    } catch (e: any) {
      log("warn", "executor", "hedge step failed", { order: id, err: String(e?.message ?? e) });
    }
  }

  /** Sell inventory that no longer backs an open position: closed or liquidated hedged positions,
   *  and orphan fills from rejected all-or-none orders. */
  async unwind() {
    if (!this.store) return;
    const byOrder = new Map<string, { market: string; outcome: number; units: bigint }>();
    for (const f of this.store.fills()) {
      if (!f.order_id) continue;
      const k = String(f.order_id);
      const cur = byOrder.get(k) ?? { market: f.market, outcome: f.outcome, units: 0n };
      cur.units += (f.side === "sell" ? -1n : 1n) * BigInt(f.units);
      byOrder.set(k, cur);
    }
    for (const [orderId, g] of byOrder) {
      if (g.units <= 0n) continue;
      const o = await this.ctx.anon.getOrder(orderId);
      if (!o) continue;
      let release = false;
      if (o.state === "Rejected" || o.state === "Expired" || o.state === "Cancelled") release = true;
      if (o.position_id) {
        const p = await this.ctx.anon.getPosition(o.position_id);
        if (p && (p.position.state === "Closed" || p.position.state === "Liquidated")) release = true;
      }
      if (!release) continue;
      const m = await this.ctx.anon.getMarket(g.market);
      if (!m || !["Active", "CloseOnly"].includes(m.state)) continue;
      const policy = await this.ctx.anon.getPolicy(m.policy_hash);
      const mark = await this.oracle.sign(m);
      await this.ctx.keeper.pushMark(mark);
      const bid = BigInt(mark.report.outcomes.find((b) => b.outcome_id === g.outcome)?.bids[0]?.price ?? "0");
      const slip = BigInt(policy?.max_hedge_slippage_bps ?? 200);
      const minPrice = (bid * (10_000n - slip)) / 10_000n;
      const venue = this.venueFor(m);
      try {
        const fill = await venue.sell(m, g.outcome, g.units, minPrice);
        if (!fill) continue;
        const r = this.receipt(m, g.outcome, fill, false, null, venue);
        this.record(m, g.outcome, fill, "sell", orderId, r.fill_id);
        await this.ctx.executor.submitHedgeFill(r);
        log("info", "executor", "hedge unwound", { order: orderId, venue: venue.name, units: fill.units, price: fill.avgPrice, tx: fill.txHash });
      } catch (e: any) {
        log("warn", "executor", "unwind failed", { order: orderId, err: String(e?.message ?? e) });
      }
    }
  }

  /** Redeem inventory in settled markets at the resolved payout. */
  async redeem() {
    for (const [marketId, units] of this.custody) {
      if (!units.some((u) => u > 0n)) continue;
      const m = await this.ctx.anon.getMarket(marketId);
      if (!m || m.state !== "Settled" || m.resolved_scenario === null) continue;
      const risk = await this.ctx.anon.getRiskSummary(marketId);
      const venue = this.venueFor(m);
      for (let i = 0; i < units.length; i++) {
        const onchain = BigInt(risk.hedge_units[i] ?? "0");
        const u = units[i] < onchain ? units[i] : onchain;
        if (u <= 0n) continue;
        const payout = BigInt(m.descriptor.scenarios[m.resolved_scenario].payouts[i]);
        try {
          const r = await venue.redeem(m, i, u, payout);
          await this.ctx.executor.recordHedgeRedemption(marketId, i, u, r.proceeds, r.txHash);
          this.hold(marketId, i, -u, units.length);
          this.store?.insertFill({ fill_id: `redeem:${marketId}:${i}:${Date.now()}`, order_id: null, market: marketId, outcome: i, units: u.toString(), price: payout.toString(), tx: r.txHash, side: "sell", simulated: venue.simulated });
          log("info", "executor", "redeemed", { market: marketId, outcome: i, units: u, proceeds: r.proceeds, tx: r.txHash });
        } catch (e: any) {
          log("warn", "executor", "redeem failed", { market: marketId, err: String(e?.message ?? e) });
        }
      }
    }
  }

  async tick() {
    const pending = await this.ctx.anon.getPendingOrders();
    for (const o of pending) if (o.mode === "HedgeRequired" && o.state !== "Requested") await this.processOrder(o);
    await this.unwind();
    await this.redeem();
    // Return idle custody cash so it is not stranded off-contract.
    const v = await this.ctx.anon.getVaultSummary();
    const idle = BigInt(v.hedge_custody_cash);
    const stillHedging = (await this.ctx.anon.getPendingOrders()).some((o) => ["Hedging", "HedgedProvisional", "RiskReserved"].includes(o.state));
    if (idle > 0n && !stillHedging) {
      const bal = BigInt(await this.ctx.anon.balanceOf(this.ctx.stack.accounts.executor.accountId));
      const amt = idle < bal ? idle : bal;
      if (amt > 0n) {
        await this.ctx.executor.hedgeReturn(amt, "*", "idle custody return");
        log("info", "executor", "custody returned", { amount: amt });
      }
    }
  }
}

/** Back-compat name: the executor with only the mock venue configured. */
export const MockExecutor = HedgeExecutor;
export type MockExecutor = HedgeExecutor;

/** Reconciler: compares NEAR-side vault hedge inventory with the executor's venue ledger.
 * POOL_ONLY markets must hold zero; any mismatch freezes opens on that market. */
export class Reconciler {
  lastReport = new Map<string, { ok: boolean; detail: string; at: string }>();
  constructor(
    readonly ctx: NodeContext,
    readonly executor: HedgeExecutor,
  ) {}

  async tick() {
    const markets = await this.ctx.anon.getMarkets();
    for (const m of markets) {
      const id = m.descriptor.market_id;
      const risk = await this.ctx.anon.getRiskSummary(id);
      const onchain = risk.hedge_units.map(BigInt);
      const custody = this.executor.custody.get(id) ?? onchain.map(() => 0n);
      const policy = await this.ctx.anon.getPolicy(m.policy_hash);
      let ok = onchain.every((u, i) => u === (custody[i] ?? 0n));
      let detail = ok ? "inventory matches custody" : `onchain ${onchain.join("/")} vs custody ${custody.join("/")}`;
      if (policy?.strategy === "PoolOnly" && onchain.some((u) => u > 0n)) {
        ok = false;
        detail = "POOL_ONLY market holds hedge inventory";
      }
      const prev = this.lastReport.get(id);
      if (!ok && (!prev || prev.ok)) {
        await this.ctx.keeper.reportReconciliation(id, false, detail);
        log("warn", "reconciler", "mismatch: opens frozen", { market: id, detail });
      }
      this.lastReport.set(id, { ok, detail, at: new Date().toISOString() });
    }
  }
}
