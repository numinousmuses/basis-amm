/** Human-readable market manifests (policies/examples/*.json) -> exact contract structs.
 * Manifests are data: adding a market or category is a governance action, never a code change. */
import type { MarketDescriptor, MarketPolicy, PayoutScenario, StrategyMode } from "./types.js";
import { decimalToFixed } from "./units.js";

export interface ManifestOutcome {
  label: string;
  venue_token_ref: string;
}
export interface MarketManifest {
  descriptor: {
    market_id: string;
    venue: string;
    chain: string;
    external_market_id: string;
    underlying_event: string;
    category_label: string;
    outcomes: ManifestOutcome[];
    /** "exclusive" = exactly one outcome pays $1; optional extra scenario for invalid markets. */
    scenarios: "exclusive" | { label: string; payouts: string[] }[];
    invalid_scenario?: { label: string; payouts: string[] };
    resolution_adapter_id: string;
    resolution_source: string;
    event_start: string;
    expected_resolution: string;
  };
  policy: {
    risk_model_id: string;
    executor_adapter_id: string;
    pricing_adapter_id: string;
    strategy: StrategyMode;
    allowed_actions: { open: boolean; increase: boolean; reduce: boolean; close: boolean; liquidate: boolean };
    entry_start: string;
    entry_end: string;
    event_windows: { label: string; start: string; end: string; mode: "CloseOnly" | "Suspend" }[];
    max_leverage: string;
    min_adverse_ticks: number;
    tick_size: string;
    min_margin_usd: string;
    max_margin_usd: string;
    max_open_units_per_outcome: string;
    max_payout_liability_usd: string;
    maintenance_bps: number;
    maintenance_fixed_usd: string;
    max_spread_bps: number;
    exit_depth_bps: number;
    max_mark_staleness_s: number;
    min_resolution_reporters: number;
    dispute_window_s: number;
    fees: {
      open_bps: number;
      close_bps: number;
      hold_apr_bps: number;
      liquidation_reward_bps: number;
      liquidation_reward_cap_usd: string;
      floor_coverage_bps: number;
      insurance_share_bps: number;
      treasury_share_bps: number;
    };
    event_stress_cap_bps: number;
    hedge_budget_bps: number;
    max_hedge_slippage_bps: number;
    min_fill_floor_pct: string;
    max_order_lifetime_s: number;
    governance_approval: string;
    human_readable_rules: string;
  };
}

const S = 1_000_000_000n;
/** ISO time, "now", "now+3600", "now-60" (seconds), or "res-3600" (relative to the market's
 * expected resolution) -> ns string. */
export function timeNs(v: string, nowMs = Date.now(), resolutionNs?: bigint): string {
  const m = v.match(/^now([+-]\d+)?$/);
  if (m) return ((BigInt(nowMs) * 1_000_000n) + BigInt(m[1] ?? "0") * S).toString();
  const r = v.match(/^res([+-]\d+)?$/);
  if (r) {
    if (resolutionNs === undefined) throw new Error("manifest: res-relative time needs expected_resolution");
    return (resolutionNs + BigInt(r[1] ?? "0") * S).toString();
  }
  if (v === "max") return "18446744073709551615";
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`manifest: bad time ${v}`);
  return (BigInt(t) * 1_000_000n).toString();
}

const usd = (s: string) => decimalToFixed(s, 6).toString();
const px = (s: string) => decimalToFixed(s, 6).toString();

export function manifestToChain(m: MarketManifest, nowMs = Date.now()): { descriptor: MarketDescriptor; policy: MarketPolicy } {
  const d = m.descriptor;
  const n = d.outcomes.length;
  let scenarios: PayoutScenario[];
  if (d.scenarios === "exclusive") {
    scenarios = d.outcomes.map((o, i) => ({
      label: `${o.label} wins`,
      payouts: d.outcomes.map((_, j) => (i === j ? "1000000" : "0")),
    }));
  } else {
    scenarios = d.scenarios.map((s) => ({ label: s.label, payouts: s.payouts.map(px) }));
  }
  if (d.invalid_scenario) scenarios.push({ label: d.invalid_scenario.label, payouts: d.invalid_scenario.payouts.map(px) });
  for (const s of scenarios) if (s.payouts.length !== n) throw new Error(`manifest ${d.market_id}: payout vector length`);
  const descriptor: MarketDescriptor = {
    market_id: d.market_id,
    venue: d.venue,
    chain: d.chain,
    external_market_id: d.external_market_id,
    underlying_event: d.underlying_event,
    category_label: d.category_label,
    outcomes: d.outcomes.map((o, i) => ({ outcome_id: i, label: o.label, venue_token_ref: o.venue_token_ref })),
    scenarios,
    resolution_adapter_id: d.resolution_adapter_id,
    resolution_source: d.resolution_source,
    event_start_ns: timeNs(d.event_start, nowMs),
    expected_resolution_ns: timeNs(d.expected_resolution, nowMs),
  };
  const p = m.policy;
  const resNs = BigInt(descriptor.expected_resolution_ns);
  const policy: MarketPolicy = {
    schema_version: 1,
    risk_model_id: p.risk_model_id,
    executor_adapter_id: p.executor_adapter_id,
    pricing_adapter_id: p.pricing_adapter_id,
    strategy: p.strategy,
    allowed_actions: p.allowed_actions,
    entry_start_ns: timeNs(p.entry_start, nowMs, resNs),
    entry_end_ns: timeNs(p.entry_end, nowMs, resNs),
    event_windows: p.event_windows.map((w) => ({ label: w.label, start_ns: timeNs(w.start, nowMs, resNs), end_ns: timeNs(w.end, nowMs, resNs), mode: w.mode })),
    max_leverage: decimalToFixed(p.max_leverage, 4).toString(),
    min_adverse_ticks: p.min_adverse_ticks,
    tick_size: px(p.tick_size),
    min_margin: usd(p.min_margin_usd),
    max_margin: usd(p.max_margin_usd),
    max_open_units_per_outcome: decimalToFixed(p.max_open_units_per_outcome, 6).toString(),
    max_payout_liability: usd(p.max_payout_liability_usd),
    maintenance_bps: p.maintenance_bps,
    maintenance_fixed: usd(p.maintenance_fixed_usd),
    max_spread_bps: p.max_spread_bps,
    exit_depth_bps: p.exit_depth_bps,
    max_mark_staleness_ns: (BigInt(p.max_mark_staleness_s) * S).toString(),
    min_resolution_reporters: p.min_resolution_reporters,
    dispute_window_ns: (BigInt(p.dispute_window_s) * S).toString(),
    fees: {
      open_bps: p.fees.open_bps,
      close_bps: p.fees.close_bps,
      hold_apr_bps: p.fees.hold_apr_bps,
      liquidation_reward_bps: p.fees.liquidation_reward_bps,
      liquidation_reward_cap: usd(p.fees.liquidation_reward_cap_usd),
      floor_coverage_bps: p.fees.floor_coverage_bps,
      insurance_share_bps: p.fees.insurance_share_bps,
      treasury_share_bps: p.fees.treasury_share_bps,
    },
    event_stress_cap_bps: p.event_stress_cap_bps,
    hedge_budget_bps: p.hedge_budget_bps,
    max_hedge_slippage_bps: p.max_hedge_slippage_bps,
    min_fill_floor_ppm: decimalToFixed(p.min_fill_floor_pct, 4).toString(),
    max_order_lifetime_ns: (BigInt(p.max_order_lifetime_s) * S).toString(),
    governance_approval: p.governance_approval,
    human_readable_rules: p.human_readable_rules,
  };
  return { descriptor, policy };
}
