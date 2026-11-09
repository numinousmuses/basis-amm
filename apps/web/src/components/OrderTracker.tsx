import { useEffect, useState } from "react";
import type { Order, PositionView, StrategyMode } from "@basis/sdk";
import { useApp, navigate } from "../lib/app";
import { orderTimeline, parseOrderResult } from "../lib/intent";
import { explainError } from "../lib/errors";
import { cents, levX, ppmPct, shortHash, usd, units } from "../lib/format";
import { ErrorBox } from "./ui";

export interface TrackedOrder {
  /** Set once the request transaction lands. */
  orderId?: string;
  txHash?: string;
  /** Request-stage failure (the ft_transfer_call itself was refused and refunded). */
  requestError?: string;
  mode: StrategyMode;
  kind: "open" | "close";
  submittedAt: number;
}

const TERMINAL = ["Executed", "Rejected", "Expired", "Cancelled"];

/** Live order status: polls the contract's order record until it is terminal. Never shows a
 * position as OPEN until `get_position` returns it with state Open. */
export function OrderTracker({ t, onDone }: { t: TrackedOrder; onDone?: (o: Order, p: PositionView | null) => void }) {
  const { anon, bump } = useApp();
  const [order, setOrder] = useState<Order | null>(null);
  const [pos, setPos] = useState<PositionView | null>(null);
  const [log, setLog] = useState<Array<{ state: string; at: number }>>([]);

  useEffect(() => {
    if (!t.orderId) return;
    let stop = false;
    let last = "";
    const tick = async () => {
      try {
        const o = await anon.getOrder(t.orderId!);
        if (stop || !o) return;
        setOrder(o);
        if (o.state !== last) {
          last = o.state;
          setLog((l) => [...l, { state: o.state, at: Date.now() }]);
        }
        if (TERMINAL.includes(o.state)) {
          const r = parseOrderResult(o);
          let p: PositionView | null = null;
          const pid = r.kind === "open" || r.kind === "closed" ? r.positionId : o.position_id;
          if (pid) p = await anon.getPosition(pid);
          if (stop) return;
          setPos(p);
          bump();
          onDone?.(o, p);
          return;
        }
      } catch {
        /* transient RPC error: keep polling */
      }
      if (!stop) setTimeout(tick, 600);
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.orderId]);

  const state = t.requestError ? "Rejected" : (order?.state ?? (t.orderId ? "Requested" : "Submitting"));
  const result = t.requestError ?? order?.result ?? null;
  const steps = orderTimeline(state as any, t.mode, result);
  const r = order ? parseOrderResult(order) : null;
  const rejected = state === "Rejected" || state === "Expired" || state === "Cancelled";
  return (
    <div className="surface" style={{ marginTop: 18 }} data-testid="order-tracker" data-state={state}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="surfaceTitle" style={{ margin: 0 }}>
          {t.kind === "open" ? "Open order" : "Close order"} {t.orderId ? `#${t.orderId}` : ""}
        </div>
        <span className={`chip ${state === "Executed" ? "on" : rejected ? "bad" : "warn"}`} data-testid="order-state">
          {state}
        </span>
      </div>
      <div className="timeline5">
        {steps.map((s) => (
          <div key={s.state} className={`step ${s.status}`} title={s.note}>
            {s.status === "done" ? "Done" : s.status === "active" ? "In progress" : s.status === "skipped" ? "Not used" : s.status === "failed" ? "Stopped" : "Waiting"}
            <b>{s.label}</b>
          </div>
        ))}
      </div>
      {t.txHash && (
        <div className="muted" style={{ fontSize: 11 }}>
          Request tx <span className="code">{shortHash(t.txHash, 10)}</span>
          {log.length > 0 && ` · ${log.map((l) => `${l.state} +${((l.at - t.submittedAt) / 1000).toFixed(1)}s`).join(" → ")}`}
        </div>
      )}
      {!t.orderId && !t.requestError && <div className="muted" style={{ fontSize: 12 }}>Waiting for your signature and the request transaction…</div>}
      {rejected && result && (
        <div data-testid="order-reason">
          <ErrorBox error={explainError(result)} />
        </div>
      )}
      {state === "Executed" && t.kind === "open" && pos && (
        <div className="summary" data-testid="open-result">
          <div className="sumrow">
            <span>Position</span>
            <strong>
              #{pos.position.position_id} <span className="chip on" data-testid="position-state">{pos.position.state.toUpperCase()}</span>
            </strong>
          </div>
          <div className="sumrow">
            <span>Contract entry price</span>
            <strong data-testid="entry-price">{cents(pos.position.terms.entry_price)}</strong>
          </div>
          <div className="sumrow">
            <span>Leverage / units</span>
            <strong>
              {levX(pos.position.terms.leverage)} · {units(pos.position.terms.units)}
            </strong>
          </div>
          <div className="sumrow">
            <span>Margin / fill</span>
            <strong>
              {usd(pos.position.terms.margin)} · {ppmPct(pos.position.fill_fraction_ppm)}
            </strong>
          </div>
          <div className="sumrow">
            <span>Max payout on this exposure</span>
            <strong className="green">{usd(pos.max_payout)}</strong>
          </div>
          <button className="mini" onClick={() => navigate("positions")}>
            View in positions ↗
          </button>
        </div>
      )}
      {state === "Executed" && t.kind === "close" && pos && (
        <div className="summary" data-testid="close-result">
          <div className="sumrow">
            <span>Result</span>
            <strong>{r?.kind === "closed" ? (r.full ? "Fully closed" : "Partially closed") : order?.result}</strong>
          </div>
          <div className="sumrow">
            <span>Paid out to you so far</span>
            <strong className="green" data-testid="close-payout">
              {usd(pos.position.paid_out)}
            </strong>
          </div>
          <div className="sumrow">
            <span>Realized P&L</span>
            <strong>{usd(pos.position.realized_pnl)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
