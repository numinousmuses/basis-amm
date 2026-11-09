/** basis-node read API. The backend is a projection: every value it returns is either read from
 * the contract at request time or links back to a contract event seq / signed report id. */
import type {
  EffectiveActions,
  HedgeFillReceipt,
  Market,
  MarketManifest,
  MarketDescriptor,
  MarketPolicy,
  Order,
  PositionView,
  ProtocolConfig,
  PauseFlags,
  ResolutionProposal,
  RiskSummary,
  Roles,
  StoredMark,
  VaultSummary,
  Conservation,
  Withdrawal,
  OpenPreview,
} from "@basis/sdk";

const DEFAULT_API = "http://127.0.0.1:8797";

/** API base: `?api=` query param (remembered), then VITE_API_URL, then the local default. */
export function resolveApiUrl(): string {
  if (typeof window === "undefined") return import.meta.env?.VITE_API_URL ?? DEFAULT_API;
  const q = new URLSearchParams(window.location.search).get("api");
  if (q) localStorage.setItem("basis.api", q);
  return (q ?? localStorage.getItem("basis.api") ?? import.meta.env.VITE_API_URL ?? DEFAULT_API).replace(/\/$/, "");
}

export const API_URL = resolveApiUrl();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(API_URL + path, init);
  } catch (e) {
    throw new ApiError(0, `basis-node API unreachable at ${API_URL}`);
  }
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, body?.error ?? `HTTP ${r.status}`);
  return body as T;
}
const post = <T>(path: string, body: unknown) => req<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface StackInfo {
  network: string;
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  roles: Roles;
  devControls: boolean;
  quoteKey: string;
  markReporter: string;
  simulatedVenue: boolean;
}
export interface MarketRow {
  market: Market;
  mark: StoredMark | null;
  actions: EffectiveActions;
  risk: RiskSummary;
  policy: MarketPolicy | null;
  mid_24h_ago: string[] | null;
}
export interface MarketDetail extends Omit<MarketRow, "mid_24h_ago"> {
  policy_history: string[];
  resolution: ResolutionProposal | null;
  hedge_fills: HedgeFillReceipt[];
}
export interface MarkRow {
  id: number;
  market: string;
  ts_ms: number;
  mids: string[];
  bids: string[];
  asks: string[];
  report_id: string;
  source_chain: string;
}
export interface VaultInfo {
  summary: VaultSummary;
  conservation: Conservation;
  config: ProtocolConfig;
  pause: PauseFlags;
  queued: Withdrawal[];
}
export interface VaultRow {
  ts_ms: number;
  nav: string;
  share_price: string;
  free: string;
  reserve: string;
  stress: string;
  insurance: string;
  supply: string;
  open_margin: string;
  fees: string;
}
export interface EventRow {
  seq: number;
  ts_ns: string;
  block: number;
  kind: string;
  data: any;
}
export interface AccountInfo {
  account: string;
  positions: PositionView[];
  orders: Order[];
  withdrawals: Withdrawal[];
  claimable: string;
  usdc: string;
  blp: string;
}
export interface Quote {
  quote_id: string;
  expires_ms: number;
  preview: OpenPreview;
  total_upfront_fee: string;
  admissible: boolean;
  reasons: string[];
  suggested_leverage: string | null;
  signature: string;
  quote_key: string;
}
export interface DevAccount {
  role: string;
  accountId: string;
  secretKey: string;
}
export interface ManifestEntry {
  manifest: MarketManifest;
  chain: { descriptor: MarketDescriptor; policy: MarketPolicy };
}
export interface ReconReport {
  ok: boolean;
  detail?: string;
  ts?: number;
  [k: string]: unknown;
}

/** Executor ledger row (sqlite `exec_fills`). `simulated` is 0/1. Units are shares in 1e6. */
export interface ExecFill {
  fill_id: string;
  order_id: string | null;
  market: string;
  outcome: number;
  units: string;
  price: string;
  tx: string;
  ts_ms: number;
  side: "buy" | "sell" | string;
  simulated: number | boolean;
}
export interface ResolverObservation {
  source: string;
  resolved: boolean;
  payoutsPpm: string[];
  evidence: string;
}
export interface PolymarketStatus {
  venue: string | null;
  simulated: boolean;
  executor_address: string | null;
  signer_audit: Array<{ at: string; primaryType: string; ok: boolean; error?: string }>;
  spent_today_usd: number;
  caps: { max_order_usd: number; max_daily_usd: number } | null;
  resolutions: Record<string, { api?: ResolverObservation; chain?: ResolverObservation; at: string }>;
  custody: Record<string, string[]>;
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
}
/** Subset of `@polymarket/client` fetchMarket we display. */
export interface PolymarketMarket {
  id: string;
  version: "v1" | "v2" | string;
  slug: string;
  conditionId: string;
  question: string;
  outcomes: { yes?: { label: string; price: string }; no?: { label: string; price: string } };
  prices?: { bestBid?: string; bestAsk?: string; lastTradePrice?: string };
  state?: { acceptingOrders?: boolean; endDate?: string };
}
export interface AdmitResult {
  ok: boolean;
  market_id: string;
  propose_tx: string;
  approve_tx: string;
  polymarket_slug: string;
}
export type Family = "crypto" | "sports" | "election" | "macro";

export const api = {
  stack: () => req<StackInfo>("/api/stack"),
  health: () => req<{ ok: boolean; uptime_s: number; keeper: Record<string, number>; last_seq: number }>("/api/health"),
  markets: () => req<MarketRow[]>("/api/markets"),
  market: (id: string) => req<MarketDetail>(`/api/markets/${encodeURIComponent(id)}`),
  marks: (id: string, sinceMs: number, limit = 500) => req<MarkRow[]>(`/api/markets/${encodeURIComponent(id)}/marks?since=${sinceMs}&limit=${limit}`),
  vault: () => req<VaultInfo>("/api/vault"),
  vaultHistory: (sinceMs: number) => req<VaultRow[]>(`/api/vault/history?since=${sinceMs}`),
  events: (from = 0, limit = 100, kind?: string) => req<EventRow[]>(`/api/events?from=${from}&limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`),
  account: (id: string) => req<AccountInfo>(`/api/accounts/${encodeURIComponent(id)}`),
  quote: (q: { market_id: string; outcome_id: number; margin: string; leverage: string; max_fee?: string }) => post<Quote>("/api/quote", q),
  reconciliation: () => req<Record<string, ReconReport>>("/api/reconciliation"),
  fills: () => req<ExecFill[]>("/api/executor/fills"),
  polymarketStatus: () => req<PolymarketStatus>("/api/polymarket/status"),
  discover: (limit = 30) => req<DiscoveredMarket[]>(`/api/polymarket/discover?limit=${limit}`),
  polymarketMarket: (slug: string) => req<PolymarketMarket>(`/api/polymarket/market/${encodeURIComponent(slug)}`),
  admitPolymarket: (b: { slug: string; family?: Family; strategy?: "HedgeRequired" | "PoolPlusHedge" | "PoolOnly" }) => post<AdmitResult>("/api/dev/admit-polymarket", b),
  manifests: () => req<ManifestEntry[]>("/api/manifests"),
  devAccounts: () => req<DevAccount[]>("/api/dev/accounts"),
  devVenue: (b: { market_id: string; mids?: string[]; clear?: boolean; status?: string }) => post<{ ok: boolean; label: string }>("/api/dev/venue", b),
  devResolve: (b: { market_id: string; scenario: number; status?: string }) => post<{ ok: boolean; txs: string[]; label: string }>("/api/dev/resolve", b),
};

export function wsUrl(): string {
  return API_URL.replace(/^http/, "ws") + "/ws";
}
