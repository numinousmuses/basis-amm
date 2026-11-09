/** Price sources for the oracle worker. Each produces outcome books for one market.
 * - `MockFeed`: deterministic seeded random walk, labeled `mock-venue:*` (sandbox, testnet demo).
 * - `PolymarketFeed`: read-only live CLOB books from clob.polymarket.com for real token ids
 *   (`polygon:ctf:<decimal token id>`). Used for discovery/shadow marks; never places orders. */
import { PRICE_SCALE, UNIT, type BookLevel, type Market, type OutcomeBook, type VenueStatus } from "@basis/sdk";

export interface FeedSnapshot {
  books: OutcomeBook[];
  status: VenueStatus;
  sourceChain: string;
  observedBlock: bigint;
  provenance: unknown;
}

export interface Feed {
  snapshot(m: Market): Promise<FeedSnapshot>;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const TICK = 10_000n;
const roundTick = (p: bigint) => (p / TICK) * TICK;

/** Mock venue with a bounded random walk per market and manual overrides for demos. */
export class MockFeed implements Feed {
  private mids = new Map<string, bigint[]>();
  private overrides = new Map<string, { mids?: bigint[]; status?: VenueStatus; books?: OutcomeBook[] }>();
  private rand: () => number;
  block = 50_000_000n;
  constructor(
    seed = 42,
    readonly volatility = 0.004,
    readonly halfSpread = 5_000n,
    readonly depthUnits = 50_000n,
  ) {
    this.rand = rng(seed);
  }

  set(marketId: string, o: { mids?: bigint[]; status?: VenueStatus; books?: OutcomeBook[] }) {
    this.overrides.set(marketId, { ...this.overrides.get(marketId), ...o });
    if (o.mids) this.mids.set(marketId, o.mids);
  }
  clear(marketId: string) {
    this.overrides.delete(marketId);
  }

  private initial(m: Market): bigint[] {
    const n = m.descriptor.outcomes.length;
    if (n === 2) return [500_000n, 500_000n];
    const each = PRICE_SCALE / BigInt(n);
    return Array.from({ length: n }, () => each);
  }

  private step(m: Market): bigint[] {
    const id = m.descriptor.market_id;
    const cur = this.mids.get(id) ?? this.initial(m);
    const ov = this.overrides.get(id);
    if (ov?.mids) return ov.mids;
    if (cur.length === 2) {
      const d = BigInt(Math.round((this.rand() - 0.5) * 2 * this.volatility * 1_000_000));
      let y = cur[0] + d;
      if (y < 30_000n) y = 30_000n;
      if (y > 970_000n) y = 970_000n;
      const next = [roundTick(y) + this.halfSpread, PRICE_SCALE - roundTick(y) - this.halfSpread];
      this.mids.set(id, next);
      return next;
    }
    const w = cur.map((c) => Number(c) * (1 + (this.rand() - 0.5) * 2 * this.volatility * 5));
    const sum = w.reduce((a, b) => a + b, 0);
    const next = w.map((x) => {
      let v = BigInt(Math.round((x / sum) * 1_000_000));
      if (v < 30_000n) v = 30_000n;
      return roundTick(v) + this.halfSpread;
    });
    this.mids.set(id, next);
    return next;
  }

  mid(marketId: string): bigint[] | undefined {
    return this.overrides.get(marketId)?.mids ?? this.mids.get(marketId);
  }

  async snapshot(m: Market): Promise<FeedSnapshot> {
    const id = m.descriptor.market_id;
    const ov = this.overrides.get(id);
    this.block += 1n;
    const mids = this.step(m);
    const books =
      ov?.books ??
      mids.map((mid, i) => {
        const bids: BookLevel[] = [];
        const asks: BookLevel[] = [];
        for (let k = 0n; k < 5n; k++) {
          const b = mid - this.halfSpread - k * TICK;
          const a = mid + this.halfSpread + k * TICK;
          if (b > 0n) bids.push({ price: b.toString(), size: (this.depthUnits * UNIT).toString() });
          if (a < PRICE_SCALE) asks.push({ price: a.toString(), size: (this.depthUnits * UNIT).toString() });
        }
        return { outcome_id: i, bids, asks };
      });
    return { books, status: ov?.status ?? "Open", sourceChain: "mock-venue:polygon-sim", observedBlock: this.block, provenance: { feed: "mock", mids: mids.map(String), block: this.block.toString() } };
  }
}

/** Read-only Polymarket CLOB adapter. Maps `polygon:ctf:<token_id>` refs to public order books. */
export class PolymarketFeed implements Feed {
  constructor(readonly base = "https://clob.polymarket.com") {}
  async snapshot(m: Market): Promise<FeedSnapshot> {
    const books: OutcomeBook[] = [];
    const raw: unknown[] = [];
    for (const o of m.descriptor.outcomes) {
      const token = o.venue_token_ref.split(":").pop()!;
      if (!/^\d+$/.test(token)) throw new Error(`PolymarketFeed: ${o.venue_token_ref} is not a live CLOB token id`);
      const r = await fetch(`${this.base}/book?token_id=${token}`, { headers: { "user-agent": "basis-amm-oracle/0.1" } });
      if (!r.ok) throw new Error(`PolymarketFeed: HTTP ${r.status} for ${token}`);
      const b: any = await r.json();
      raw.push(b);
      const conv = (lv: any[]) => lv.map((l) => ({ price: BigInt(Math.round(Number(l.price) * 1e6)).toString(), size: BigInt(Math.round(Number(l.size) * 1e6)).toString() }));
      const bids = conv(b.bids ?? []).sort((a, z) => (BigInt(z.price) > BigInt(a.price) ? 1 : -1));
      const asks = conv(b.asks ?? []).sort((a, z) => (BigInt(a.price) > BigInt(z.price) ? 1 : -1));
      books.push({ outcome_id: o.outcome_id, bids: bids.slice(0, 10), asks: asks.slice(0, 10) });
    }
    return { books, status: "Open", sourceChain: "polygon:137:polymarket-clob", observedBlock: 0n, provenance: raw };
  }
}

export interface DiscoveredMarket {
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  outcomes: string[];
  tokenIds: string[];
  liquidity: number;
  volume24h: number;
  tickSize: number;
  category: string;
  /** Last price of the first outcome (usually YES). */
  price: number | null;
}

/** Read-only Gamma API discovery: active, order-book-enabled markets. Produces data for draft
 * manifests; admission still requires a governance proposal and risk-council approval. */
export async function discoverPolymarket(limit = 20, base = "https://gamma-api.polymarket.com"): Promise<DiscoveredMarket[]> {
  const r = await fetch(`${base}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`, { headers: { "user-agent": "basis-amm-discovery/0.1" } });
  if (!r.ok) throw new Error(`gamma HTTP ${r.status}`);
  const rows: any[] = await r.json();
  const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v ?? []);
  return rows
    .filter((m) => m.enableOrderBook && m.clobTokenIds)
    .map((m) => ({
      question: m.question,
      conditionId: m.conditionId,
      slug: m.slug,
      endDate: m.endDate,
      outcomes: parse(m.outcomes),
      tokenIds: parse(m.clobTokenIds),
      liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
      volume24h: Number(m.volume24hr ?? 0),
      tickSize: Number(m.orderPriceMinTickSize ?? 0.01),
      category: m.category ?? m.events?.[0]?.category ?? "Uncategorized",
      price: parse(m.outcomePrices)[0] !== undefined ? Number(parse(m.outcomePrices)[0]) : null,
    }));
}
