/** Deterministic mock hedge executor (spec 11 "hackathon minimum": honest, labeled mock). It plays
 * the role of the Polygon venue executor: takes committed hedge budgets into custody, simulates
 * FOK/FAK fills at the venue ask within signed slippage, posts receipts marked `simulated: true`,
 * finalizes provisional orders and returns unspent custody. It never signs a real venue order. */
import { PRICE_SCALE, nowNs, type HedgeFillReceipt, type Order } from "@basis/sdk";
import type { NodeContext } from "./context.js";
import { log } from "./log.js";
import type { OracleWorker } from "./oracle.js";
import type { Store } from "./store.js";

export interface SimFill {
  fillId: string;
  orderId: string | null;
  marketId: string;
  outcomeId: number;
  units: bigint;
  price: bigint;
  txHash: string;
}

export class MockExecutor {
  /** Fraction (ppm) of each hedge the simulated venue fills; 1_000_000 = full. */
  fillRatioPpm = 1_000_000n;
  /** Executor's own custody ledger (what the venue says we hold). Reconciler compares it. */
  custody = new Map<string, bigint[]>();
  fills: SimFill[] = [];
  private seq = 0;
  constructor(
    readonly ctx: NodeContext,
    readonly oracle: OracleWorker,
    readonly store?: Store,
  ) {
    for (const f of store?.fills() ?? []) {
      const v = this.custody.get(f.market) ?? [];
      while (v.length <= f.outcome) v.push(0n);
      v[f.outcome] += BigInt(f.units);
      this.custody.set(f.market, v);
    }
  }

  private hold(marketId: string, outcome: number, units: bigint, n: number) {
    const v = this.custody.get(marketId) ?? Array(n).fill(0n);
    while (v.length < n) v.push(0n);
    v[outcome] += units;
    this.custody.set(marketId, v);
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
        const mark = await this.oracle.sign(m);
        await this.ctx.keeper.pushMark(mark);
        const ask = BigInt(mark.report.outcomes.find((b) => b.outcome_id === intent.outcome_id)?.asks[0]?.price ?? "0");
        if (ask === 0n || ask >= PRICE_SCALE) return void (await this.ctx.executor.abandonHedge(id, "venue has no ask"));
        const want = BigInt(o.reserved_terms.units);
        const units = (want * this.fillRatioPpm) / 1_000_000n;
        if (units === 0n) return void (await this.ctx.executor.abandonHedge(id, "venue filled nothing (simulated FOK reject)"));
        this.seq++;
        const fill: HedgeFillReceipt = {
          fill_id: `sim-${id}-${this.seq}-${Date.now()}`,
          market_id: intent.market_id,
          outcome_id: intent.outcome_id,
          venue_token_ref: m.descriptor.outcomes[intent.outcome_id].venue_token_ref,
          side_buy: true,
          units: units.toString(),
          price: ask.toString(),
          fee: "0",
          venue_order_id: `sim-order-${id}-${this.seq}`,
          tx_hash: `sim:0x${Buffer.from(`${id}-${this.seq}-${Date.now()}`).toString("hex").slice(0, 40)}`,
          chain: m.descriptor.chain,
          block_number: String(Date.now()),
          order_id: id,
          executed_ns: nowNs().toString(),
          simulated: true,
        };
        await this.ctx.executor.submitHedgeFill(fill);
        this.hold(intent.market_id, intent.outcome_id, units, m.descriptor.outcomes.length);
        this.store?.insertFill({ fill_id: fill.fill_id, order_id: id, market: intent.market_id, outcome: intent.outcome_id, units: units.toString(), price: ask.toString(), tx: fill.tx_hash });
        this.fills.push({ fillId: fill.fill_id, orderId: id, marketId: intent.market_id, outcomeId: intent.outcome_id, units, price: ask, txHash: fill.tx_hash });
        log("info", "executor", "simulated hedge fill", { order: id, units, price: ask });
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

  async tick() {
    const pending = await this.ctx.anon.getPendingOrders();
    for (const o of pending) if (o.mode === "HedgeRequired" && o.state !== "Requested") await this.processOrder(o);
    // Return idle custody cash so it is not stranded off-contract.
    const v = await this.ctx.anon.getVaultSummary();
    const idle = BigInt(v.hedge_custody_cash);
    const stillHedging = pending.some((o) => o.state === "Hedging" || o.state === "HedgedProvisional" || o.state === "RiskReserved");
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

/** Reconciler: compares NEAR-side vault hedge inventory with the executor's custody ledger.
 * POOL_ONLY markets must hold zero; any mismatch freezes opens on that market. */
export class Reconciler {
  lastReport = new Map<string, { ok: boolean; detail: string; at: string }>();
  constructor(
    readonly ctx: NodeContext,
    readonly executor: MockExecutor,
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
