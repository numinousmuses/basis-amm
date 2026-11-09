import { useState } from "react";
import type { HedgeFillReceipt } from "@basis/sdk";
import { api, type ExecFill, type MarketRow, type PolymarketStatus } from "../lib/api";
import { navigate, useApp, useLive } from "../lib/app";
import { usePoll } from "../lib/hooks";
import { big, cents, fmtDate, nsToMs, shortHash, units, usd } from "../lib/format";
import { isLiveMarket, truthy, txLink, venueLabel } from "../lib/live";
import { Bar, Empty, ErrorBox, Heading, Line, Loading, Metric } from "../components/ui";
import { TxRef, VenueChip } from "../components/Venue";

const STRATEGY_SHORT: Record<string, string> = { HedgeRequired: "HEDGE_REQUIRED", PoolPlusHedge: "POOL_PLUS_HEDGE", PoolOnly: "POOL_ONLY" };

/** Hedge executor: which venue the vault hedges on, what it holds there versus what the contract
 * records, and every fill. Everything simulated is labeled as such. */
export function HedgingPage() {
  const app = useApp();
  const status = usePoll(() => api.polymarketStatus(), [], 5000);
  const fills = usePoll(() => api.fills(), [], 4000);
  const markets = usePoll(() => api.markets(), [], 6000);
  const recon = usePoll(() => api.reconciliation(), [], 8000);
  useLive((m) => {
    if (m.type === "event" && ["hedge_fill", "hedge_committed", "hedge_capital", "hedge_return", "hedge_redeemed", "position_opened", "position_closed"].includes(m.kind)) {
      void fills.reload();
      void markets.reload();
    }
  });
  const s = status.data;
  const rows = markets.data ?? [];
  const byId = new Map(rows.map((r) => [r.market.descriptor.market_id, r]));
  const hedged = rows.filter((r) => (r.policy && r.policy.strategy !== "PoolOnly") || r.risk.hedge_units.some((u) => big(u) !== 0n) || (s?.custody[r.market.descriptor.market_id] ?? []).some((u) => big(u) !== 0n));
  const ledger = [...(fills.data ?? [])].sort((a, b) => b.ts_ms - a.ts_ms);
  const liveCount = rows.filter((r) => isLiveMarket(r.market.descriptor)).length;
  const label = venueLabel(s?.venue, s?.simulated);
  const realFills = ledger.filter((f) => txLink(f.tx, f.simulated).kind === "polygon").length;
  const reconBad = Object.values(recon.data ?? {}).filter((x) => !x.ok).length;
  return (
    <>
      <Heading
        title="Hedge executor"
        sub="Where the vault buys and sells its own hedge shares, what it holds there, and whether that matches the contract's hedge inventory."
        right={
          <button className="secondary" onClick={() => navigate("risk")}>
            Risk monitor ↗
          </button>
        }
      />
      {status.error && !s && <ErrorBox error={status.error} onRetry={status.reload} />}
      {s && (
        <div className={`modeBanner ${label.chip}`} data-testid="venue-mode" data-mode={label.mode}>
          <div>
            <div className="eyebrow" style={{ color: "inherit", opacity: 0.7 }}>
              Live Polymarket markets hedge on <span className="code" style={{ color: "inherit" }}>{s.venue ?? "none"}</span>
            </div>
            <div className="modeTitle" style={{ marginTop: 8 }}>
              {label.title}
            </div>
            <div className="modeDetail">
              {label.detail} Mock fixture markets (<span className="code">mock-venue:*</span>) always hedge on the mock venue, whatever this mode is.
            </div>
          </div>
          <div className="modeTag" data-testid="venue-mode-tag">
            {label.mode}
          </div>
        </div>
      )}
      <div className="metricRow">
        <Metric label="Executor EVM address" value={<span style={{ fontSize: 15 }} className="code" data-testid="executor-address">{s ? (s.executor_address ? shortHash(s.executor_address, 8) : "None") : "…"}</span>} detail={s?.executor_address ? <span className="code wrapCode">{s.executor_address}</span> : "No Polygon key: paper and mock venues place no orders"} />
        <Metric
          label="Spend today vs daily cap"
          value={s?.caps ? `$${s.spent_today_usd.toFixed(2)} / $${s.caps.max_daily_usd}` : s ? `$${s.spent_today_usd.toFixed(2)}` : "…"}
          detail={s?.caps ? <><Bar pct={s.caps.max_daily_usd ? (s.spent_today_usd / s.caps.max_daily_usd) * 100 : 0} color="#a2443e" />Max ${s.caps.max_order_usd} per order</> : "Caps apply only in LIVE mode; nothing is spent in PAPER or MOCK"}
          testId="spend-today"
        />
        <Metric label="Executor fills" value={ledger.length} detail={`${ledger.filter((f) => f.side === "buy").length} buys · ${ledger.filter((f) => f.side !== "buy").length} sells/redeems · ${realFills} real Polygon tx`} testId="fill-count" />
        <Metric label="Hedged markets" value={hedged.length} detail={<span className={reconBad ? "red" : "green"}>{reconBad ? `${reconBad} reconciliation failures` : "Reconciliation matches custody"} · {liveCount} live</span>} />
      </div>

      <div className="surface">
        <div className="surfaceTitle">Custody vs onchain hedge inventory</div>
        {markets.error && !markets.data && <ErrorBox error={markets.error} onRetry={markets.reload} />}
        {!markets.data && !markets.error && <Loading what="Reading hedge inventory" />}
        {markets.data && hedged.length === 0 && <Empty>No market hedges on this deployment.</Empty>}
        {hedged.length > 0 && (
          <div className="scrollX">
            <table className="table" data-testid="custody-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Strategy</th>
                  <th>Outcome</th>
                  <th>Contract hedge_units (shares)</th>
                  <th>Venue custody (shares)</th>
                  <th>Contract hedge cost</th>
                  <th>Reconciliation</th>
                </tr>
              </thead>
              <tbody>
                {hedged.map((r) => {
                  const d = r.market.descriptor;
                  const cust = s?.custody[d.market_id] ?? [];
                  const rc = recon.data?.[d.market_id];
                  return d.outcomes.map((o, i) => {
                    const on = big(r.risk.hedge_units[i]);
                    const cu = big(cust[i]);
                    return (
                      <tr key={`${d.market_id}-${i}`} onClick={() => navigate("trade", d.market_id)} data-testid={i === 0 ? `custody-row-${d.market_id}` : undefined}>
                        {i === 0 && (
                          <td rowSpan={d.outcomes.length} style={{ verticalAlign: "top" }}>
                            <div className="event">{d.underlying_event}</div>
                            <div className="eventMeta">{d.market_id}</div>
                            <VenueChip d={d} mark={r.mark} policy={r.policy} compact />
                          </td>
                        )}
                        {i === 0 && (
                          <td rowSpan={d.outcomes.length} className="code" style={{ verticalAlign: "top" }}>
                            {r.policy ? STRATEGY_SHORT[r.policy.strategy] : "n/a"}
                          </td>
                        )}
                        <td className="muted">{o.label}</td>
                        <td className="number">{units(on)}</td>
                        <td className={`number ${on === cu ? "" : "red"}`}>{units(cu)}</td>
                        <td>{usd(r.risk.hedge_cost[i] ?? "0")}</td>
                        {i === 0 && (
                          <td rowSpan={d.outcomes.length} style={{ verticalAlign: "top", maxWidth: 240 }}>
                            {rc ? <span className={`chip ${rc.ok ? "on" : "bad"}`}>{rc.ok ? "Matches custody" : "POLYGON_RECONCILIATION_FAILED"}</span> : <span className="chip">Not checked yet</span>}
                            {rc?.detail && <div className="eventMeta">{rc.detail}</div>}
                            {rc?.at ? <div className="eventMeta">{fmtDate(Date.parse(String(rc.at)))}</div> : null}
                          </td>
                        )}
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="footnote">Contract inventory comes from get_risk_summary(market).hedge_units. Venue custody is what basis-node's executor ledger says it holds on the venue. The reconciler compares the two; a mismatch blocks new opens on that market.</div>
      </div>

      <div className="surface" style={{ marginTop: 20 }}>
        <div className="surfaceTitle">Executor fills (basis-node ledger)</div>
        {fills.error && !fills.data && <ErrorBox error={fills.error} onRetry={fills.reload} />}
        {fills.data && ledger.length === 0 && <Empty>No hedge fills yet. Open a position on a HEDGE_REQUIRED market to see one.</Empty>}
        {ledger.length > 0 && <FillsTable rows={ledger.slice(0, 60)} byId={byId} />}
        <div className="footnote">Units are outcome shares. Only a real 0x Polygon transaction hash links to Polygonscan; paper and mock receipts are labeled and never presented as real trades.</div>
      </div>

      <ContractFills rows={hedged} />

      <div className="split" style={{ marginTop: 20 }}>
        <SignerAudit s={s} />
        <div className="surface">
          <div className="surfaceTitle">How hedging works here</div>
          <Line k="HEDGE_REQUIRED" v="Vault buys its shares before your position opens" />
          <Line k="POOL_PLUS_HEDGE" v="Position opens at once; vault may rebalance separately" />
          <Line k="POOL_ONLY" v="No hedge; the vault is the only counterparty" />
          <Line k="On close" v="Executor sells the shares that backed the position" />
          <Line k="After settlement" v="Remaining shares are redeemed at the resolved payout" />
          <div className="callout">Traders never own the vault's hedge shares. The hedge reduces the vault's loss in the scenarios it covers; it does not make LP capital risk-free.</div>
          {app.stack.network !== "sandbox" && <div className="footnote">Network {app.stack.network}.</div>}
        </div>
      </div>
    </>
  );
}

function FillsTable({ rows, byId }: { rows: ExecFill[]; byId: Map<string, MarketRow> }) {
  return (
    <div className="scrollX">
      <table className="table" data-testid="fills-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>Side</th>
            <th>Shares</th>
            <th>Price</th>
            <th>Order</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const r = byId.get(f.market);
            const d = r?.market.descriptor;
            const redeem = f.fill_id.startsWith("redeem:");
            return (
              <tr key={f.fill_id} data-testid={`fill-row-${redeem ? "redeem" : f.side}-${f.order_id ?? f.fill_id}`} data-side={f.side} onClick={() => d && navigate("trade", d.market_id)}>
                <td className="muted">{fmtDate(f.ts_ms)}</td>
                <td>
                  <div className="event">{d?.underlying_event ?? f.market}</div>
                  <div className="eventMeta">
                    {d?.outcomes[f.outcome]?.label ?? `outcome ${f.outcome}`} · {f.market}
                  </div>
                </td>
                <td>
                  <span className={`chip ${f.side === "buy" ? "on" : "warn"}`}>{redeem ? "REDEEM" : String(f.side).toUpperCase()}</span>
                </td>
                <td className="number">{units(f.units)}</td>
                <td className="number">{redeem ? `${cents(f.price)} payout` : cents(f.price)}</td>
                <td className="code">{f.order_id ? `#${f.order_id}` : "none"}</td>
                <td>
                  <TxRef hash={f.tx} simulated={truthy(f.simulated)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ContractFills({ rows }: { rows: MarketRow[] }) {
  const app = useApp();
  const ids = rows.map((r) => r.market.descriptor.market_id);
  const [pick, setPick] = useState<string>("");
  const id = pick || ids[0] || "";
  const fills = usePoll<HedgeFillReceipt[]>(() => (id ? app.anon.getHedgeFills(id) : Promise.resolve([])), [id], 6000);
  const row = rows.find((r) => r.market.descriptor.market_id === id);
  const list = [...(fills.data ?? [])].sort((a, b) => (big(b.executed_ns) > big(a.executed_ns) ? 1 : -1));
  return (
    <div className="surface" style={{ marginTop: 20 }} data-testid="contract-fills">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, marginBottom: 15 }}>
        <div className="surfaceTitle" style={{ margin: 0 }}>
          Hedge fill receipts recorded by the contract
        </div>
        <select className="field select" style={{ maxWidth: 320 }} value={id} onChange={(e) => setPick(e.target.value)} data-testid="contract-fills-market">
          {rows.map((r) => (
            <option key={r.market.descriptor.market_id} value={r.market.descriptor.market_id}>
              {r.market.descriptor.underlying_event.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      {fills.error && <ErrorBox error={fills.error} />}
      {!id && <Empty>No hedged markets.</Empty>}
      {id && fills.data && list.length === 0 && <Empty>The contract has no hedge receipts for this market.</Empty>}
      {list.length > 0 && (
        <div className="scrollX">
          <table className="table" data-testid="contract-fills-table">
            <thead>
              <tr>
                <th>Executed</th>
                <th>Receipt</th>
                <th>Outcome</th>
                <th>Side</th>
                <th>Shares</th>
                <th>Price</th>
                <th>Fee</th>
                <th>Order</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 40).map((f) => (
                <tr key={f.fill_id} data-testid={`receipt-${f.fill_id}`}>
                  <td className="muted">{fmtDate(nsToMs(f.executed_ns))}</td>
                  <td className="code">{shortHash(f.fill_id, 14)}</td>
                  <td className="muted">{row?.market.descriptor.outcomes[f.outcome_id]?.label ?? f.outcome_id}</td>
                  <td>
                    <span className={`chip ${f.side_buy ? "on" : "warn"}`}>{f.side_buy ? "BUY" : "SELL"}</span>
                  </td>
                  <td className="number">{units(f.units)}</td>
                  <td className="number">{cents(f.price)}</td>
                  <td>{usd(f.fee, 4)}</td>
                  <td className="code">{f.order_id ? `#${f.order_id}` : "none"}</td>
                  <td>
                    <TxRef hash={f.tx_hash} simulated={f.simulated} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="footnote">From the contract's get_hedge_fills(market). The contract checks each receipt's market, token ref, chain, amounts and the order's signed bounds before it counts toward hedge inventory.</div>
    </div>
  );
}

function SignerAudit({ s }: { s: PolymarketStatus | undefined }) {
  const audit = [...(s?.signer_audit ?? [])].reverse();
  return (
    <div className="surface" data-testid="signer-audit">
      <div className="surfaceTitle">Signer audit</div>
      {!s && <Loading />}
      {s && audit.length === 0 && <Empty>No signatures requested. {s.simulated ? "Paper and mock venues sign nothing." : "No live order has been signed yet."}</Empty>}
      {audit.map((a, i) => (
        <div className="configLine" key={i}>
          <div>
            <b className="code">{a.primaryType ?? "unknown"}</b>
            <div className="muted" style={{ fontSize: 11 }}>
              {fmtDate(Date.parse(a.at))}
              {a.error ? ` · ${a.error}` : ""}
            </div>
          </div>
          <span className={`chip ${a.ok ? "on" : "bad"}`}>{a.ok ? "Signed" : "Refused"}</span>
        </div>
      ))}
      <div className="footnote">Last 20 EIP-712 signing requests from the executor's signer (TEE or local key), newest first.</div>
    </div>
  );
}

