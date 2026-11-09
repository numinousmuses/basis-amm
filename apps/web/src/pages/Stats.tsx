import { useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { usePoll } from "../lib/hooks";
import { big, ratioPct, signedUsd, usd } from "../lib/format";
import { Bar, ErrorBox, Heading, LineChart, Line, Loading, Metric } from "../components/ui";

const PERIODS: Array<[string, number]> = [
  ["1H", 3600_000],
  ["1D", 86400_000],
  ["7D", 7 * 86400_000],
];

export function StatsPage() {
  const app = useApp();
  const vault = usePoll(() => api.vault(), [], 8000);
  const markets = usePoll(() => api.markets(), [], 15000);
  const tokenBal = usePoll(() => app.anon.balanceOf(app.stack.contractId), [], 8000);
  const [period, setPeriod] = useState(PERIODS[1]);
  const [metric, setMetric] = useState<"nav" | "share_price">("nav");
  const hist = usePoll(() => api.vaultHistory(Date.now() - period[1]), [period[1]], 30000);
  const v = vault.data;
  if (vault.error && !v) return <ErrorBox error={vault.error} onRetry={vault.reload} />;
  if (!v) return <Loading what="Reading protocol state" />;
  const s = v.summary;
  const c = v.conservation;
  const tvl = big(s.total_assets) + big(s.insurance_balance);
  const series = (hist.data ?? []).map((r) => ({ x: r.ts_ms, y: metric === "nav" ? Number(r.nav) / 1e6 : Number(r.share_price) / 1e6 }));
  const byCat = new Map<string, bigint>();
  for (const r of markets.data ?? []) byCat.set(r.market.descriptor.category_label, (byCat.get(r.market.descriptor.category_label) ?? 0n) + big(r.risk.open_margin));
  const totalOi = [...byCat.values()].reduce((a, b) => a + b, 0n);
  const balanced = tokenBal.data !== undefined && big(tokenBal.data) === big(c.tracked_on_contract) && big(c.in_flight) === 0n;
  const exportSnapshot = () => {
    const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), network: app.stack.network, contract: app.stack.contractId, vault: v, token_balance: tokenBal.data, markets: markets.data?.map((m) => ({ id: m.market.descriptor.market_id, state: m.market.state, risk: m.risk })) }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `basis-snapshot-${Date.now()}.json`;
    a.click();
  };
  return (
    <>
      <Heading
        title="Protocol statistics"
        sub="Public exposure, fees and solvency, read from contract views and verified against the token balance."
        right={
          <button className="secondary" onClick={exportSnapshot}>
            Export snapshot ↗
          </button>
        }
      />
      <div className="metricRow">
        <Metric label="Total value locked" value={usd(tvl, 0)} detail="Vault assets and insurance" />
        <Metric label="Fees assessed" value={usd(s.fees_assessed)} detail="Open, close, holding and risk premium" />
        <Metric label="Open margin" value={usd(s.open_margin)} detail="Across admitted markets" />
        <Metric label="LP share price" value={usd(s.share_price, 4)} detail="bLP / test USDC" />
      </div>
      <div className="colsWide">
        <div className="surface">
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div className="surfaceTitle">{metric === "nav" ? "Vault NAV" : "bLP share price"} history</div>
            <div className="subnav" style={{ margin: 0 }}>
              <button className={metric === "nav" ? "active" : ""} onClick={() => setMetric("nav")}>
                NAV
              </button>
              <button className={metric === "share_price" ? "active" : ""} onClick={() => setMetric("share_price")}>
                Share price
              </button>
            </div>
          </div>
          <LineChart series={series} color="#3b806e" yFormat={(y) => (metric === "nav" ? `$${Math.round(y).toLocaleString()}` : `$${y.toFixed(4)}`)} />
          <div className="subnav" style={{ marginBottom: 0 }}>
            {PERIODS.map((p) => (
              <button key={p[0]} className={period[0] === p[0] ? "active" : ""} onClick={() => setPeriod(p)}>
                {p[0]}
              </button>
            ))}
          </div>
        </div>
        <div className="surface">
          <div className="surfaceTitle">Solvency overview</div>
          <Line k="Vault assets" v={usd(s.total_assets)} />
          <Line k="Current synthetic user claims" v={usd(s.user_claim_liability)} />
          <Line k="Worst-case payout reserve" v={usd(s.payout_reserve)} />
          <Line k="Scenario stress loss" v={usd(s.stress_loss)} />
          <Line k="Insurance fund" v={usd(s.insurance_balance)} />
          <Line k="Free liquidity" v={usd(s.free_liquidity)} />
          <Line k="LP impairment / insurance-paid losses" v={`${usd(s.lp_impairment)} / ${usd(s.insurance_paid_losses)}`} />
          <div className="callout">The payout reserve is a scenario-based capital encumbrance, not a realized loss. The pool is not risk-free and is not delta-neutral.</div>
        </div>
      </div>
      <div className="colsWide" style={{ marginTop: 20 }}>
        <div className="surface">
          <div className="surfaceTitle">Open margin by category label</div>
          {[...byCat.entries()].map(([k, x]) => (
            <div key={k}>
              <div className="configLine">
                <span>{k}</span>
                <b>{usd(x)}</b>
              </div>
              <Bar pct={ratioPct(x, totalOi)} />
            </div>
          ))}
          <div className="smallTitle">Conservation check</div>
          <div data-testid="conservation">
            <Line k="Token balance of the contract" v={tokenBal.data !== undefined ? usd(tokenBal.data) : "reading…"} />
            <Line k="Tracked on contract" v={usd(c.tracked_on_contract)} />
            <Line k="Cash + escrow + claimable + insurance + treasury + custody" v={usd(big(c.cash) + big(c.order_escrow) + big(c.claimable_total) + big(c.insurance) + big(c.treasury) + big(c.hedge_custody_cash))} />
            <Line k="In flight" v={usd(c.in_flight)} />
            <div className="configLine">
              <span className="key">Status</span>
              <span className={`chip ${balanced ? "on" : "warn"}`} data-testid="conservation-status">
                {balanced ? "Balanced: every micro-unit accounted for" : big(c.in_flight) > 0n ? "Transfers in flight" : "Mismatch: investigate"}
              </span>
            </div>
          </div>
        </div>
        <div className="surface">
          <div className="surfaceTitle">Protocol earnings and P&L</div>
          <Line k="Fees assessed" v={usd(s.fees_assessed)} />
          <Line k="To LP NAV" v={usd(s.fees_to_lp)} />
          <Line k="To insurance" v={usd(s.fees_to_insurance)} />
          <Line k="To treasury" v={usd(s.fees_to_treasury)} />
          <Line k="Realized trader P&L (vault pays when positive)" v={signedUsd(s.realized_trader_pnl)} testId="realized-trader-pnl" />
          <Line k="Realized hedge P&L" v={signedUsd(s.hedge_realized_pnl)} />
          <div className="footnote">Fees do not imply guaranteed yield or protection from adverse trader results.</div>
        </div>
      </div>
    </>
  );
}
