import { api } from "../lib/api";
import { navigate, useLive } from "../lib/app";
import { usePoll, useNow } from "../lib/hooks";
import { big, fmtSeconds, isSimulatedSource, nsToMs, ratioPct, signedUsd, usd } from "../lib/format";
import { Bar, Empty, ErrorBox, Heading, Loading, Metric } from "../components/ui";
import { TeePanel } from "../components/Tee";
import { VenueChip } from "../components/Venue";
import { venueLabel } from "../lib/live";

export function RiskPage() {
  const markets = usePoll(() => api.markets(), [], 5000);
  const vault = usePoll(() => api.vault(), [], 8000);
  const recon = usePoll(() => api.reconciliation(), [], 10000);
  const pm = usePoll(() => api.polymarketStatus(), [], 15000);
  const now = useNow(1000);
  useLive((m) => m.type === "event" && ["position_opened", "position_closed", "liquidated", "settled"].includes(m.kind) && void markets.reload());
  const rows = markets.data ?? [];
  const v = vault.data;
  if (markets.error && !markets.data) return <ErrorBox error={markets.error} onRetry={markets.reload} />;
  if (!markets.data || !v) return <Loading what="Reading risk state" />;
  const s = v.summary;
  const nav = big(s.nav) > 0n ? big(s.nav) : 0n;
  const globalCap = (nav * BigInt(v.config.global_stress_cap_bps)) / 10_000n;
  const freeStress = globalCap > big(s.stress_loss) ? globalCap - big(s.stress_loss) : 0n;
  const worst = rows.reduce((a, r) => Math.max(a, ratioPct(r.risk.stress_loss, r.risk.event_stress_cap)), 0);
  const fresh = (r: (typeof rows)[number]) => {
    if (!r.mark || !r.policy) return { ok: false, age: null as number | null };
    const age = now - nsToMs(r.mark.report.source_timestamp_ns);
    return { ok: age <= nsToMs(r.policy.max_mark_staleness_ns), age };
  };
  const live = rows.filter((r) => ["Active", "CloseOnly"].includes(r.market.state));
  const staleCount = live.filter((r) => !fresh(r).ok).length;
  const reconBad = Object.values(recon.data ?? {}).filter((x) => !x.ok).length;
  return (
    <>
      <Heading eyebrow="Basis / Operations" title="Risk monitor" sub="Scenario P&L per market, payout reserves, stress budgets, reconciliation and oracle freshness." />
      <div className="metricRow">
        <Metric label="Free stress capacity" value={usd(freeStress, 0)} detail={`Global cap ${usd(globalCap, 0)} (${(v.config.global_stress_cap_bps / 100).toFixed(1)}% NAV)`} />
        <Metric label="Payout reserve" value={usd(s.payout_reserve, 0)} detail="Worst-case LP loss, no hedge credit" />
        <Metric label="Highest event stress" value={`${worst.toFixed(1)}%`} detail="Of that market's event cap" />
        <Metric label="Oracle / reconciliation issues" value={staleCount + reconBad} detail={<span className={staleCount + reconBad ? "red" : "green"}>{staleCount} stale marks · {reconBad} reconciliation failures</span>} testId="risk-issues" />
      </div>
      <div className="surface">
        <div className="surfaceTitle">Market risk ledger (contract get_risk_summary)</div>
        <div className="scrollX">
          <table className="table" data-testid="risk-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Scenario</th>
                <th>Trader P&L</th>
                <th>Hedge P&L</th>
                <th>LP loss</th>
                <th>Payout reserve</th>
                <th>Stress loss / event cap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = r.market.descriptor;
                const sc = d.scenarios;
                return sc.map((scn, i) => {
                  const t = big(r.risk.trader_pnl_by_scenario[i]);
                  const h = big(r.risk.hedge_pnl_by_scenario[i]);
                  const lp = t - h > 0n ? t - h : 0n;
                  return (
                    <tr key={`${d.market_id}-${i}`} onClick={() => navigate("trade", d.market_id)} data-testid={i === 0 ? `risk-row-${d.market_id}` : undefined}>
                      {i === 0 && (
                        <td rowSpan={sc.length} style={{ verticalAlign: "top" }}>
                          <div className="event">{d.underlying_event}</div>
                          <div className="eventMeta">
                            {d.category_label} · {r.market.state} · {r.risk.open_positions} open · margin {usd(r.risk.open_margin, 0)}
                          </div>
                          <VenueChip d={d} mark={r.mark} policy={r.policy} compact />
                        </td>
                      )}
                      <td className="muted">{scn.label}</td>
                      <td className={t > 0n ? "red" : "green"}>{signedUsd(t)}</td>
                      <td>{signedUsd(h)}</td>
                      <td>{usd(lp)}</td>
                      {i === 0 && (
                        <>
                          <td rowSpan={sc.length} style={{ verticalAlign: "top" }}>
                            {usd(r.risk.payout_reserve)}
                          </td>
                          <td rowSpan={sc.length} style={{ verticalAlign: "top", minWidth: 150 }}>
                            <div>
                              {usd(r.risk.stress_loss, 0)} / {usd(r.risk.event_stress_cap, 0)}
                            </div>
                            <Bar pct={ratioPct(r.risk.stress_loss, r.risk.event_stress_cap)} />
                          </td>
                        </>
                      )}
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
        <div className="footnote">Trader P&L per terminal scenario uses unclipped positive equity (no profit cap). LP loss = max(0, trader P&L minus hedge P&L). Positive trader P&L is a vault liability.</div>
      </div>
      <div className="colsWide" style={{ marginTop: 20 }}>
        <div className="surface">
          <div className="surfaceTitle">Oracle freshness</div>
          {live.length === 0 && <Empty>No trading markets.</Empty>}
          {live.map((r) => {
            const f = fresh(r);
            return (
              <div className="configLine" key={r.market.descriptor.market_id} data-testid={`fresh-${r.market.descriptor.market_id}`}>
                <div>
                  <div className="event">{r.market.descriptor.underlying_event}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {r.mark ? `${r.mark.report.source_chain} · ${r.mark.report.attestation_ref}` : "No mark"} · limit {r.policy ? fmtSeconds(nsToMs(r.policy.max_mark_staleness_ns) / 1000) : "n/a"}
                  </div>
                </div>
                <span style={{ whiteSpace: "nowrap" }}>
                  {isSimulatedSource(r.mark?.report.source_chain) && <span className="chip sim" style={{ marginRight: 6 }}>Simulated</span>}
                  <span className={`chip ${f.ok ? "on" : "warn"}`}>{f.age === null ? "No mark" : `${f.ok ? "Fresh" : "PRICE_STALE"} · ${fmtSeconds(Math.round(f.age / 1000))}`}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="surface">
          <div className="surfaceTitle">Hedge reconciliation</div>
          {recon.error && <ErrorBox error={recon.error} />}
          {Object.entries(recon.data ?? {}).map(([id, x]) => (
            <div className="configLine" key={id}>
              <div>
                <div className="code">{id}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {x.detail} {x.at ? `· ${String(x.at)}` : ""}
                </div>
              </div>
              <span className={`chip ${x.ok ? "on" : "bad"}`}>{x.ok ? "Matches custody" : "POLYGON_RECONCILIATION_FAILED"}</span>
            </div>
          ))}
          {recon.data && Object.keys(recon.data).length === 0 && <Empty>No reconciliation reports yet.</Empty>}
          <div className="callout">
            Reconciliation compares the vault's recorded hedge inventory with the executor custody report. Fixture markets hedge on the mock venue; live Polymarket markets hedge in {pm.data ? venueLabel(pm.data.venue, pm.data.simulated).mode : "the configured"} mode.{" "}
            <button className="link" onClick={() => navigate("hedging")}>
              Hedge executor ↗
            </button>
          </div>
        </div>
      </div>
      <TeePanel />
    </>
  );
}
