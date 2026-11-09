import { useEffect, useState } from "react";
import { api, type EventRow } from "../lib/api";
import { useLive } from "../lib/app";
import { usePoll } from "../lib/hooks";
import { cents, levX, nsToMs, ppmPct, signedUsd, timeAgo, usd, units } from "../lib/format";
import { Empty, ErrorBox, Heading, Loading } from "../components/ui";

const GROUPS: Record<string, string[]> = {
  Trades: ["order_requested", "order_rejected", "risk_reserved", "position_opened", "position_closed", "liquidated", "margin_posted", "triggers_set", "settled"],
  Vault: ["lp_deposit", "lp_deposit_refused", "withdraw_requested", "withdraw_settled", "withdraw_cancelled", "insurance_seed", "transfer_failed"],
  Governance: ["market_proposed", "policy_proposed", "policy_activated", "proposal_rejected", "market_state", "guardian", "restrictions_lifted", "roles_updated", "config_proposed", "config_applied", "adapter_registered", "adapter_revoked", "reporter_registered", "reporter_deactivated", "init"],
  "Oracle & settlement": ["resolution_vote", "resolution_finalized", "resolution_disputed", "resolution_reset", "reconciliation"],
  Hedges: ["hedge_fill", "hedge_committed", "hedge_capital", "hedge_redeemed", "hedge_return", "hedge_write_off"],
};

const MONEY = new Set(["amount", "margin", "payout", "proceeds", "paid", "reward", "fee", "open_fee", "close_fee", "hold_fee", "risk_premium", "to_user", "hedge_budget", "nav_before", "cost", "escrow", "refund"]);
const PRICES = new Set(["entry_price", "exit_price", "price", "mark"]);

export function fmtDetail(data: any): string {
  if (!data || typeof data !== "object") return String(data ?? "");
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => {
      const s = String(v);
      if (/^-?\d+$/.test(s)) {
        if (MONEY.has(k)) return `${k} ${usd(s)}`;
        if (k === "pnl") return `pnl ${signedUsd(s)}`;
        if (PRICES.has(k)) return `${k} ${cents(s)}`;
        if (k === "leverage") return `leverage ${levX(s)}`;
        if (k.endsWith("_ppm")) return `${k.replace(/_ppm$/, "")} ${ppmPct(s, 1)}`;
        if (k === "shares" || k === "units" || k === "supply_before" || k === "remaining_units") return `${k} ${units(s)}`;
      }
      return `${k} ${s.length > 24 ? s.slice(0, 12) + "…" : s}`;
    })
    .join(" · ");
}

const human = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ");

export function ActivityPage() {
  const first = usePoll(() => api.events(0, 200), [], 0);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [group, setGroup] = useState("All");
  useEffect(() => {
    if (first.data) setRows(first.data);
  }, [first.data]);
  useLive((m) => {
    if (m.type !== "event") return;
    setRows((r) => (r.some((x) => x.seq === Number(m.seq)) ? r : [{ seq: Number(m.seq), ts_ns: m.ts_ns, block: 0, kind: m.kind, data: m.data }, ...r].slice(0, 400)));
  });
  const known = new Set(Object.values(GROUPS).flat());
  const shown = rows.filter((e) => group === "All" || (group === "Other" ? !known.has(e.kind) : GROUPS[group]?.includes(e.kind)));
  return (
    <>
      <Heading title="Activity" sub="The contract's onchain audit log (sequenced events), streamed live from the indexer." />
      <div className="surface">
        <div className="subnav">
          {["All", ...Object.keys(GROUPS), "Other"].map((x) => (
            <button key={x} className={group === x ? "active" : ""} onClick={() => setGroup(x)}>
              {x}
            </button>
          ))}
        </div>
        {first.error && !rows.length && <ErrorBox error={first.error} onRetry={first.reload} />}
        {first.loading && !rows.length && <Loading what="Reading the audit log" />}
        {!first.loading && shown.length === 0 && <Empty>No events in this group yet.</Empty>}
        {shown.length > 0 && (
          <div className="scrollX">
            <table className="table" data-testid="activity-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Details</th>
                  <th>Seq / block</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.seq} data-testid={`event-${e.kind}`}>
                    <td>
                      <div className="event">{human(e.kind)}</div>
                      <div className="eventMeta">{e.data?.market_id ?? e.data?.owner ?? e.data?.from ?? ""}</div>
                    </td>
                    <td className="muted" style={{ maxWidth: 520 }}>
                      {fmtDetail(e.data)}
                    </td>
                    <td className="code">
                      #{e.seq}
                      {e.block ? ` · ${e.block}` : ""}
                    </td>
                    <td className="muted">{timeAgo(nsToMs(e.ts_ns))}</td>
                    <td>
                      {e.data?.simulated ? <span className="chip sim">Simulated fill</span> : <span className="chip on">Onchain</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="footnote">Events are append-only in the contract's ring buffer with sequence numbers; this view is the indexer's projection of them.</div>
      </div>
    </>
  );
}
