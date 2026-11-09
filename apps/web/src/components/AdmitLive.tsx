import { useEffect, useState } from "react";
import { api, type AdmitResult, type DiscoveredMarket, type Family, type MarketRow, type PolymarketMarket } from "../lib/api";
import { navigate, useApp } from "../lib/app";
import { usePoll, useNow } from "../lib/hooks";
import { cents, fmtDate } from "../lib/format";
import { admittedConditions, nearTxUrl, pmPriceMicro } from "../lib/live";
import { STRATEGY_TEXT } from "./RulesSheet";
import { Empty, ErrorBox, Line, Loading } from "./ui";

type Strategy = "HedgeRequired" | "PoolPlusHedge" | "PoolOnly";
const FAMILIES: Array<[Family | "", string]> = [
  ["", "Auto (basis-node guesses from the question)"],
  ["crypto", "Crypto"],
  ["election", "Election"],
  ["sports", "Sports"],
  ["macro", "Macro"],
];

/** Dev control: admit a live Polymarket market through the timelocked governance path. */
export function AdmitLive({ rows, onAdmitted }: { rows: MarketRow[]; onAdmitted: () => void }) {
  const app = useApp();
  const list = usePoll(() => api.discover(30), [], 0);
  const [details, setDetails] = useState<Record<string, PolymarketMarket | "error">>({});
  const [slug, setSlug] = useState<string>("");
  const [family, setFamily] = useState<Family | "">("");
  const [strategy, setStrategy] = useState<Strategy>("HedgeRequired");
  const [busySince, setBusySince] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AdmitResult | null>(null);
  const now = useNow(500);
  const admitted = admittedConditions(rows.map((r) => r.market.descriptor));

  // Price and protocol version per market come from the market endpoint, four at a time.
  useEffect(() => {
    const todo = (list.data ?? []).map((m) => m.slug);
    let stop = false;
    const worker = async () => {
      while (!stop && todo.length) {
        const s = todo.shift()!;
        const v = await api.polymarketMarket(s).catch(() => "error" as const);
        if (!stop) setDetails((d) => ({ ...d, [s]: v }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      stop = true;
    };
  }, [list.data]);

  const picked = (list.data ?? []).find((m) => m.slug === slug);
  const pickedAdmitted = picked ? admitted.get(picked.conditionId.toLowerCase()) : undefined;

  async function admit() {
    if (!picked) return;
    setBusySince(Date.now());
    setErr(null);
    setResult(null);
    try {
      const r = await api.admitPolymarket({ slug: picked.slug, family: family || undefined, strategy });
      setResult(r);
      app.toast(`Admitted ${r.market_id}`);
      app.bump();
      onAdmitted();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusySince(null);
    }
  }

  return (
    <div className="colsWide" data-testid="admit-live">
      <div className="surface">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="surfaceTitle">Live Polymarket markets (top 30 by 24h volume)</div>
          <button className="mini" onClick={() => void list.reload()} disabled={list.loading}>
            Refresh
          </button>
        </div>
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.loading && !list.data && <Loading what="Reading markets from gamma-api.polymarket.com" />}
        {list.data && list.data.length === 0 && <Empty>Polymarket returned no active order-book markets.</Empty>}
        {list.data && list.data.length > 0 && (
          <div className="scrollX" style={{ maxHeight: 640, overflowY: "auto" }}>
            <table className="table" data-testid="discover-table">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Price</th>
                  <th>Version</th>
                  <th>24h volume</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((m) => (
                  <DiscoverRow key={m.slug} m={m} det={details[m.slug]} selected={slug === m.slug} admittedAs={admitted.get(m.conditionId.toLowerCase())} onPick={() => setSlug(m.slug)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="footnote">Read-only from Polymarket's public APIs through basis-node. Listing a market here admits nothing.</div>
      </div>
      <div className="config">
        <div className="confighead">
          <div>
            <h3>Admit a live Polymarket market</h3>
            <p>basis-node builds a manifest from the live market (binary only), registers missing adapters, proposes it as admin, waits out the policy timelock and approves it with the risk council key. Takes about 3 to 35 seconds.</p>
          </div>
          <span className="chip sim">Dev control</span>
        </div>
        {!picked ? (
          <Empty>Pick a market from the list.</Empty>
        ) : (
          <>
            <div className="event" data-testid="admit-picked">
              {picked.question}
            </div>
            <div className="eventMeta" style={{ marginBottom: 10 }}>
              {picked.slug} · ends {picked.endDate ? fmtDate(Date.parse(picked.endDate)) : "n/a"}
            </div>
            <a className="link" href={`https://polymarket.com/event/${picked.slug}`} target="_blank" rel="noreferrer">
              View on Polymarket ↗
            </a>
            {pickedAdmitted && (
              <div className="warnBox">
                Already admitted as <b>{pickedAdmitted}</b>.{" "}
                <button className="link" onClick={() => navigate("trade", pickedAdmitted)}>
                  Open it ↗
                </button>
              </div>
            )}
            <label className="fieldLabel" style={{ marginTop: 16 }}>
              Risk family
            </label>
            <select className="field select" value={family} onChange={(e) => setFamily(e.target.value as Family | "")} data-testid="admit-family">
              {FAMILIES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              The family sets the leverage cap, risk-premium floor coverage and maintenance ramp length that basis-node writes into the policy.
            </div>
            <label className="fieldLabel" style={{ marginTop: 12 }}>
              Strategy
            </label>
            <select className="field select" value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)} data-testid="admit-strategy">
              <option value="HedgeRequired">HEDGE_REQUIRED</option>
              <option value="PoolPlusHedge">POOL_PLUS_HEDGE</option>
              <option value="PoolOnly">POOL_ONLY</option>
            </select>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {STRATEGY_TEXT[strategy]}
            </div>
            <button className="primary" style={{ width: "100%", marginTop: 16 }} disabled={busySince !== null} onClick={() => void admit()} data-testid="admit-submit">
              {busySince !== null ? `Admitting through governance… ${Math.round((now - busySince) / 1000)}s` : "Propose and approve"}
            </button>
          </>
        )}
        {err && <ErrorBox error={err} />}
        {result && (
          <div className="summary" data-testid="admit-result">
            <Line k="Market id" v={<span className="code">{result.market_id}</span>} testId="admit-market-id" />
            <TxLine k="Propose tx (admin)" hash={result.propose_tx} network={app.stack.network} />
            <TxLine k="Approve tx (risk council)" hash={result.approve_tx} network={app.stack.network} />
            <button className="primary" style={{ width: "100%", marginTop: 10 }} onClick={() => navigate("trade", result.market_id)} data-testid="admit-open-market">
              Open the new market ↗
            </button>
          </div>
        )}
        <div className="callout">Admission is data only: the contract gets a descriptor and a hashed policy, and the same timelock and risk-council approval apply as for any other market. Hedges on admitted live markets run in the executor's current mode; see Hedge executor.</div>
      </div>
    </div>
  );
}

function DiscoverRow({ m, det, selected, admittedAs, onPick }: { m: DiscoveredMarket; det: PolymarketMarket | "error" | undefined; selected: boolean; admittedAs?: string; onPick: () => void }) {
  const d = det && det !== "error" ? det : null;
  const yes = d?.outcomes.yes;
  const no = d?.outcomes.no;
  const yp = pmPriceMicro(yes?.price);
  const np = pmPriceMicro(no?.price);
  return (
    <tr className={`pickRow ${selected ? "selected" : ""}`} onClick={onPick} data-testid={`discover-row-${m.slug}`}>
      <td>
        <div className="event">{m.question}</div>
        <div className="eventMeta">
          ends {m.endDate ? fmtDate(Date.parse(m.endDate)) : "n/a"} · tick {m.tickSize}
          {admittedAs && (
            <>
              {" "}
              · <span className="chip on">admitted as {admittedAs}</span>
            </>
          )}
        </div>
      </td>
      <td className="number" style={{ whiteSpace: "nowrap" }} data-testid="discover-price">
        {det === "error" ? (
          <span className="muted">n/a</span>
        ) : !d ? (
          <span className="muted">…</span>
        ) : (
          <>
            <div>
              <span className="muted" style={{ fontSize: 10, marginRight: 6 }}>
                {yes?.label ?? m.outcomes[0]}
              </span>
              {yp !== null ? cents(yp) : "n/a"}
            </div>
            <div>
              <span className="muted" style={{ fontSize: 10, marginRight: 6 }}>
                {no?.label ?? m.outcomes[1]}
              </span>
              {np !== null ? cents(np) : "n/a"}
            </div>
          </>
        )}
      </td>
      <td data-testid="discover-version">{d ? <span className="chip">{d.version}</span> : <span className="muted">…</span>}</td>
      <td className="number">${Math.round(m.volume24h).toLocaleString("en-US")}</td>
    </tr>
  );
}

function TxLine({ k, hash, network }: { k: string; hash: string; network: string }) {
  const url = nearTxUrl(network, hash);
  return (
    <Line
      k={k}
      v={
        url ? (
          <a className="link code" href={url} target="_blank" rel="noreferrer">
            {hash} ↗
          </a>
        ) : (
          <span className="code wrapCode" title="Sandbox chain: no public explorer">
            {hash}
          </span>
        )
      }
    />
  );
}
