/** Live Polymarket helpers: market detection, event links, hedge venue labels and transaction
 * links. Detection uses the same patterns as basis-node (services/basis-node/src/polymarket/refs.ts)
 * so the dashboard and the executor always agree on which markets are live. */
import type { MarketDescriptor, MarketPolicy } from "@basis/sdk";

/** `polygon:ctf:<decimal CTF token id>` (v1) or `polygon:pmv2:<decimal position id>` (Protocol V2). */
export const REF_RE = /^polygon:(ctf|pmv2):(\d{10,})$/;
/** `polymarket:<v1|v2>:condition:<0x condition id>`. */
export const EXT_RE = /^polymarket:(v1|v2):condition:(0x[0-9a-fA-F]{62,64})$/;

export interface LiveRefs {
  version: "v1" | "v2";
  conditionId: string;
  assetIds: string[];
}

/** Live refs of a market, or null for mock fixtures. Every outcome must carry a live ref. */
export function liveRefs(d: Pick<MarketDescriptor, "external_market_id" | "outcomes">): LiveRefs | null {
  const ext = d.external_market_id.match(EXT_RE);
  if (!ext) return null;
  const ids: string[] = [];
  for (const o of d.outcomes) {
    const r = o.venue_token_ref.match(REF_RE);
    if (!r) return null;
    ids.push(r[2]);
  }
  return { version: ext[1] as "v1" | "v2", conditionId: ext[2], assetIds: ids };
}

export const isLiveMarket = (d: Pick<MarketDescriptor, "external_market_id" | "outcomes">) => liveRefs(d) !== null;

/** Source chain of marks read from the live Polymarket CLOB. */
export const LIVE_SOURCE_PREFIX = "polygon:137:polymarket-clob";
export const isLiveSource = (sourceChain: string | null | undefined) => !!sourceChain && sourceChain.startsWith(LIVE_SOURCE_PREFIX);

const PM_URL_RE = /https:\/\/(?:www\.)?polymarket\.com\/(?:event|market)\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)?/;

/** polymarket.com event URL from the descriptor's resolution source or the policy's rules text. */
export function polymarketUrl(d: Pick<MarketDescriptor, "resolution_source"> | null | undefined, p?: Pick<MarketPolicy, "human_readable_rules"> | null): string | null {
  for (const s of [d?.resolution_source, p?.human_readable_rules]) {
    const m = s?.match(PM_URL_RE);
    if (m) return m[0].replace(/[.)]+$/, "");
  }
  return null;
}

// ------------------------------------------------------------------ hedge venue

export type VenueMode = "MOCK" | "PAPER" | "LIVE";

export interface VenueLabel {
  mode: VenueMode;
  title: string;
  detail: string;
  /** chip class: sim for anything simulated, bad for real money so it stands out. */
  chip: "sim" | "bad";
}

/** Plain label for the hedge venue basis-node reports in `/api/polymarket/status`. */
export function venueLabel(venue: string | null | undefined, simulated: boolean | null | undefined): VenueLabel {
  if (venue === "polymarket-live" && simulated === false)
    return { mode: "LIVE", title: "LIVE: real Polymarket orders", detail: "Hedges are real orders on Polymarket, settled on Polygon with real funds, inside the daily and per-order caps below.", chip: "bad" };
  if (venue === "polymarket-paper" || (venue?.startsWith("polymarket") && simulated !== false))
    return { mode: "PAPER", title: "PAPER: simulated fills against live Polymarket books", detail: "Hedges walk the live Polymarket order book to price a fill, but no order is placed and no funds move. Receipts carry simulated: true.", chip: "sim" };
  return { mode: "MOCK", title: "MOCK: simulated venue", detail: "Hedges fill against the deterministic mock venue book. No real market is touched. Receipts carry simulated: true.", chip: "sim" };
}

// ------------------------------------------------------------------ transaction links

export type TxLink = { kind: "polygon"; url: string; hash: string } | { kind: "paper"; hash: string } | { kind: "sim"; hash: string } | { kind: "none"; hash: string };

const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;

/** Classify a hedge transaction reference. Only a real 0x Polygon hash on a non-simulated fill
 * gets an explorer link; paper and mock receipts never look like real transactions. */
export function txLink(hash: string | null | undefined, simulated?: boolean | number | null): TxLink {
  const h = (hash ?? "").trim();
  if (!h) return { kind: "none", hash: h };
  if (h.startsWith("paper:")) return { kind: "paper", hash: h };
  if (h.startsWith("sim:") || h.startsWith("mock")) return { kind: "sim", hash: h };
  if (EVM_TX_RE.test(h) && !simulated) return { kind: "polygon", url: `https://polygonscan.com/tx/${h}`, hash: h };
  return { kind: simulated ? "sim" : "none", hash: h };
}

/** sqlite rows carry booleans as 0/1. */
export const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

/** NEAR explorer link for a transaction, or null on a private sandbox (no public explorer). */
export function nearTxUrl(network: string, hash: string): string | null {
  if (!hash) return null;
  if (network === "testnet") return `https://testnet.nearblocks.io/txns/${hash}`;
  if (network === "mainnet") return `https://nearblocks.io/txns/${hash}`;
  return null;
}

/** Polymarket decimal price ("0.095") as a 1e6 fixed price (95000n); null when unparseable. */
export function pmPriceMicro(price: string | number | null | undefined): bigint | null {
  if (price === null || price === undefined || price === "") return null;
  const str = typeof price === "number" ? price.toFixed(6) : String(price).trim();
  const m = str.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m) return null;
  const v = BigInt(m[1] || "0") * 1_000_000n + BigInt(((m[2] ?? "") + "000000").slice(0, 6));
  return v > 1_000_000n ? null : v;
}

/** Condition ids of admitted live markets, lowercased, to mark discovered markets as already admitted. */
export function admittedConditions(descriptors: Array<Pick<MarketDescriptor, "external_market_id" | "outcomes" | "market_id">>): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of descriptors) {
    const r = liveRefs(d);
    if (r) out.set(r.conditionId.toLowerCase(), d.market_id);
  }
  return out;
}
