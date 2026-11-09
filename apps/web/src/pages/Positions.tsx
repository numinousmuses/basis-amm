import { useState } from "react";
import { BasisTxError, PPM, decimalToFixed, nowNs, type Market, type Order, type PositionView } from "@basis/sdk";
import { navigate, useApp } from "../lib/app";
import { outcomeLabel, useAccount, useMarketsMap } from "../lib/account";
import { explainError } from "../lib/errors";
import { minExitWithSlippage, parseOrderResult } from "../lib/intent";
import { big, cents, fmtDate, levX, nsToMs, ppmPct, signedUsd, units, usd } from "../lib/format";
import { Empty, ErrorBox, Heading, Loading, Metric, Modal, SumRow, Toggle, useTx } from "../components/ui";
import { OrderTracker, type TrackedOrder } from "../components/OrderTracker";
import { ClaimButton } from "../components/Claim";

export function PositionsPage() {
  const app = useApp();
  const acct = useAccount(4000);
  const markets = useMarketsMap();
  const [tab, setTab] = useState<"Open" | "History" | "Orders">("Open");
  const [manage, setManage] = useState<string | null>(null);
  if (!app.accountId)
    return (
      <>
        <Heading title="Your positions" sub="Connect an account to see its synthetic positions." />
        <Empty>No account connected. Use the wallet button in the top bar.</Empty>
      </>
    );
  const a = acct.data;
  const open = (a?.positions ?? []).filter((p) => p.position.state === "Open");
  const done = (a?.positions ?? []).filter((p) => p.position.state !== "Open");
  const upnl = open.reduce((s, p) => s + big(p.unrealized_pnl), 0n);
  const margin = open.reduce((s, p) => s + big(p.position.terms.margin), 0n);
  const equity = open.reduce((s, p) => s + big(p.equity_at_bid), 0n);
  const m = (id: string) => markets.data?.get(id);
  const managed = open.find((p) => p.position.position_id === manage) ?? (a?.positions ?? []).find((p) => p.position.position_id === manage);
  return (
    <>
      <Heading
        title="Your positions"
        sub="Open synthetic positions, valued at the executable bid from the latest signed mark."
        right={
          <button className="secondary" onClick={() => navigate("trade")}>
            + New position
          </button>
        }
      />
      <div className="metricRow">
        <Metric label="Position equity at bid" value={usd(equity)} detail={`Across ${open.length} open position${open.length === 1 ? "" : "s"}`} />
        <Metric label="Unrealized P&L" value={<span className={upnl >= 0n ? "green" : "red"}>{signedUsd(upnl)}</span>} detail={margin > 0n ? `${(Number((upnl * 10000n) / margin) / 100).toFixed(2)}% on posted margin, uncapped` : "No open margin"} testId="metric-upnl" />
        <Metric label="Posted margin" value={usd(margin)} detail="Isolated, nonrecourse" />
        <Metric label="Wallet / claimable" value={usd(a?.usdc)} detail={<>Claimable {usd(a?.claimable)} <ClaimButton claimable={a?.claimable} compact /></>} />
      </div>
      <div className="surface">
        <div className="subnav">
          {(["Open", "History", "Orders"] as const).map((x) => (
            <button key={x} className={tab === x ? "active" : ""} onClick={() => setTab(x)} data-testid={`tab-${x}`}>
              {x}
            </button>
          ))}
        </div>
        {acct.error && !a && <ErrorBox error={acct.error} onRetry={acct.reload} />}
        {!a && acct.loading && <Loading what="Reading positions from the contract" />}
        {a && tab === "Open" && (open.length ? <OpenTable rows={open} m={m} onManage={setManage} /> : <Empty>No open positions. Orders appear here only after the contract executes them.</Empty>)}
        {a && tab === "History" && (done.length ? <HistoryTable rows={done} m={m} /> : <Empty>Closed, liquidated and settled positions will appear here.</Empty>)}
        {a && tab === "Orders" && (a.orders.length ? <OrdersTable orders={a.orders} m={m} /> : <Empty>No orders yet. Basis is pool-counterparty: there is no resting order book.</Empty>)}
        <div className="footnote">
          Mark = executable best bid from the latest signed mark (what a close would walk). Unrealized P&L is not capped at +100%. Max payout is event-derived on the remaining exposure. No position here gives you ownership of any hedge shares the vault may hold.
        </div>
      </div>
      {managed && <ManageModal p={managed} market={m(managed.position.market_id)} onClose={() => setManage(null)} />}
    </>
  );
}

function OpenTable({ rows, m, onManage }: { rows: PositionView[]; m: (id: string) => Market | undefined; onManage: (id: string) => void }) {
  return (
    <div className="scrollX">
      <table className="table" data-testid="positions-table">
        <thead>
          <tr>
            <th>Position</th>
            <th>State</th>
            <th>Leverage</th>
            <th>Entry</th>
            <th>Mark (bid)</th>
            <th>Margin</th>
            <th>Unrealized P&L</th>
            <th>Max payout</th>
            <th>Liq. price</th>
            <th>Fees accrued</th>
            <th>TP / SL</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const pos = p.position;
            const mk = m(pos.market_id);
            const u = big(p.unrealized_pnl);
            const fees = big(pos.accrued_hold_fees) + big(p.pending_hold_fees);
            return (
              <tr key={pos.position_id} data-testid={`position-row-${pos.position_id}`} onClick={() => onManage(pos.position_id)}>
                <td>
                  <div className="event">
                    {mk?.descriptor.underlying_event ?? pos.market_id} · {outcomeLabel(mk, pos.outcome_id)}
                  </div>
                  <div className="eventMeta">
                    #{pos.position_id} · {units(pos.terms.units)} units · opened {fmtDate(nsToMs(pos.opened_ns))}
                  </div>
                </td>
                <td>
                  <span className={`chip ${p.liquidatable ? "warn" : "on"}`} data-testid="position-state">
                    {p.liquidatable ? "LIQUIDATION_PENDING" : "OPEN"}
                  </span>
                </td>
                <td>{levX(pos.terms.leverage)}</td>
                <td data-testid="position-entry">{cents(pos.terms.entry_price)}</td>
                <td data-testid="position-mark">{p.mark_bid ? cents(p.mark_bid) : "No mark"}</td>
                <td>{usd(pos.terms.margin)}</td>
                <td className={u >= 0n ? "green" : "red"} data-testid="position-upnl">
                  {p.unrealized_pnl === null ? "n/a" : signedUsd(u)}
                  <div className="eventMeta">{big(pos.terms.margin) > 0n ? `${(Number((u * 10000n) / big(pos.terms.margin)) / 100).toFixed(1)}%` : ""}</div>
                </td>
                <td data-testid="position-max-payout">{usd(p.max_payout)}</td>
                <td>{cents(p.liquidation_price)}</td>
                <td>{usd(fees, 4)}</td>
                <td className="muted">
                  {pos.take_profit_price ? cents(pos.take_profit_price) : "none"} / {pos.stop_loss_price ? cents(pos.stop_loss_price) : "none"}
                </td>
                <td>
                  <button className="mini" onClick={(e) => (e.stopPropagation(), onManage(pos.position_id))} data-testid={`manage-${pos.position_id}`}>
                    Manage
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({ rows, m }: { rows: PositionView[]; m: (id: string) => Market | undefined }) {
  return (
    <div className="scrollX">
      <table className="table" data-testid="history-table">
        <thead>
          <tr>
            <th>Position</th>
            <th>State</th>
            <th>Leverage</th>
            <th>Entry</th>
            <th>Margin</th>
            <th>Paid out</th>
            <th>Realized P&L</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((p) => {
            const pos = p.position;
            const mk = m(pos.market_id);
            const r = big(pos.realized_pnl);
            return (
              <tr key={pos.position_id} data-testid={`history-row-${pos.position_id}`}>
                <td>
                  <div className="event">
                    {mk?.descriptor.underlying_event ?? pos.market_id} · {outcomeLabel(mk, pos.outcome_id)}
                  </div>
                  <div className="eventMeta">#{pos.position_id}</div>
                </td>
                <td>
                  <span className="chip">{pos.state.toUpperCase()}</span>
                </td>
                <td>{levX(pos.terms.leverage)}</td>
                <td>{cents(pos.terms.entry_price)}</td>
                <td>{usd(pos.terms.margin)}</td>
                <td data-testid="history-paid">{usd(pos.paid_out)}</td>
                <td className={r >= 0n ? "green" : "red"}>{signedUsd(r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrdersTable({ orders, m }: { orders: Order[]; m: (id: string) => Market | undefined }) {
  return (
    <div className="scrollX">
      <table className="table" data-testid="orders-table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Kind</th>
            <th>Market</th>
            <th>State</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {[...orders].reverse().map((o) => {
            const isOpen = "Open" in o.kind;
            const market = isOpen ? (o.kind as any).Open.intent.market_id : "";
            const r = parseOrderResult(o);
            const bad = o.state === "Rejected" || o.state === "Expired" || o.state === "Cancelled";
            return (
              <tr key={o.order_id} data-testid={`order-row-${o.order_id}`}>
                <td>#{o.order_id}</td>
                <td>{isOpen ? `Open ${levX((o.kind as any).Open.intent.requested_leverage)}` : `Close ${ppmPct((o.kind as any).Close.fraction_ppm, 0)} of #${(o.kind as any).Close.position_id}`}</td>
                <td className="muted">{isOpen ? (m(market)?.descriptor.underlying_event ?? market) : `position #${(o.kind as any).Close.position_id}`}</td>
                <td>
                  <span className={`chip ${o.state === "Executed" ? "on" : bad ? "bad" : "warn"}`}>{o.state}</span>
                </td>
                <td className="muted" style={{ maxWidth: 360 }}>
                  {bad ? (
                    <>
                      <b>{explainError(o.result ?? o.state).title}</b> <span className="code">{o.result}</span>
                    </>
                  ) : r.kind === "open" ? (
                    `Opened position #${r.positionId}${r.fillPpm !== null ? `, fill ${ppmPct(r.fillPpm, 1)}` : ""}`
                  ) : (
                    (o.result ?? "Waiting for keeper execution")
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ManageModal({ p, market, onClose }: { p: PositionView; market?: Market; onClose: () => void }) {
  const app = useApp();
  const pos = p.position;
  const [fractionPct, setFractionPct] = useState(100);
  const [slip, setSlip] = useState(300);
  const [addStr, setAdd] = useState("10");
  const [tp, setTp] = useState(pos.take_profit_price ? String(Number(pos.take_profit_price) / 10_000) : "");
  const [sl, setSl] = useState(pos.stop_loss_price ? String(Number(pos.stop_loss_price) / 10_000) : "");
  const [useSlip, setUseSlip] = useState(true);
  const [tracked, setTracked] = useState<TrackedOrder | null>(null);
  const tx = useTx();
  const isOpen = pos.state === "Open";
  const bid = big(p.mark_bid);
  const minExit = useSlip ? minExitWithSlippage(bid, slip) : 0n;
  const frac = (BigInt(fractionPct) * PPM) / 100n;
  const remainingUnits = (big(pos.terms.units) * (PPM - frac)) / PPM;

  async function close() {
    if (!app.client) return;
    const t: TrackedOrder = { mode: pos.mode, kind: "close", submittedAt: Date.now() };
    setTracked(t);
    try {
      const r = await app.client.requestClose(pos.position_id, frac, minExit, nowNs() + 300_000_000_000n);
      setTracked({ ...t, orderId: String(r.value), txHash: r.hash });
    } catch (e: any) {
      setTracked({ ...t, requestError: e instanceof BasisTxError ? (e.result.failures[0] ?? e.message) : String(e?.message ?? e) });
    }
  }
  const price = (s: string) => (s.trim() ? decimalToFixed(s, 4) : null);
  return (
    <Modal onClose={onClose} wide>
      <div className="eyebrow">
        Position #{pos.position_id} · {pos.state.toUpperCase()}
      </div>
      <h2 style={{ marginTop: 12 }}>
        {market?.descriptor.underlying_event ?? pos.market_id} · {outcomeLabel(market, pos.outcome_id)}
      </h2>
      <div className="summary">
        <SumRow k="Weighted entry (contract)" v={cents(pos.terms.entry_price)} />
        <SumRow k="Synthetic units / leverage" v={`${units(pos.terms.units)} · ${levX(pos.terms.leverage)}`} />
        <SumRow k="Margin" v={usd(pos.terms.margin)} />
        <SumRow k="Executable mark (bid)" v={p.mark_bid ? cents(p.mark_bid) : "No mark"} />
        <SumRow k="Equity at bid" v={usd(p.equity_at_bid)} />
        <SumRow k="Unrealized P&L (uncapped)" v={signedUsd(p.unrealized_pnl)} cls={big(p.unrealized_pnl) >= 0n ? "green" : "red"} />
        <SumRow k="Max profit / max payout on remaining exposure" v={`+${usd(p.max_profit)} / ${usd(p.max_payout)}`} cls="green" />
        <SumRow k="Liquidation price" v={cents(p.liquidation_price)} />
        <SumRow k="Holding fees accrued" v={usd(big(pos.accrued_hold_fees) + big(p.pending_hold_fees), 4)} />
        <SumRow k="Open fee + risk premium paid" v={`${usd(pos.open_fee_paid)} + ${usd(pos.risk_premium_paid)}`} />
        <SumRow k="Fill fraction" v={ppmPct(pos.fill_fraction_ppm, 1)} />
        <SumRow k="Policy at open" v={`epoch ${pos.policy_epoch} · ${pos.policy_hash.slice(0, 12)}…`} />
        <SumRow k="Strategy" v={pos.mode} />
      </div>
      {isOpen && (
        <>
          <div className="smallTitle">Close</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="fieldLabel">Fraction to close</span>
            <strong data-testid="close-fraction-label">{fractionPct}%</strong>
          </div>
          <input className="range" style={{ margin: "8px 0" }} type="range" min={1} max={100} value={fractionPct} onChange={(e) => setFractionPct(Number(e.target.value))} data-testid="close-fraction" />
          <div className="muted" style={{ fontSize: 11 }}>
            {fractionPct < 100 ? `Partial close keeps ${units(remainingUnits)} units open with the same uncapped upside; no gain ceiling is reinstated.` : "Full close at the next keeper-relayed mark."}
          </div>
          <div className="configLine">
            <span>Minimum exit price {useSlip ? `${cents(minExit)} (bid minus ${slip} bps)` : "none"}</span>
            <span className="inlineField">
              <input className="field" style={{ width: 80 }} type="number" value={slip} onChange={(e) => setSlip(Math.max(0, Number(e.target.value) || 0))} disabled={!useSlip} />
              <Toggle on={useSlip} onChange={setUseSlip} label="Use slippage limit" />
            </span>
          </div>
          <button className="primary" style={{ width: "100%" }} onClick={() => void close()} disabled={!!tracked && !tracked.requestError && !tracked.orderId} data-testid="close-submit">
            Request {fractionPct < 100 ? "partial close" : "close"}
          </button>

          <div className="smallTitle">Add margin</div>
          <div className="inlineField">
            <input className="field" type="number" value={addStr} onChange={(e) => setAdd(e.target.value)} data-testid="add-margin-amount" />
            <button
              className="secondary"
              disabled={!!tx.busy}
              data-testid="add-margin"
              onClick={() => void tx.run("Add margin", () => app.client!.postMargin(pos.position_id, decimalToFixed(addStr || "0", 6)))}
            >
              Add margin
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Extra margin lowers the liquidation price. It is always allowed while the position is open, even in close-only markets.
          </div>

          <div className="smallTitle">Take profit / stop loss (your choice, best effort)</div>
          <div className="fields">
            <input className="field" type="number" step="0.1" placeholder="Take profit ¢" value={tp} onChange={(e) => setTp(e.target.value)} data-testid="tp-input" />
            <input className="field" type="number" step="0.1" placeholder="Stop loss ¢" value={sl} onChange={(e) => setSl(e.target.value)} data-testid="sl-input" />
          </div>
          <button className="secondary" style={{ marginTop: 10 }} disabled={!!tx.busy} onClick={() => void tx.run("Set triggers", () => app.client!.setTriggers(pos.position_id, price(tp), price(sl)))} data-testid="set-triggers">
            Save triggers
          </button>
          {tx.error && <ErrorBox error={tx.error} />}
        </>
      )}
      {tracked && <OrderTracker key={tracked.submittedAt + (tracked.orderId ?? "")} t={tracked} />}
      {!isOpen && (
        <div className="summary">
          <SumRow k="Paid out" v={usd(pos.paid_out)} cls="green" />
          <SumRow k="Realized P&L" v={signedUsd(pos.realized_pnl)} />
        </div>
      )}
      <div className="actionRow" style={{ marginTop: 20 }}>
        <button className="secondary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
