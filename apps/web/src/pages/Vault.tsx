import { useState } from "react";
import { assetsForShares, decimalToFixed, sharesForDeposit } from "@basis/sdk";
import { api } from "../lib/api";
import { navigate, useApp, useLive } from "../lib/app";
import { useAccount } from "../lib/account";
import { usePoll } from "../lib/hooks";
import { big, fmtDate, nsToMs, ratioPct, signedUsd, units, usd } from "../lib/format";
import { Bar, Empty, ErrorBox, Heading, LineChart, Loading, Metric, SumRow, useTx } from "../components/ui";

const PERIODS: Array<[string, number]> = [
  ["1H", 3600_000],
  ["1D", 86400_000],
  ["1W", 7 * 86400_000],
];

export function VaultPage() {
  const app = useApp();
  const vault = usePoll(() => api.vault(), [app.version], 6000);
  const markets = usePoll(() => api.markets(), [], 15000);
  const [period, setPeriod] = useState(PERIODS[1]);
  const hist = usePoll(() => api.vaultHistory(Date.now() - period[1]), [period[1]], 30000);
  useLive((m) => m.type === "event" && ["lp_deposit", "withdraw_requested", "withdraw_settled", "withdraw_cancelled"].includes(m.kind) && void vault.reload());
  const v = vault.data;
  if (vault.error && !v) return <ErrorBox error={vault.error} onRetry={vault.reload} />;
  if (!v) return <Loading what="Reading the vault from the contract" />;
  const s = v.summary;
  const nav = big(s.nav);
  const globalCap = (nav > 0n ? nav : 0n) * BigInt(v.config.global_stress_cap_bps) / 10_000n;
  const series = (hist.data ?? []).map((r) => ({ x: r.ts_ms, y: Number(r.share_price) / 1e6 }));
  return (
    <>
      <Heading
        title="Basis liquidity"
        sub="Provide test USDC to earn fees and take the other side of trader positions. LPs carry real counterparty risk."
        right={
          <button className="secondary" onClick={() => navigate("stats")}>
            View transparency data ↗
          </button>
        }
      />
      <div className="metricRow">
        <Metric label="Vault NAV" value={usd(s.nav, 0)} detail={s.nav_fresh ? "Marked with fresh prices" : "NAV marks stale: mint and burn paused"} testId="vault-nav" />
        <Metric label="bLP price" value={usd(s.share_price, 4)} detail={`${units(s.blp_supply, 0)} bLP outstanding`} testId="vault-share-price" />
        <Metric label="Free liquidity" value={usd(s.free_liquidity, 0)} detail={`${usd(s.payout_reserve, 0)} reserved for payouts`} />
        <Metric label="Insurance fund" value={usd(s.insurance_balance, 0)} detail="Separately accounted, not LP capital" />
      </div>
      <div className="cols">
        <div>
          <div className="surface">
            <div className="surfaceTitle">bLP share price</div>
            <LineChart series={series} color="#3e826b" label={usd(s.share_price, 4)} sub="bLP / test USDC" yFormat={(y) => `$${y.toFixed(4)}`} />
            <div className="subnav">
              {PERIODS.map((p) => (
                <button key={p[0]} className={period[0] === p[0] ? "active" : ""} onClick={() => setPeriod(p)}>
                  {p[0]}
                </button>
              ))}
            </div>
          </div>
          <div className="surface" style={{ marginTop: 18 }}>
            <div className="surfaceTitle">NAV components</div>
            <SumRow k="Cash" v={usd(s.cash)} />
            <SumRow k="Hedge custody cash" v={usd(s.hedge_custody_cash)} />
            <SumRow k="Hedge inventory (conservative value)" v={usd(s.hedge_inventory_value)} />
            <SumRow k="Total assets" v={usd(s.total_assets)} />
            <SumRow k="Less: current synthetic user claims" v={`-${usd(s.user_claim_liability)}`} />
            <SumRow k="NAV" v={usd(s.nav)} cls="number" testId="nav-components-nav" />
            <div className="smallTitle">Held but not LP capital</div>
            <SumRow k="Trader open margin (backs user claims)" v={usd(s.open_margin)} />
            <SumRow k="Order escrow (pending orders)" v={usd(s.order_escrow)} />
            <SumRow k="Claimable by users" v={usd(s.claimable_total)} />
            <SumRow k="Treasury" v={usd(s.treasury_balance)} />
            <div className="smallTitle">Free vs reserved</div>
            <div className="configLine">
              <span className="key">Reserved for worst-case payouts</span>
              <b>
                {usd(s.payout_reserve)} · {ratioPct(s.payout_reserve, s.total_assets).toFixed(1)}%
              </b>
            </div>
            <Bar pct={ratioPct(s.payout_reserve, s.total_assets)} />
            <div className="configLine">
              <span className="key">Free liquidity</span>
              <b>
                {usd(s.free_liquidity)} · {ratioPct(s.free_liquidity, s.total_assets).toFixed(1)}%
              </b>
            </div>
            <Bar pct={ratioPct(s.free_liquidity, s.total_assets)} color="#999" />
          </div>
          <div className="surface" style={{ marginTop: 18 }}>
            <div className="surfaceTitle">Stress budgets</div>
            <div className="configLine">
              <span className="key">Portfolio stress loss / global cap ({(v.config.global_stress_cap_bps / 100).toFixed(1)}% NAV)</span>
              <b>
                {usd(s.stress_loss)} / {usd(globalCap)}
              </b>
            </div>
            <Bar pct={ratioPct(s.stress_loss, globalCap)} />
            {(markets.data ?? []).map((r) => (
              <div key={r.market.descriptor.market_id}>
                <div className="configLine">
                  <span className="key">{r.market.descriptor.underlying_event}</span>
                  <b>
                    {usd(r.risk.stress_loss, 0)} / {usd(r.risk.event_stress_cap, 0)}
                  </b>
                </div>
                <Bar pct={ratioPct(r.risk.stress_loss, r.risk.event_stress_cap)} color="#777" />
              </div>
            ))}
            <div className="callout">
              LPs bear synthetic trader gains, unhedged outcome risk, any hedge losses and insolvency risk. The vault is not risk-free and is not delta-neutral. Fee yield is variable and never guaranteed. Realized trader P&L so far: {signedUsd(s.realized_trader_pnl)}.
            </div>
          </div>
        </div>
        <div>
          <ManageLiquidity v={v} />
          <Queue queued={v.queued} />
        </div>
      </div>
    </>
  );
}

function ManageLiquidity({ v }: { v: NonNullable<Awaited<ReturnType<typeof api.vault>>> }) {
  const app = useApp();
  const acct = useAccount(6000);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amt, setAmt] = useState("");
  const tx = useTx();
  const s = v.summary;
  let x = 0n;
  try {
    x = decimalToFixed(amt || "0", 6);
  } catch {
    x = 0n;
  }
  const nav = big(s.nav) > 0n ? big(s.nav) : 0n;
  const supply = big(s.blp_supply);
  const sharesOut = sharesForDeposit(x, supply, nav);
  const assetsOut = assetsForShares(x, supply, nav);
  const paused = tab === "deposit" ? v.pause.lp_mint_burn : v.pause.withdrawals || v.pause.lp_mint_burn;
  const mine = acct.data;
  return (
    <div className="surface" data-testid="vault-manage">
      <div className="surfaceTitle">Manage liquidity</div>
      <div className="seg">
        <button className={tab === "deposit" ? "active" : ""} onClick={() => setTab("deposit")} data-testid="vault-tab-deposit">
          Deposit
        </button>
        <button className={tab === "withdraw" ? "active" : ""} onClick={() => setTab("withdraw")} data-testid="vault-tab-withdraw">
          Withdraw
        </button>
      </div>
      <label className="fieldLabel">{tab === "deposit" ? "Amount (test USDC)" : "Shares (bLP)"}</label>
      <input className="field" type="number" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value)} data-testid="vault-amount" />
      <div className="rangeLabels" style={{ marginTop: 6 }}>
        <span>{mine ? (tab === "deposit" ? `Wallet ${usd(mine.usdc)}` : `You hold ${units(mine.blp)} bLP`) : "Not connected"}</span>
        {mine && tab === "withdraw" && (
          <button className="link" onClick={() => setAmt(units(mine.blp, 6).replace(/,/g, ""))}>
            Max
          </button>
        )}
      </div>
      <div className="summary">
        <SumRow k="bLP price" v={usd(s.share_price, 4)} />
        <SumRow k={tab === "deposit" ? "You receive (est.)" : "Estimated test USDC"} v={tab === "deposit" ? `${units(sharesOut)} bLP` : usd(assetsOut)} />
        <SumRow k="Minimum deposit" v={usd(v.config.min_lp_deposit)} />
        <SumRow k="Withdrawals" v="Queued until capital is free" />
      </div>
      {paused && <div className="warnBox">{tab === "deposit" ? "LP mint/burn is paused by the guardian (VAULT_PAUSED)." : "Withdrawals are paused by the guardian (VAULT_PAUSED)."}</div>}
      <button
        className="primary"
        style={{ width: "100%" }}
        disabled={!app.client || x <= 0n || !!tx.busy}
        data-testid="vault-submit"
        onClick={() =>
          void tx.run(
            tab === "deposit" ? "LP deposit" : "Withdrawal request",
            () => (tab === "deposit" ? app.client!.lpDeposit(x, (sharesOut * 99n) / 100n) : app.client!.requestWithdraw(x, 0n)),
            (r: any) => (tab === "deposit" ? (r.events.some((e: any) => e.event === "lp_deposit_refused") ? "Deposit refused and refunded: share price moved" : `Deposited ${usd(x)}`) : `Withdrawal #${r.value} queued`),
          ).then(() => setAmt(""))
        }
      >
        {!app.client ? "Connect to manage liquidity" : tx.busy ? "Signing…" : tab === "deposit" ? "Deposit test USDC" : "Request withdrawal"}
      </button>
      {tx.error && <ErrorBox error={tx.error} />}
      <div className="footnote">Deposits mint bLP at NAV with a 1% minimum-shares guard. Withdrawals queue while capital is reserved against open synthetic liabilities, and a keeper settles them when capital frees up.</div>
      {mine && mine.withdrawals.length > 0 && (
        <>
          <div className="smallTitle">Your withdrawals</div>
          {[...mine.withdrawals].reverse().map((w) => (
            <div className="configLine" key={w.withdrawal_id} data-testid={`my-withdrawal-${w.withdrawal_id}`}>
              <span className="key">
                #{w.withdrawal_id} · {units(w.shares)} bLP · <span data-testid="withdrawal-status">{w.status}</span>
                {w.status === "Settled" ? ` · paid ${usd(w.paid)}` : ""}
              </span>
              {w.status === "Queued" && (
                <button className="mini" disabled={!!tx.busy} onClick={() => void tx.run("Cancel withdrawal", () => app.client!.cancelWithdraw(w.withdrawal_id))} data-testid={`cancel-withdrawal-${w.withdrawal_id}`}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Queue({ queued }: { queued: Array<{ withdrawal_id: string; owner: string; shares: string; requested_ns: string }> }) {
  return (
    <div className="surface" style={{ marginTop: 18 }}>
      <div className="surfaceTitle">Withdrawal queue</div>
      {queued.length === 0 ? (
        <Empty>No queued withdrawals.</Empty>
      ) : (
        queued.map((w) => (
          <div className="configLine" key={w.withdrawal_id}>
            <span className="key">
              #{w.withdrawal_id} · {w.owner}
            </span>
            <b>
              {units(w.shares)} bLP · {fmtDate(nsToMs(w.requested_ns))}
            </b>
          </div>
        ))
      )}
    </div>
  );
}
