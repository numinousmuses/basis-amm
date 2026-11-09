import { navigate, useApp } from "../lib/app";
import { useAccount } from "../lib/account";
import { usePoll } from "../lib/hooks";
import { big, ratioPct, signedUsd, units, usd } from "../lib/format";
import { Bar, Empty, ErrorBox, Heading, Loading, Metric } from "../components/ui";
import { FaucetButton } from "../components/Faucet";
import { ClaimButton } from "../components/Claim";

export function PortfolioPage() {
  const app = useApp();
  const acct = useAccount(5000);
  const vault = usePoll(() => app.anon.getVaultSummary(), [], 10000);
  if (!app.accountId)
    return (
      <>
        <Heading title="Portfolio" sub="Balances, collateral and performance." />
        <Empty>No account connected. Use the wallet button in the top bar.</Empty>
      </>
    );
  const a = acct.data;
  if (acct.error && !a) return <ErrorBox error={acct.error} onRetry={acct.reload} />;
  if (!a) return <Loading what="Reading balances from the contract" />;
  const open = a.positions.filter((p) => p.position.state === "Open");
  const done = a.positions.filter((p) => p.position.state !== "Open");
  const margin = open.reduce((s, p) => s + big(p.position.terms.margin), 0n);
  const equity = open.reduce((s, p) => s + big(p.equity_at_bid), 0n);
  const upnl = open.reduce((s, p) => s + big(p.unrealized_pnl), 0n);
  const realized = done.reduce((s, p) => s + big(p.position.realized_pnl), 0n);
  const price = big(vault.data?.share_price ?? "1000000");
  const blpValue = (big(a.blp) * price) / 1_000_000n;
  const wallet = big(a.usdc);
  const claim = big(a.claimable);
  const total = wallet + equity + blpValue + claim;
  const alloc: Array<[string, bigint, string]> = [
    ["Wallet test USDC", wallet, "#555"],
    ["Position equity at bid", equity, "#999"],
    ["LP shares (bLP at NAV)", blpValue, "#bdbdb9"],
    ["Claimable", claim, "#d6d6d2"],
  ];
  return (
    <>
      <Heading title="Portfolio" sub="Balances, collateral and performance, read from the token and Basis contracts." />
      <div className="metricRow">
        <Metric label="Total value" value={usd(total)} detail="Wallet, positions at bid, bLP at NAV, claimable" />
        <Metric label="Wallet test USDC" value={usd(wallet)} detail={a.registered ? "Registered on the token" : "Not registered: the faucet pays storage"} testId="portfolio-usdc" />
        <Metric label="Margin in use" value={usd(margin)} detail={`${open.length} isolated position${open.length === 1 ? "" : "s"}`} />
        <Metric label="bLP balance" value={units(a.blp)} detail={`${usd(blpValue)} at share price ${usd(price, 4)}`} testId="portfolio-blp" />
      </div>
      <div className="colsWide">
        <div className="surface">
          <div className="surfaceTitle">Account performance</div>
          <div style={{ fontSize: 28, letterSpacing: "-.05em" }}>
            <span className={realized + upnl >= 0n ? "green" : "red"}>{signedUsd(realized + upnl)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
            Realized {signedUsd(realized)} on {done.length} closed position{done.length === 1 ? "" : "s"} · unrealized {signedUsd(upnl)} at the executable bid
          </div>
          {done.length === 0 && open.length === 0 && <Empty>No trading history yet.</Empty>}
          {[...done].reverse().slice(0, 8).map((p) => (
            <div className="configLine" key={p.position.position_id}>
              <span className="key">
                #{p.position.position_id} {p.position.market_id} · {p.position.state}
              </span>
              <b className={big(p.position.realized_pnl) >= 0n ? "green" : "red"}>{signedUsd(p.position.realized_pnl)}</b>
            </div>
          ))}
          <button className="link" style={{ marginTop: 10 }} onClick={() => navigate("positions")}>
            All positions ↗
          </button>
        </div>
        <div className="surface">
          <div className="surfaceTitle">Allocation</div>
          {alloc.map(([k, v, c]) => (
            <div key={k}>
              <div className="configLine">
                <span className="key">{k}</span>
                <b>
                  {usd(v)} · {ratioPct(v, total).toFixed(1)}%
                </b>
              </div>
              <Bar pct={ratioPct(v, total)} color={c} />
            </div>
          ))}
          <div className="smallTitle">Funds</div>
          <div className="actionRow">
            <FaucetButton />
          </div>
          <div style={{ marginTop: 10 }}>
            <ClaimButton claimable={a.claimable} />
          </div>
          <div className="callout">Margin is isolated per position. You cannot owe more than posted collateral, but vault counterparty risk and market resolution still apply. Test USDC from the faucet has no value.</div>
        </div>
      </div>
    </>
  );
}
