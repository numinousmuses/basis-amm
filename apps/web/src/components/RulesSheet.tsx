import type { EffectiveActions, Market, MarketPolicy, OpenPreview, StrategyMode } from "@basis/sdk";
import { bpsPct, fmtDate, fmtDurationNs, levX, nsToMs, ppmPct, shortHash, usd, cents } from "../lib/format";
import { explainReason } from "../lib/errors";
import { leverageCap, leverageCapReason } from "../lib/intent";

export const STRATEGY_TEXT: Record<StrategyMode, string> = {
  PoolOnly: "POOL_ONLY: the vault is your direct counterparty. No external shares are bought; the position opens when the contract executes.",
  PoolPlusHedge: "POOL_PLUS_HEDGE: the vault is your counterparty and may separately rebalance its own hedge inventory. Your position does not wait for a hedge.",
  HedgeRequired: "HEDGE_REQUIRED: the vault must buy its own hedge before your position opens. The order stays reserved until hedge fills are reconciled.",
};

/** Market rules sheet, shown before any order is signed and from every market. All values are
 * read from the contract's approved policy for the market's current policy hash. */
export function RulesSheet({ market, policy, actions, preview, protocolMax }: { market: Market; policy: MarketPolicy; actions?: EffectiveActions; preview?: OpenPreview | null; protocolMax?: string }) {
  const d = market.descriptor;
  const now = Date.now();
  const inPlay = nsToMs(d.event_start_ns) <= now && now < nsToMs(d.expected_resolution_ns);
  const f = policy.fees;
  const levWhy = preview
    ? leverageCapReason(preview)
    : `Policy maximum ${levX(policy.max_leverage)}${protocolMax ? `, protocol ceiling ${levX(protocolMax)}` : ""}; shrinks when the tick-sensitivity test binds at the entry price.`;
  const rows: Array<[string, React.ReactNode]> = [
    ["Current state", `${market.state}${actions && !actions.open ? " (no new opens)" : ""}`],
    ...(actions?.reasons.length ? ([["Restrictions", actions.reasons.map((r) => explainReason(r)).join(" ")]] as Array<[string, React.ReactNode]>) : []),
    ["Policy version", `epoch ${market.policy_epoch}`],
    ["Policy hash", <span className="code wrapCode" data-testid="rules-policy-hash">{market.policy_hash}</span>],
    ["Governance approval", policy.governance_approval],
    ["Strategy", STRATEGY_TEXT[policy.strategy]],
    ["Entry window", `${fmtDate(nsToMs(policy.entry_start_ns))} to ${fmtDate(nsToMs(policy.entry_end_ns))}`],
    ["Event windows", policy.event_windows.length ? policy.event_windows.map((w) => `${w.label}: ${w.mode === "CloseOnly" ? "close only" : "suspended"} ${fmtDate(nsToMs(w.start_ns))} to ${fmtDate(nsToMs(w.end_ns))}`).join("; ") : "None scheduled"],
    ["Event in play", inPlay ? "Yes, the event window has started" : "No"],
    ["Allowed actions", Object.entries(policy.allowed_actions).filter(([, v]) => v).map(([k]) => k).join(", ")],
    ["Maximum leverage", preview ? `${levX(leverageCap(preview))} at the current entry (policy ${levX(policy.max_leverage)})` : `${levX(policy.max_leverage)} (policy)`],
    ["Why leverage can shrink", `${levWhy} Ceiling = entry / (tick ${cents(policy.tick_size)} x ${policy.min_adverse_ticks} adverse ticks).`],
    ["Margin per order", `${usd(policy.min_margin)} to ${usd(policy.max_margin)}`],
    ["Open fee", `${bpsPct(f.open_bps)} of notional`],
    ["Close fee", `${bpsPct(f.close_bps)} of proceeds`],
    ["Holding APR", `${bpsPct(f.hold_apr_bps)} a year on the virtual financing base (notional minus margin). This is not a loan.`],
    ["Risk premium", `${bpsPct(f.floor_coverage_bps)} of the hold-to-resolution value of your zero-loss floor, quoted before you sign`],
    ["Maintenance", `${bpsPct(policy.maintenance_bps)} of position value + ${usd(policy.maintenance_fixed)}. Losing positions below this are liquidated by a keeper.`],
    ["Liquidation reward", `${bpsPct(f.liquidation_reward_bps)} of remaining equity, capped at ${usd(f.liquidation_reward_cap)}`],
    ["Close and stop execution", "Closes, take-profit and stop-loss execute at a keeper-relayed mark observed after your request. No fill price is guaranteed and prices can gap."],
    ["Partial fills", `Allowed down to ${ppmPct(policy.min_fill_floor_ppm)} of size if you opt in. Turn partial fills off for all-or-none.`],
    ["Order lifetime", `Up to ${fmtDurationNs(policy.max_order_lifetime_ns)}; unexecuted orders expire and refund`],
    ["Price freshness", `Marks older than ${fmtDurationNs(policy.max_mark_staleness_ns)} are rejected (PRICE_STALE)`],
    ["Resolution", `${d.resolution_source} (adapter ${d.resolution_adapter_id})`],
    ["Disputes", `${policy.min_resolution_reporters} reporter(s), then a ${fmtDurationNs(policy.dispute_window_ns)} dispute window before settlement`],
    ["Your maximum loss", "Your posted margin. Positions are nonrecourse: you can never owe more."],
    ["Profit cap", "None. A +100% gain does not close the position; it stays open until you close, a trigger you set fires, it is liquidated, or the event settles."],
  ];
  return (
    <div data-testid="rules-sheet">
      {rows.map(([k, v], i) => (
        <div className="configLine" key={i} style={{ alignItems: "flex-start" }}>
          <span className="key" style={{ minWidth: 150 }}>
            {k}
          </span>
          <span style={{ textAlign: "right", fontWeight: 500 }}>{v}</span>
        </div>
      ))}
      {policy.human_readable_rules && <div className="callout">{policy.human_readable_rules}</div>}
      <div className="footnote">Risk model {policy.risk_model_id}, pricing {policy.pricing_adapter_id}, executor {policy.executor_adapter_id}. Hash {shortHash(market.policy_hash)} is what your order signs.</div>
    </div>
  );
}
