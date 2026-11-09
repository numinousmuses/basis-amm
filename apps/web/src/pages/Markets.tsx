import { useState } from "react";
import { LEV_SCALE } from "@basis/sdk";
import { api, type MarketRow } from "../lib/api";
import { navigate, useLive } from "../lib/app";
import { usePoll } from "../lib/hooks";
import { explainReason } from "../lib/errors";
import { bestAsk, big, cents, fmtDate, levX, markDepthUsd, midOf, minBig, nsToMs, ratioPct, usd } from "../lib/format";
import { isLiveMarket } from "../lib/live";
import { Empty, ErrorBox, Heading, Loading, Metric, StateChip } from "../components/ui";
import { VenueChip } from "../components/Venue";

/** Leverage the market offers right now: min(policy max, protocol ceiling, tick-sensitivity
 * ceiling at the current best ask of the first outcome). */
export function offeredLeverage(row: MarketRow, protocolMax: bigint): bigint | null {
  const p = row.policy;
  if (!p) return null;
  const book = row.mark?.report.outcomes[0];
  const ask = bestAsk(book);
  const caps = [big(p.max_leverage), protocolMax];
  if (ask > 0n) caps.push((ask * LEV_SCALE) / (big(p.tick_size) * BigInt(p.min_adverse_ticks || 1)));
  const v = minBig(...caps);
  return v < LEV_SCALE ? LEV_SCALE : v;
}

export function MarketsPage() {
  const markets = usePoll(() => api.markets(), [], 6000);
  const vault = usePoll(() => api.vault(), [], 10000);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  useLive((m) => m.type === "event" && ["market_state", "guardian", "policy_activated", "resolution_finalized"].includes(m.kind) && void markets.reload());

  const rows = markets.data ?? [];
  const cats = ["All", ...Array.from(new Set(rows.map((r) => r.market.descriptor.category_label)))];
  const shown = rows.filter((r) => (cat === "All" || r.market.descriptor.category_label === cat) && r.market.descriptor.underlying_event.toLowerCase().includes(q.toLowerCase()));
  const protocolMax = big(vault.data?.config.max_leverage_ceiling ?? "100000");
  const openMargin = rows.reduce((a, r) => a + big(r.risk.open_margin), 0n);
  const openPositions = rows.reduce((a, r) => a + r.risk.open_positions, 0);
  const s = vault.data?.summary;
  const liveN = rows.filter((r) => isLiveMarket(r.market.descriptor)).length;
  return (
    <>
      <Heading
        title="Discover markets"
        sub="Every market the contract has admitted, with the executable price from the latest signed mark."
        right={
          <button className="secondary" onClick={() => navigate("stats")}>
            Explore protocol ↗
          </button>
        }
      />
      <div className="metricRow">
        <Metric label="Admitted markets" value={rows.length || "0"} detail={`Across ${Math.max(0, cats.length - 1)} labels from market descriptors`} testId="metric-markets" />
        <Metric label="Open positions" value={openPositions} detail="Synthetic, vault is counterparty" />
        <Metric label="Open margin" value={usd(openMargin)} detail="Isolated trader collateral" />
        <Metric label="Payout reserve" value={s ? `${ratioPct(s.payout_reserve, s.total_assets).toFixed(1)}%` : "n/a"} detail={s ? `${usd(s.payout_reserve)} of ${usd(s.total_assets)} vault assets` : "Loading vault"} />
      </div>
      <div className="surface">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, marginBottom: 15 }}>
          <div className="surfaceTitle" style={{ margin: 0 }}>
            Prediction markets
          </div>
          <input className="search" style={{ maxWidth: 260 }} placeholder="Search an event or market…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="market-search" />
        </div>
        <div className="subnav">
          {cats.map((c) => (
            <button key={c} className={cat === c ? "active" : ""} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        {markets.error && !markets.data && <ErrorBox error={markets.error} onRetry={markets.reload} />}
        {markets.loading && !markets.data && <Loading what="Reading markets from the contract" />}
        {markets.data && shown.length === 0 && <Empty>{rows.length ? "No market matches this filter." : "No markets have been admitted on this deployment yet."}</Empty>}
        {shown.length > 0 && (
          <div className="scrollX">
            <table className="table" data-testid="markets-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Executable mid</th>
                  <th>Depth</th>
                  <th>Offered leverage</th>
                  <th>Access</th>
                  <th>Restriction</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const d = r.market.descriptor;
                  const lev = offeredLeverage(r, protocolMax);
                  const closeOnly = r.actions.reasons.some((x) => x.includes("CLOSE_ONLY"));
                  return (
                    <tr key={d.market_id} onClick={() => navigate("trade", d.market_id)} data-testid={`market-row-${d.market_id}`}>
                      <td>
                        <div className="event">{d.underlying_event}</div>
                        <div className="eventMeta">
                          {d.category_label} · {d.venue} · resolves {fmtDate(nsToMs(d.expected_resolution_ns))}
                        </div>
                        <VenueChip d={d} mark={r.mark} policy={r.policy} compact />
                      </td>
                      <td>
                        {d.outcomes.map((o) => (
                          <div key={o.outcome_id} className="number" style={{ whiteSpace: "nowrap" }}>
                            <span className="muted" style={{ fontSize: 10, marginRight: 6 }}>
                              {o.label}
                            </span>
                            {cents(midOf(r.mark, o.outcome_id))}
                          </div>
                        ))}
                      </td>
                      <td>{r.mark ? usd(markDepthUsd(r.mark), 0) : "No mark"}</td>
                      <td>{lev ? levX(lev) : "n/a"}</td>
                      <td>
                        <StateChip state={r.market.state} open={r.actions.open} closeOnly={closeOnly} />
                      </td>
                      <td className="muted" style={{ maxWidth: 260 }}>
                        {r.actions.reasons.length ? explainReason(r.actions.reasons[0]) : "Standard trading under the approved policy"}
                      </td>
                      <td>↗</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="footnote">
          {liveN > 0 ? `${liveN} market${liveN === 1 ? "" : "s"} price from the live Polymarket CLOB (labeled Live Polymarket); the rest use the labeled mock venue (simulated). ` : "Prices on this deployment come from the labeled mock venue (simulated). "}Eligibility, leverage and restrictions are per-market, versioned policies read from the contract.
        </div>
      </div>
    </>
  );
}
