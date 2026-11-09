/** Hedge venues the executor can trade on.
 *
 * - `MockHedgeVenue`: fills at the oracle's mock-venue ask. Sandbox fixtures only.
 * - `PaperPolymarketVenue`: walks the LIVE Polymarket order book for the exact size with the
 *   same FAK semantics, minimum order size and price bounds as a real order, but places nothing.
 *   Receipts carry `simulated: true` and `paper:` hashes.
 * - `LivePolymarketVenue`: real FAK market orders through `@polymarket/client`, settled on
 *   Polygon; receipts carry the real settlement transaction hash and block. Requires explicit
 *   opt-in (`BASIS_POLYMARKET_LIVE=1`), a funded deposit wallet, and enforces per-order and daily
 *   caps on top of the TEE signer's own limits. */
import { createHash } from "node:crypto";
import { createPublicClient as viemPublic, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { createSecureClient, forkEnvironmentConfig, OrderSide, OrderType, production } from "@polymarket/client";
import type { Market } from "@basis/sdk";
import { liveBooks, pmPublic } from "./books.js";
import { liveRefs, toMicro, fromMicro } from "./refs.js";
import { log } from "../log.js";

export const SHARE = 1_000_000n; // 1 share in micro-units
export const MIN_ORDER_SHARES = 5n * SHARE; // Polymarket minimum order size

export interface VenueFill {
  units: bigint; // micro-shares actually filled
  notional: bigint; // pUSD micro-units paid (buy) or received (sell)
  avgPrice: bigint; // 1e6
  fee: bigint;
  txHash: string;
  orderId: string;
  block: bigint;
  simulated: boolean;
}

export interface HedgeVenue {
  readonly name: string;
  readonly simulated: boolean;
  buy(m: Market, outcome: number, units: bigint, maxPrice: bigint): Promise<VenueFill | null>;
  sell(m: Market, outcome: number, units: bigint, minPrice: bigint): Promise<VenueFill | null>;
  redeem(m: Market, outcome: number, units: bigint, payoutPpm: bigint): Promise<{ txHash: string; proceeds: bigint }>;
}

/** Walk levels (best first) for `units` within a price bound. */
export function walk(levels: Array<{ price: string; size: string }>, units: bigint, bound: bigint, side: "buy" | "sell") {
  let left = units;
  let notional = 0n;
  for (const l of levels) {
    const p = BigInt(l.price);
    if (side === "buy" ? p > bound : p < bound) break;
    const take = BigInt(l.size) < left ? BigInt(l.size) : left;
    notional += side === "buy" ? (take * p + SHARE - 1n) / SHARE : (take * p) / SHARE;
    left -= take;
    if (left === 0n) break;
  }
  const filled = units - left;
  return { filled, notional, avgPrice: filled > 0n ? (notional * SHARE) / filled : 0n };
}

export class PaperPolymarketVenue implements HedgeVenue {
  readonly name = "polymarket-paper";
  readonly simulated = true;
  private seq = 0;
  constructor(readonly feeBps = 0n) {}

  private async fill(m: Market, outcome: number, units: bigint, bound: bigint, side: "buy" | "sell"): Promise<VenueFill | null> {
    if (units < MIN_ORDER_SHARES) return null;
    const { books, raw } = await liveBooks(m);
    const b = books[outcome];
    const w = walk(side === "buy" ? b.asks : b.bids, units, bound, side);
    if (w.filled < MIN_ORDER_SHARES) return null; // FAK: nothing executable within bounds
    const fee = (w.notional * this.feeBps) / 10_000n;
    this.seq++;
    const h = createHash("sha256").update(JSON.stringify(raw)).update(String(this.seq)).digest("hex").slice(0, 40);
    return { units: w.filled, notional: w.notional, avgPrice: w.avgPrice, fee, txHash: `paper:0x${h}`, orderId: `paper-${Date.now()}-${this.seq}`, block: 0n, simulated: true };
  }
  buy(m: Market, outcome: number, units: bigint, maxPrice: bigint) {
    return this.fill(m, outcome, units, maxPrice, "buy");
  }
  sell(m: Market, outcome: number, units: bigint, minPrice: bigint) {
    return this.fill(m, outcome, units, minPrice, "sell");
  }
  async redeem(_m: Market, _o: number, units: bigint, payoutPpm: bigint) {
    return { txHash: `paper:redeem-${Date.now()}`, proceeds: (units * payoutPpm) / 1_000_000n };
  }
}

export interface LiveVenueOptions {
  signer: any; // @polymarket/client Signer (env key or TeeExecutorSigner)
  depositWallet?: string;
  apiKey?: any; // builder/relayer key for deposit wallet operations
  clobUrl?: string; // optional CLOB REST override (geoblock-compliant egress)
  polygonRpc?: string;
  maxOrderUsd: number;
  maxDailyUsd: number;
  spentToday?: () => number;
  recordSpend?: (usd: number) => void;
}

export class LivePolymarketVenue implements HedgeVenue {
  readonly name = "polymarket-live";
  readonly simulated = false;
  private clientP?: Promise<any>;
  private rpc;
  constructor(readonly o: LiveVenueOptions) {
    if (process.env.BASIS_POLYMARKET_LIVE !== "1") throw new Error("LivePolymarketVenue requires BASIS_POLYMARKET_LIVE=1 (real funds)");
    this.rpc = viemPublic({ chain: polygon, transport: http(o.polygonRpc ?? "https://polygon-bor-rpc.publicnode.com") });
  }

  client() {
    const env = this.o.clobUrl ? forkEnvironmentConfig({ name: "basis-clob-egress", clob: { rest: this.o.clobUrl } } as any, production) : undefined;
    return (this.clientP ??= createSecureClient({ signer: this.o.signer, wallet: this.o.depositWallet, apiKey: this.o.apiKey, environment: env } as any));
  }

  private capCheck(usd: number) {
    if (usd > this.o.maxOrderUsd) throw new Error(`order $${usd.toFixed(2)} above per-order cap $${this.o.maxOrderUsd}`);
    const spent = this.o.spentToday?.() ?? 0;
    if (spent + usd > this.o.maxDailyUsd) throw new Error(`daily cap $${this.o.maxDailyUsd} reached ($${spent.toFixed(2)} spent)`);
  }

  private async settle(c: any, r: any, m: Market): Promise<{ txHash: string; block: bigint }> {
    const hashes: string[] = await c.waitForOrderFillSettlement(r).catch(() => r.transactionsHashes ?? []);
    const txHash = hashes[0] ?? "";
    let block = 0n;
    if (txHash) {
      const rc = await this.rpc.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
      block = rc?.blockNumber ?? 0n;
    }
    log("info", "polymarket", "settled", { market: m.descriptor.market_id, txHash, block });
    return { txHash, block };
  }

  async buy(m: Market, outcome: number, units: bigint, maxPrice: bigint): Promise<VenueFill | null> {
    const refs = liveRefs(m)!;
    if (units < MIN_ORDER_SHARES) return null;
    const c = await this.client();
    // Spend for `units` at the estimated average price (never above maxPrice) so the filled share
    // count lands at or just under the reserved size.
    const usdAtMax = Number(fromMicro((units * maxPrice) / SHARE));
    const est = await c.estimateMarketPrice({ assetId: refs.assetIds[outcome], side: OrderSide.BUY, amount: usdAtMax.toFixed(2), orderType: OrderType.FAK });
    const px = Math.min(Number(fromMicro(maxPrice)), est);
    const amount = Math.floor(Number(fromMicro(units)) * px * 100) / 100;
    this.capCheck(amount);
    const r = await c.placeMarketOrder({ assetId: refs.assetIds[outcome], side: OrderSide.BUY, amount: amount.toFixed(2), maxSpend: amount.toFixed(2), maxPrice: Number(fromMicro(maxPrice)), orderType: OrderType.FAK });
    if (!r.ok) {
      log("warn", "polymarket", "buy rejected", { code: r.code, message: r.message });
      return null;
    }
    const paid = toMicro(r.makingAmount);
    const got = toMicro(r.takingAmount);
    if (got === 0n) return null;
    this.o.recordSpend?.(Number(fromMicro(paid)));
    const { txHash, block } = await this.settle(c, r, m);
    return { units: got, notional: paid, avgPrice: (paid * SHARE) / got, fee: 0n, txHash, orderId: r.orderId, block, simulated: false };
  }

  async sell(m: Market, outcome: number, units: bigint, minPrice: bigint): Promise<VenueFill | null> {
    const refs = liveRefs(m)!;
    if (units < MIN_ORDER_SHARES) return null;
    const c = await this.client();
    const r = await c.placeMarketOrder({ assetId: refs.assetIds[outcome], side: OrderSide.SELL, shares: fromMicro(units), minPrice: Math.max(0.01, Number(fromMicro(minPrice))), orderType: OrderType.FAK });
    if (!r.ok) {
      log("warn", "polymarket", "sell rejected", { code: r.code, message: r.message });
      return null;
    }
    const sold = toMicro(r.makingAmount);
    const got = toMicro(r.takingAmount);
    if (sold === 0n) return null;
    const { txHash, block } = await this.settle(c, r, m);
    return { units: sold, notional: got, avgPrice: (got * SHARE) / sold, fee: 0n, txHash, orderId: r.orderId, block, simulated: false };
  }

  async redeem(m: Market, _outcome: number, units: bigint, payoutPpm: bigint) {
    const refs = liveRefs(m)!;
    const c = await this.client();
    const handle = await c.redeemPositions({ conditionId: refs.conditionId });
    const outcome = await handle.wait();
    return { txHash: outcome.transactionHash as string, proceeds: (units * payoutPpm) / 1_000_000n };
  }
}

/** Snapshot of live mid prices for display and reconciliation. */
export async function liveMid(m: Market, outcome: number): Promise<bigint> {
  const refs = liveRefs(m)!;
  const mid: any = await pmPublic().fetchMidpoint({ assetId: refs.assetIds[outcome] } as any);
  return toMicro(String(mid?.mid ?? mid));
}
