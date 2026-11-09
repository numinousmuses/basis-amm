/** Live Polymarket order books via the official SDK, normalized to Basis BookLevel (1e6 units,
 * bids descending, asks ascending; the API returns them worst-price first). */
import { createPublicClient } from "@polymarket/client";
import { sourceHash, type BookLevel, type Market, type OutcomeBook } from "@basis/sdk";
import type { Feed, FeedSnapshot } from "../feeds.js";
import { liveRefs, toMicro } from "./refs.js";

type PublicClient = ReturnType<typeof createPublicClient>;
let shared: PublicClient | undefined;
export const pmPublic = (): PublicClient => (shared ??= createPublicClient());

export function normalizeBook(raw: { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> }, levels = 10): Pick<OutcomeBook, "bids" | "asks"> {
  const conv = (l: { price: string; size: string }): BookLevel => ({ price: toMicro(l.price).toString(), size: toMicro(l.size).toString() });
  const ok = (l: BookLevel) => BigInt(l.price) > 0n && BigInt(l.price) < 1_000_000n && BigInt(l.size) > 0n;
  const bids = raw.bids.map(conv).filter(ok).sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : BigInt(b.price) < BigInt(a.price) ? -1 : 0));
  const asks = raw.asks.map(conv).filter(ok).sort((a, b) => (BigInt(a.price) > BigInt(b.price) ? 1 : BigInt(a.price) < BigInt(b.price) ? -1 : 0));
  return { bids: bids.slice(0, levels), asks: asks.slice(0, levels) };
}

export async function liveBooks(m: Market, client = pmPublic()): Promise<{ books: OutcomeBook[]; raw: unknown[] }> {
  const refs = liveRefs(m);
  if (!refs) throw new Error(`${m.descriptor.market_id} is not a live Polymarket market`);
  const raw: unknown[] = [];
  const books: OutcomeBook[] = [];
  for (let i = 0; i < refs.assetIds.length; i++) {
    const b: any = await client.fetchOrderBook({ assetId: refs.assetIds[i] });
    raw.push({ hash: b.hash, timestamp: b.timestamp, assetId: refs.assetIds[i] });
    books.push({ outcome_id: i, ...normalizeBook(b) });
  }
  return { books, raw };
}

/** Oracle feed reading live books (read-only, no auth, not geoblocked). */
export class LivePolymarketFeed implements Feed {
  async snapshot(m: Market): Promise<FeedSnapshot> {
    const { books, raw } = await liveBooks(m);
    return { books, status: "Open", sourceChain: "polygon:137:polymarket-clob", observedBlock: 0n, provenance: { raw, hash: sourceHash(raw) } };
  }
}
