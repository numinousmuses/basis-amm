import { useEffect, useMemo, useRef, useState } from "react";
import { BasisTxError, LEV_SCALE, PPM, decimalToFixed, type PositionView } from "@basis/sdk";
import { api, type MarkRow, type MarketDetail, type MarketRow, type Quote } from "../lib/api";
import { navigate, useApp, useLive } from "../lib/app";
import { usePoll, useNow } from "../lib/hooks";
import { explainError, explainReason } from "../lib/errors";
import { buildIntent, defaultMaxFee, effectiveMinFill, leverageCap, leverageCapReason, maxEntryWithSlippage } from "../lib/intent";
import { bestAsk, bestBid, big, bpsPct, cents, fmtDate, isSimulatedSource, levX, midOf, nsToMs, ppmPct, shortHash, signedUsd, timeAgo, units, usd } from "../lib/format";
import { loadPrefs } from "../lib/prefs";
import { useAccount } from "../lib/account";
import { Empty, ErrorBox, Heading, LineChart, Loading, Modal, SimLabel, StateChip, SumRow, Toggle } from "../components/ui";
import { RulesSheet, STRATEGY_TEXT } from "../components/RulesSheet";
import { OrderTracker, type TrackedOrder } from "../components/OrderTracker";
import { FaucetButton } from "../components/Faucet";
import { ResolutionPanel } from "../components/Resolution";
import { VenueChip } from "../components/Venue";
import { isLiveMarket } from "../lib/live";
import { shortPct } from "../lib/positions";

const PERIODS: Array<[string, number]> = [
  ["15M", 15 * 60_000],
  ["1H", 3600_000],
  ["6H", 6 * 3600_000],
];

export function TradePage({ marketId }: { marketId?: string }) {
  const list = usePoll(() => api.markets(), [], 0);
  const id = marketId ?? list.data?.find((r) => r.actions.open)?.market.descriptor.market_id ?? list.data?.[0]?.market.descriptor.market_id;
  if (!id) {
    if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
    if (list.loading) return <Loading what="Reading markets" />;
    return <Empty>No markets are admitted on this deployment.</Empty>;
  }
  return <TradeMarket key={id} id={id} markets={list.data ?? []} />;
}

function TradeMarket({ id, markets }: { id: string; markets: MarketRow[] }) {
  const app = useApp();
  const detail = usePoll(() => api.market(id), [id], 4000);
  const vault = usePoll(() => api.vault(), [], 15000);
  const [period, setPeriod] = useState(PERIODS[1]);
  const marks = usePoll(() => api.marks(id, Date.now() - period[1], 800), [id, period[1]], 0);
  const [live, setLive] = useState<MarkRow[]>([]);
  const [outcome, setOutcome] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  useLive((m) => {
    if (m.type === "mark" && m.market === id) {
      setLive((l) => [...l.slice(-400), { id: 0, market: id, ts_ms: m.ts_ms, mids: m.mids, bids: [], asks: [], report_id: "", source_chain: "" }]);
      void detail.reload();
    }
    if (m.type === "event" && (m.data?.market_id === id || m.kind === "guardian")) void detail.reload();
  });
  useEffect(() => setLive([]), [period[1]]);

  const d = detail.data;
  if (detail.error && !d) return <ErrorBox error={detail.error} onRetry={detail.reload} />;
  if (!d) return <Loading what="Reading market from the contract" />;
  const desc = d.market.descriptor;
  const series = [...(marks.data ?? []), ...live.filter((l) => l.ts_ms > (marks.data?.at(-1)?.ts_ms ?? 0))].map((m) => ({ x: m.ts_ms, y: Number(m.mids[outcome] ?? 0) / 10_000 }));
  const book = d.mark?.report.outcomes.find((o) => o.outcome_id === outcome);
  const markAgeMs = d.mark ? Date.now() - nsToMs(d.mark.report.source_timestamp_ns) : null;
  const closeOnly = d.actions.reasons.some((r) => r.includes("CLOSE_ONLY"));
  const isLive = isLiveMarket(desc);
  return (
    <>
      <Heading
        title="Trade outcome"
        sub="Synthetic exposure with the Basis vault as counterparty. Max loss is your margin; profit is not capped."
        right={
          <button className="secondary" onClick={() => setRulesOpen(true)} data-testid="open-rules">
            Market rules ↗
          </button>
        }
      />
      <div className="cols">
        <div>
          <div className="surface">
            <div className="marketHero">
              <div>
                <div className="eyebrow">
                  {desc.category_label} · {desc.venue} · {desc.chain}
                </div>
                <h2 style={{ fontSize: 25, fontWeight: 440, letterSpacing: "-.045em", lineHeight: 1.3, maxWidth: 570, margin: "12px 0" }} data-testid="market-title">
                  {desc.underlying_event}
                </h2>
              </div>
              <select className="field select" style={{ maxWidth: 220 }} value={id} onChange={(e) => navigate("trade", e.target.value)} data-testid="market-select">
                {markets.map((m) => (
                  <option key={m.market.descriptor.market_id} value={m.market.descriptor.market_id}>
                    {m.market.descriptor.underlying_event.slice(0, 48)}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 27, margin: "22px 0 5px", color: "#999", fontSize: 12, flexWrap: "wrap", alignItems: "center" }}>
              {desc.outcomes.map((o) => (
                <span key={o.outcome_id}>
                  {o.label}{" "}
                  <strong style={{ color: "#222", fontSize: 19, fontWeight: 500, marginLeft: 6 }} data-testid={`outcome-mid-${o.outcome_id}`}>
                    {cents(midOf(d.mark, o.outcome_id))}
                  </strong>
                </span>
              ))}
              <StateChip state={d.market.state} open={d.actions.open} closeOnly={closeOnly} />
              {isLive ? <VenueChip d={desc} mark={d.mark} policy={d.policy} /> : isSimulatedSource(d.mark?.report.source_chain) && <SimLabel text={`Simulated: ${d.mark?.report.source_chain}`} />}
            </div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
              {d.mark ? (
                <>
                  Executable mid from signed mark <span className="code">{shortHash(d.mark.report.report_id, 14)}</span>, observed {markAgeMs !== null ? timeAgo(Date.now() - markAgeMs) : ""}. Execution uses a newer mark observed after your order commits.
                </>
              ) : (
                "No signed mark yet: opens are refused until a fresh mark arrives."
              )}
            </div>
            <LineChart series={series} color="#333" label={<span>{desc.outcomes[outcome]?.label} mid</span>} yFormat={(y) => `${y.toFixed(1)}¢`} />
            <div className="subnav" style={{ marginBottom: 0 }}>
              {PERIODS.map((p) => (
                <button key={p[0]} className={period[0] === p[0] ? "active" : ""} onClick={() => setPeriod(p)}>
                  {p[0]}
                </button>
              ))}
            </div>
          </div>
          <div className="surface" style={{ marginTop: 18 }}>
            <div className="surfaceTitle" data-testid="book-title">
              {isLive ? "Live Polymarket book" : "Order book depth"} · {desc.outcomes[outcome]?.label}
            </div>
            {book ? <Depth bids={book.bids} asks={book.asks} /> : <Empty>No book in the latest mark.</Empty>}
            <div className="footnote">
              Depth from the latest signed mark report{d.mark ? <> (source <span className="code">{d.mark.report.source_chain}</span>)</> : null}. Your fill walks the asks; exits walk the bids.
              {isLive && " Levels are the real Polymarket CLOB book at the time the oracle signed the mark."}
            </div>
          </div>
          <div className="surface" style={{ marginTop: 18 }}>
            <div className="surfaceTitle">How this market trades</div>
            <div className="timeline">
              <div className="step">
                01<b>Order committed</b>
              </div>
              <div className="step">
                02<b>Fresh mark verified</b>
              </div>
              <div className="step">
                03<b>Risk reserved + opened</b>
              </div>
              <div className="step">
                04<b>Close / resolve</b>
              </div>
            </div>
            <div className="callout">
              {d.policy ? STRATEGY_TEXT[d.policy.strategy] : ""} Final settlement follows {desc.resolution_source}. There is no forced +100% take-profit: equity keeps its full upside until you close, a trigger you set fires, it is liquidated, or the event resolves.
            </div>
          </div>
          <ResolutionPanel market={d.market} policy={d.policy} resolution={d.resolution} />
          <MarketPositions marketId={id} />
        </div>
        <div>
          {d.policy ? (
            <Composer row={d} outcome={outcome} setOutcome={setOutcome} protocolMax={vault.data?.config.max_leverage_ceiling ?? "100000"} openRules={() => setRulesOpen(true)} />
          ) : (
            <ErrorBox error="NO_ACTIVE_POLICY" />
          )}
        </div>
      </div>
      {rulesOpen && d.policy && (
        <Modal onClose={() => setRulesOpen(false)} wide>
          <div className="eyebrow">Market trading policy</div>
          <h2 style={{ marginTop: 12 }}>{desc.underlying_event}</h2>
          <p>Versioned market rules from the contract, shown before every order.</p>
          <RulesSheet market={d.market} policy={d.policy} actions={d.actions} protocolMax={vault.data?.config.max_leverage_ceiling} />
          <div className="actionRow" style={{ marginTop: 20 }}>
            <button className="secondary" onClick={() => setRulesOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}
      {isSimulatedSource(d.mark?.report.source_chain) && <div className="footnote">Mock venue: marks are deterministic simulated prices labeled {d.mark?.report.source_chain ?? "mock-venue"}; no real market is traded.</div>}
    </>
  );
}

function Depth({ bids, asks }: { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> }) {
  const max = [...bids, ...asks].reduce((a, l) => (big(l.size) > a ? big(l.size) : a), 1n);
  const row = (l: { price: string; size: string }, color: string) => (
    <div className="depthRow" key={l.price}>
      <i style={{ width: `${Number((big(l.size) * 100n) / max)}%`, background: color }} />
      <span className="number">{cents(l.price)}</span>
      <span className="number muted">{units(l.size, 0)} units</span>
    </div>
  );
  return (
    <div className="depth" data-testid="depth">
      <div>
        <div className="fieldLabel">Bids (exit)</div>
        {bids.map((l) => row(l, "#197856"))}
      </div>
      <div>
        <div className="fieldLabel">Asks (entry)</div>
        {asks.map((l) => row(l, "#bf514b"))}
      </div>
    </div>
  );
}

function MarketPositions({ marketId }: { marketId: string }) {
  const app = useApp();
  const acct = useAccount(5000);
  const mine = (acct.data?.positions ?? []).filter((p) => p.position.market_id === marketId && p.position.state === "Open");
  if (!app.accountId || !mine.length) return null;
  return (
    <div className="surface" style={{ marginTop: 18 }}>
      <div className="surfaceTitle">Your open positions here</div>
      {mine.map((p: PositionView) => (
        <div className="configLine" key={p.position.position_id}>
          <span>
            #{p.position.position_id} · {levX(p.position.terms.leverage)} · entry {cents(p.position.terms.entry_price)}
          </span>
          <b className={big(p.unrealized_pnl) >= 0n ? "green" : "red"}>{signedUsd(p.unrealized_pnl)}</b>
        </div>
      ))}
      <button className="link" onClick={() => navigate("positions")}>
        Manage positions ↗
      </button>
    </div>
  );
}

function Composer({ row, outcome, setOutcome, protocolMax, openRules }: { row: MarketDetail; outcome: number; setOutcome: (n: number) => void; protocolMax: string; openRules: () => void }) {
  const app = useApp();
  const prefs = useMemo(loadPrefs, []);
  const policy = row.policy!;
  const desc = row.market.descriptor;
  const [marginStr, setMarginStr] = useState("100");
  const [levNum, setLevNum] = useState(3);
  const [partial, setPartial] = useState(prefs.partialFillsDefault);
  const [minFillPct, setMinFillPct] = useState(50);
  const [slip, setSlip] = useState(prefs.slippageBps);
  const [maxFeeStr, setMaxFeeStr] = useState<string | null>(null);
  const [tpStr, setTp] = useState("");
  const [slStr, setSl] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [tracked, setTracked] = useState<TrackedOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const now = useNow(500);
  const acct = useAccount(8000);

  let margin = 0n;
  try {
    margin = decimalToFixed(marginStr || "0", 6);
  } catch {
    margin = 0n;
  }
  const levFixed = BigInt(Math.round(levNum * 10)) * (LEV_SCALE / 10n);
  const cap = quote ? leverageCap(quote.preview) : big(policy.max_leverage) < big(protocolMax) ? big(policy.max_leverage) : big(protocolMax);
  const capNum = Number(cap) / 10_000;
  const floorPct = Number(big(policy.min_fill_floor_ppm)) / 10_000;

  // Clamp leverage to what this market offers right now.
  useEffect(() => {
    if (levNum > capNum && capNum >= 1) setLevNum(Math.floor(capNum * 10) / 10);
  }, [capNum, levNum]);
  useEffect(() => {
    if (minFillPct < floorPct) setMinFillPct(Math.ceil(floorPct));
  }, [floorPct, minFillPct]);

  // Quote: debounced on input changes, refreshed every 5 s (quotes live 15 s).
  const reqId = useRef(0);
  useEffect(() => {
    if (margin <= 0n) {
      setQuote(null);
      return;
    }
    const n = ++reqId.current;
    const run = () =>
      api.quote({ market_id: desc.market_id, outcome_id: outcome, margin: margin.toString(), leverage: levFixed.toString() }).then(
        (q) => n === reqId.current && (setQuote(q), setQuoteErr(null)),
        (e) => n === reqId.current && setQuoteErr(String(e?.message ?? e)),
      );
    const t = setTimeout(run, 300);
    const iv = setInterval(run, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc.market_id, outcome, margin.toString(), levFixed.toString()]);

  const pv = quote?.preview;
  const upfront = big(quote?.total_upfront_fee);
  const autoMaxFee = defaultMaxFee(upfront);
  let maxFee = autoMaxFee;
  if (maxFeeStr !== null) {
    try {
      maxFee = decimalToFixed(maxFeeStr || "0", 6);
    } catch {
      maxFee = 0n;
    }
  }
  const minFillPpm = effectiveMinFill(partial, BigInt(Math.round(minFillPct * 10_000)), big(policy.min_fill_floor_ppm));
  const escrow = margin + maxFee;
  const balance = big(acct.data?.usdc);
  const expiresIn = quote ? Math.max(0, Math.round((quote.expires_ms - now) / 1000)) : 0;
  const notional = big(pv?.notional);
  const holdPerDay = ((notional > margin ? notional - margin : 0n) * BigInt(pv?.hold_apr_bps ?? policy.fees.hold_apr_bps)) / 10_000n / 365n;
  const reasons = quote?.reasons ?? [];
  const feeTooLow = pv ? maxFee < upfront : false;
  const parsePrice = (s: string) => (s.trim() ? decimalToFixed(s, 4) : null); // cents -> 1e6

  async function submit() {
    if (!app.client || !app.accountId || !pv || !quote) return;
    setConfirm(false);
    setSubmitting(true);
    const t: TrackedOrder = { mode: policy.strategy, kind: "open", submittedAt: Date.now() };
    setTracked(t);
    try {
      const intent = buildIntent({
        marketId: desc.market_id,
        outcomeId: outcome,
        policyHash: row.market.policy_hash,
        policy,
        margin,
        leverage: levFixed,
        maxFee,
        maxEntryPrice: maxEntryWithSlippage(big(pv.entry_price), slip),
        allowPartialFill: partial,
        minFillPpm,
        takeProfit: parsePrice(tpStr),
        stopLoss: parsePrice(slStr),
        quoteId: quote.quote_id,
      });
      const tx = await app.client.requestOpen(intent);
      const ev = tx.events.find((e) => e.event === "order_requested");
      if (!ev) throw new Error(tx.failures[0] ?? "No order_requested event in the transaction");
      setTracked({ ...t, orderId: String(ev.detail.order_id), txHash: tx.hash });
      app.bump();
    } catch (e: any) {
      const raw = e instanceof BasisTxError ? (e.result.failures[0] ?? e.message) : String(e?.message ?? e);
      setTracked({ ...t, requestError: raw });
      app.toast(`Order refused: ${explainError(raw).title}`, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !!app.client && !!pv && margin > 0n && row.actions.open && !submitting;
  const rampClosed = !row.actions.open && row.actions.reasons.some((r) => r.startsWith("PRE_RESOLUTION_RAMP"));
  const otherReasons = row.actions.reasons.filter((r) => !r.startsWith("PRE_RESOLUTION_RAMP"));
  const rampStartMs = nsToMs(big(desc.expected_resolution_ns) - big(policy.maintenance_ramp_ns));
  return (
    <>
      <div className="surface" data-testid="composer">
        <div className="surfaceTitle">Open position</div>
        <div className="seg">
          {desc.outcomes.map((o) => (
            <button key={o.outcome_id} className={outcome === o.outcome_id ? "active" : ""} onClick={() => setOutcome(o.outcome_id)} data-testid={`outcome-${o.outcome_id}`}>
              Long {o.label}
            </button>
          ))}
        </div>
        <label className="fieldLabel">Margin (test USDC)</label>
        <input className="field" type="number" min="0" step="1" value={marginStr} onChange={(e) => setMarginStr(e.target.value)} data-testid="composer-margin" />
        <div className="rangeLabels" style={{ marginTop: 6 }}>
          <span>
            Policy range {usd(policy.min_margin, 0)} to {usd(policy.max_margin, 0)}
          </span>
          <span data-testid="wallet-balance">{app.accountId ? `Wallet ${usd(balance)}` : "Not connected"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 21 }}>
          <span className="fieldLabel">Leverage</span>
          <strong data-testid="leverage-label">{levNum.toFixed(1)}x</strong>
        </div>
        <input className="range" type="range" min="1" max={Math.max(1, capNum)} step="0.1" value={levNum} onChange={(e) => setLevNum(Number(e.target.value))} data-testid="composer-leverage" aria-label="Leverage" />
        <div className="rangeLabels">
          <span>1x</span>
          <span title={pv ? leverageCapReason(pv) : ""}>Offered max {levX(cap)}</span>
        </div>
        {pv && big(pv.tick_leverage_ceiling) < big(pv.policy_max_leverage) && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{leverageCapReason(pv)}</div>}

        <div className="configLine" style={{ marginTop: 12 }}>
          <span>
            Allow partial fills <small style={{ color: "#aaa" }}>(default on)</small>
          </span>
          <Toggle on={partial} onChange={setPartial} label="Allow partial fills" testId="partial-toggle" />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="fieldLabel">Minimum acceptable fill</span>
          <strong data-testid="min-fill-label">{ppmPct(minFillPpm, 0)}</strong>
        </div>
        <input
          className="range"
          style={{ margin: "8px 0" }}
          type="range"
          min={Math.ceil(floorPct)}
          max={100}
          step={1}
          value={partial ? minFillPct : 100}
          disabled={!partial}
          onChange={(e) => setMinFillPct(Number(e.target.value))}
          data-testid="min-fill"
          aria-label="Minimum acceptable fill"
        />
        <div className="muted" style={{ fontSize: 11 }} data-testid="partial-note">
          {partial
            ? `If vault capacity only admits part of this order, the contract fills at least ${ppmPct(minFillPpm, 0)} or refuses it. Unused margin is refunded.`
            : "Partial fills off: all-or-none. The minimum fill is locked at 100%; a smaller admissible size is rejected, never converted into a smaller position."}
        </div>

        <details style={{ marginTop: 14 }}>
          <summary className="fieldLabel" style={{ cursor: "pointer" }}>
            Limits you sign: slippage, fee cap, take-profit / stop-loss
          </summary>
          <div className="fields" style={{ marginTop: 10 }}>
            <div>
              <label className="fieldLabel">Entry slippage (bps)</label>
              <input className="field" type="number" value={slip} onChange={(e) => setSlip(Math.max(0, Number(e.target.value) || 0))} data-testid="slippage" />
            </div>
            <div>
              <label className="fieldLabel">Max fee cap (USDC)</label>
              <input className="field" type="number" step="0.01" placeholder={usd(autoMaxFee).replace("$", "")} value={maxFeeStr ?? ""} onChange={(e) => setMaxFeeStr(e.target.value === "" ? null : e.target.value)} data-testid="max-fee" />
            </div>
            <div>
              <label className="fieldLabel">Take profit (¢, optional)</label>
              <input className="field" type="number" step="0.1" value={tpStr} onChange={(e) => setTp(e.target.value)} data-testid="take-profit" />
            </div>
            <div>
              <label className="fieldLabel">Stop loss (¢, optional)</label>
              <input className="field" type="number" step="0.1" value={slStr} onChange={(e) => setSl(e.target.value)} data-testid="stop-loss" />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Triggers are best effort: a keeper executes them at the next mark past your price. They are your choice, never a protocol-imposed close.
          </div>
        </details>

        {quoteErr && <ErrorBox error={quoteErr} />}
        <div className="summary" data-testid="preview">
          <SumRow k="Position notional" v={pv ? usd(pv.notional) : "n/a"} testId="preview-notional" />
          <SumRow k="Synthetic units" v={pv ? units(pv.units) : "n/a"} />
          <SumRow k="Indicative entry" v={pv ? cents(pv.entry_price) : "n/a"} testId="preview-entry" />
          <SumRow k="Est. liquidation price" v={pv ? cents(pv.liquidation_price) : "n/a"} testId="preview-liq" />
          <SumRow k="Maximum loss (your margin)" v={pv ? usd(pv.max_loss) : "n/a"} cls="red" testId="preview-max-loss" />
          <SumRow k={`Profit if ${desc.outcomes[outcome]?.label} pays $1`} v={pv ? `+${usd(pv.max_profit)}` : "n/a"} cls="green" testId="preview-profit" />
          <SumRow k="Total payout if it wins" v={pv ? usd(pv.max_payout) : "n/a"} cls="green" testId="preview-payout" />
          <SumRow k={`Open fee (${bpsPct(policy.fees.open_bps)})`} v={pv ? usd(pv.open_fee) : "n/a"} />
          <SumRow k="Risk premium (fair value of floor)" v={pv ? usd(pv.risk_premium) : "n/a"} testId="preview-premium" />
          <SumRow k={`Holding APR ${bpsPct(pv?.hold_apr_bps ?? policy.fees.hold_apr_bps)}`} v={pv ? `${usd(holdPerDay, 4)} / day` : "n/a"} />
          <SumRow k="Fee cap you sign" v={usd(maxFee)} testId="preview-max-fee" />
          <SumRow k="Deposited now (margin + fee cap)" v={usd(escrow)} />
          <SumRow k="Vault capacity admits now" v={pv ? ppmPct(pv.admissible_fill_ppm, 1) : "n/a"} testId="preview-admissible" />
          <SumRow k="Event stress after / cap" v={pv ? `${usd(pv.event_stress_after, 0)} / ${usd(pv.event_stress_cap, 0)}` : "n/a"} />
        </div>
        <div className="callout" style={{ marginTop: 0 }} data-testid="no-autoclose-note">
          A +100% gain does <b>not</b> close this position. Profit is uncapped up to the instrument payout; the position stays open until you close it, your own trigger fires, it is liquidated, or the market settles.
        </div>
        <div className="warnBox" data-testid="jump-warning">
          Jump risk: prediction-market prices can gap several cents at once, past your liquidation price. Liquidation is not guaranteed at the estimated price. Your loss is still capped at your margin.
        </div>
        {reasons.filter((r) => !(rampClosed && r.startsWith("PRE_RESOLUTION_RAMP"))).length > 0 && (
          <div className="warnBox" data-testid="quote-reasons">
            {reasons.filter((r) => !(rampClosed && r.startsWith("PRE_RESOLUTION_RAMP"))).map((r, i) => (
              <div key={i}>
                <b>{explainError(r).title}.</b> {explainReason(r)}
              </div>
            ))}
            {quote?.suggested_leverage && <div style={{ marginTop: 6 }}>Suggested leverage that passes: {levX(quote.suggested_leverage)}</div>}
          </div>
        )}
        {feeTooLow && (
          <div className="warnBox" data-testid="fee-warning">
            Your fee cap ({usd(maxFee)}) is below the quoted upfront fee ({usd(upfront)}). The contract will likely reject this order with FAIR_VALUE.
          </div>
        )}
        {rampClosed && (
          <div className="errorBox" data-testid="ramp-closed" data-code="PRE_RESOLUTION_RAMP">
            <b>{explainError("PRE_RESOLUTION_RAMP").title}</b>
            <div>
              No new positions since {fmtDate(rampStartMs)}: maintenance for losing positions rises from {shortPct(policy.maintenance_bps)} to {shortPct(policy.pre_resolution_maintenance_bps)} between then and expected resolution on {fmtDate(nsToMs(desc.expected_resolution_ns))}. A fresh position would start underwater by the spread and the ramp could liquidate it at once.
            </div>
            <div style={{ marginTop: 6 }}>Existing positions can still be closed, topped up and settled.</div>
          </div>
        )}
        {!row.actions.open && otherReasons.length > 0 && (
          <div className="warnBox">
            New positions are not accepted: {otherReasons.map((r) => explainReason(r)).join(" ")}
          </div>
        )}
        <div className="rangeLabels" style={{ marginTop: 14 }}>
          <span data-testid="quote-expiry">{quote ? (expiresIn > 0 ? `Quote ${shortHash(quote.quote_id, 8)} expires in ${expiresIn}s` : "Quote expired, refreshing") : "Fetching quote…"}</span>
          <button className="link" onClick={openRules}>
            Policy epoch {row.market.policy_epoch} · {shortHash(row.market.policy_hash, 6)}
          </button>
        </div>
        {!app.accountId ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            Connect an account to trade.
          </div>
        ) : balance < escrow ? (
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              You need {usd(escrow)} test USDC in your wallet; you have {usd(balance)}.
            </div>
            <FaucetButton />
          </div>
        ) : null}
        <button style={{ width: "100%", marginTop: 15 }} className="primary" disabled={!canSubmit || balance < escrow || expiresIn === 0} onClick={() => (prefs.confirmBeforeOpen ? setConfirm(true) : void submit())} data-testid="review-order">
          {rampClosed ? "Opens closed before resolution" : `Review ${desc.outcomes[outcome]?.label} order`}
        </button>
        <div className="footnote" style={{ lineHeight: 1.6 }}>
          Test funds only. Execution needs a fresh mark observed after your commit, the current policy hash, and vault capacity. Indicative values above come from the contract's <span className="code">preview_open</span>; executed values come from the contract after execution.
        </div>
      </div>
      {tracked && <OrderTracker key={tracked.submittedAt + (tracked.orderId ?? "") + (tracked.requestError ?? "")} t={tracked} />}
      {confirm && pv && (
        <Modal onClose={() => setConfirm(false)} wide>
          <div className="eyebrow">Confirm order</div>
          <h2 style={{ marginTop: 12 }}>
            Long {desc.outcomes[outcome]?.label} · {levNum.toFixed(1)}x · {usd(margin)} margin
          </h2>
          <p>{desc.underlying_event}</p>
          <div className="summary">
            <SumRow k="Maximum loss" v={usd(pv.max_loss)} cls="red" />
            <SumRow k="Profit if it wins / total payout" v={`+${usd(pv.max_profit)} / ${usd(pv.max_payout)}`} cls="green" />
            <SumRow k="Max entry price you sign" v={cents(maxEntryWithSlippage(big(pv.entry_price), slip))} />
            <SumRow k="Fee cap you sign (unused part refunded)" v={usd(maxFee)} />
            <SumRow k="Partial fills" v={partial ? `On, minimum ${ppmPct(minFillPpm, 0)}` : "Off, all-or-none (100%)"} testId="confirm-partial" />
            <SumRow k="Effective time" v={fmtDate(Date.now())} />
          </div>
          <div className="smallTitle">Market rules you are signing against</div>
          <RulesSheet market={row.market} policy={policy} actions={row.actions} preview={pv} />
          <div className="actionRow" style={{ marginTop: 20 }}>
            <button className="secondary" onClick={() => setConfirm(false)}>
              Back
            </button>
            <button className="primary" onClick={() => void submit()} data-testid="confirm-submit">
              Sign and submit
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
