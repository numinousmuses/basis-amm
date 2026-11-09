/** Order-intent construction and order-state interpretation. The intent is what the user signs
 * (inside the `ft_transfer_call` msg), so every field is explicit and checked here before the
 * wallet prompt, mirroring the contract's own `internal_request_open` checks. */
import { LEV_SCALE, PPM, PRICE_SCALE, type MarketPolicy, type OpenPreview, type Order, type OrderIntent, type StrategyMode } from "@basis/sdk";

const MS_NS = 1_000_000n;

let lastNonce = 0n;
/** Unique, increasing nonce per browser session: microseconds since epoch, bumped on collision. */
export function nextNonce(nowMs = Date.now()): bigint {
  let n = BigInt(nowMs) * 1000n;
  if (n <= lastNonce) n = lastNonce + 1n;
  lastNonce = n;
  return n;
}

export interface IntentInput {
  marketId: string;
  outcomeId: number;
  policyHash: string;
  policy: Pick<MarketPolicy, "max_order_lifetime_ns" | "min_fill_floor_ppm" | "max_hedge_slippage_bps">;
  margin: bigint;
  leverage: bigint;
  maxFee: bigint;
  maxEntryPrice: bigint;
  allowPartialFill: boolean;
  /** Ignored (forced to 100%) when partial fills are off. */
  minFillPpm: bigint;
  takeProfit?: bigint | null;
  stopLoss?: bigint | null;
  quoteId: string;
  nowMs?: number;
  nonce?: bigint;
}

/** Deadline: five minutes, or the policy's maximum order lifetime minus a 10 s safety margin. */
export function intentDeadlineNs(nowMs: number, lifetimeNs: bigint): bigint {
  const want = 300_000_000_000n;
  const cap = lifetimeNs - 10_000_000_000n;
  const life = cap > 0n && cap < want ? cap : want;
  return BigInt(nowMs) * MS_NS + life;
}

/** Effective minimum fill that will be signed: 100% when partial fills are off, otherwise the
 * user's choice clamped to [policy floor, 100%]. */
export function effectiveMinFill(allowPartial: boolean, minFillPpm: bigint, floorPpm: bigint): bigint {
  if (!allowPartial) return PPM;
  const floor = floorPpm > 0n ? floorPpm : 1n;
  if (minFillPpm < floor) return floor;
  if (minFillPpm > PPM) return PPM;
  return minFillPpm;
}

export function buildIntent(i: IntentInput): OrderIntent {
  if (i.margin <= 0n) throw new Error("Margin must be positive");
  if (i.leverage < LEV_SCALE) throw new Error("Leverage must be at least 1x");
  if (i.maxEntryPrice <= 0n || i.maxEntryPrice >= PRICE_SCALE) throw new Error("Maximum entry price must be between 0 and 1");
  if (i.maxFee < 0n) throw new Error("Maximum fee cannot be negative");
  for (const p of [i.takeProfit, i.stopLoss]) if (p !== null && p !== undefined && (p <= 0n || p > PRICE_SCALE)) throw new Error("Trigger prices must be between 0 and 1");
  const nowMs = i.nowMs ?? Date.now();
  const nonce = i.nonce ?? nextNonce(nowMs);
  return {
    nonce: nonce.toString(),
    market_id: i.marketId,
    outcome_id: i.outcomeId,
    margin_amount: i.margin.toString(),
    requested_leverage: i.leverage.toString(),
    max_entry_price: i.maxEntryPrice.toString(),
    max_hedge_slippage_bps: i.policy.max_hedge_slippage_bps,
    max_fee: i.maxFee.toString(),
    deadline_ns: intentDeadlineNs(nowMs, BigInt(i.policy.max_order_lifetime_ns)).toString(),
    take_profit_price: i.takeProfit ? i.takeProfit.toString() : null,
    stop_loss_price: i.stopLoss ? i.stopLoss.toString() : null,
    allow_partial_fill: i.allowPartialFill,
    minimum_acceptable_fill_ppm: effectiveMinFill(i.allowPartialFill, i.minFillPpm, BigInt(i.policy.min_fill_floor_ppm)).toString(),
    policy_hash: i.policyHash,
    quote_id: i.quoteId,
  };
}

/** Default signed fee cap: 1.5x the quoted upfront fee (open fee + risk premium) plus one cent,
 * rounded up to a whole cent. Execution re-prices at a later mark, so the cap needs headroom;
 * whatever is not charged is refunded in the same transaction that opens the position. */
export function defaultMaxFee(upfront: bigint): bigint {
  const raw = (upfront * 3n + 1n) / 2n + 10_000n;
  return ((raw + 9_999n) / 10_000n) * 10_000n;
}

/** Slippage-bounded maximum entry price, capped below $1. */
export function maxEntryWithSlippage(entry: bigint, slippageBps: number): bigint {
  const v = entry + (entry * BigInt(slippageBps) + 9_999n) / 10_000n;
  const cap = PRICE_SCALE - 10_000n;
  return v > cap ? cap : v;
}

/** Minimum acceptable exit for a close: the executable bid minus slippage, floored at 0. */
export function minExitWithSlippage(bid: bigint, slippageBps: number): bigint {
  const v = bid - (bid * BigInt(slippageBps)) / 10_000n;
  return v > 0n ? v : 0n;
}

/** Highest leverage the composer offers: min(policy, protocol, tick-sensitivity ceiling). */
export function leverageCap(p: Pick<OpenPreview, "policy_max_leverage" | "protocol_max_leverage" | "tick_leverage_ceiling">): bigint {
  return [BigInt(p.policy_max_leverage), BigInt(p.protocol_max_leverage), BigInt(p.tick_leverage_ceiling)].reduce((a, b) => (a < b ? a : b));
}

/** Which bound sets the leverage cap, in plain words, so the rules sheet can say why it shrinks. */
export function leverageCapReason(p: Pick<OpenPreview, "policy_max_leverage" | "protocol_max_leverage" | "tick_leverage_ceiling">): string {
  const cap = leverageCap(p);
  if (BigInt(p.tick_leverage_ceiling) === cap && cap < BigInt(p.policy_max_leverage))
    return "Tick-sensitivity ceiling: at this entry price, a higher leverage would let fewer adverse ticks than the policy minimum consume your margin.";
  if (BigInt(p.policy_max_leverage) === cap) return "Market policy maximum for this market.";
  return "Protocol-wide leverage ceiling.";
}

export type OrderResult =
  | { kind: "open"; positionId: string; fillPpm: bigint | null }
  | { kind: "closed"; positionId: string; full: boolean }
  | { kind: "reserved" }
  | { kind: "rejected"; reason: string }
  | { kind: "none" };

/** Parse `Order.result` strings written by the contract. */
export function parseOrderResult(o: Pick<Order, "state" | "result" | "position_id">): OrderResult {
  const r = o.result ?? "";
  const open = r.match(/^OPEN position (\d+) fill_ppm (\d+)/);
  if (open) return { kind: "open", positionId: open[1], fillPpm: BigInt(open[2]) };
  const closed = r.match(/^CLOSED:(\d+):(full|partial)/);
  if (closed) return { kind: "closed", positionId: closed[1], full: closed[2] === "full" };
  if (o.state === "Executed" && o.position_id) return { kind: "open", positionId: o.position_id, fillPpm: null };
  if (o.state === "Rejected" || o.state === "Expired" || o.state === "Cancelled") return { kind: "rejected", reason: r || o.state.toUpperCase() };
  if (o.state === "RiskReserved" || o.state === "Hedging" || o.state === "HedgedProvisional") return { kind: "reserved" };
  return { kind: "none" };
}

export type StepStatus = "done" | "active" | "skipped" | "failed" | "pending";
export interface TimelineStep {
  state: "Requested" | "RiskReserved" | "Hedging" | "HedgedProvisional" | "Executed" | "Rejected";
  label: string;
  status: StepStatus;
  note?: string;
}

const ORDER_FLOW = ["Requested", "RiskReserved", "Hedging", "HedgedProvisional", "Executed"] as const;
const LABELS: Record<(typeof ORDER_FLOW)[number], string> = {
  Requested: "Requested",
  RiskReserved: "Risk reserved",
  Hedging: "Hedging",
  HedgedProvisional: "Hedged (provisional)",
  Executed: "Executed",
};

/** Order status tracker. Outside HEDGE_REQUIRED the contract reserves risk and opens in one
 * receipt, so the hedge steps are shown as not used rather than pretending they happened. */
export function orderTimeline(state: Order["state"] | "Submitting", mode: StrategyMode, result?: string | null): TimelineStep[] {
  const hedged = mode === "HedgeRequired";
  const failed = state === "Rejected" || state === "Expired" || state === "Cancelled";
  const reached = state === "Submitting" ? -1 : failed ? 0 : ORDER_FLOW.indexOf(state as (typeof ORDER_FLOW)[number]);
  const steps: TimelineStep[] = ORDER_FLOW.map((s, i) => {
    if (!hedged && i > 0 && i < 4) {
      return { state: s, label: LABELS[s], status: "skipped", note: s === "RiskReserved" ? "Atomic with execution in pool-only mode" : "No external hedge in this mode" };
    }
    let status: StepStatus = "pending";
    if (reached > i || (reached === i && (s === "Executed" || failed))) status = "done";
    else if (reached === i) status = "active";
    else if (!failed && s === "Executed" && state === "Requested" && !hedged) status = "active";
    return { state: s, label: LABELS[s], status };
  });
  if (!hedged && state === "Requested") steps[0].status = "done";
  if (failed) steps.push({ state: "Rejected", label: state, status: "failed", note: result ?? undefined });
  return steps;
}
