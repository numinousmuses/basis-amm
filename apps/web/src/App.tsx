import { useEffect, useState } from "react";
import { api, API_URL, type StackInfo } from "./lib/api";
import { AppProvider, navigate, useApp, useRoute } from "./lib/app";
import { ErrorBox, Modal } from "./components/ui";
import { selectorNetwork } from "./lib/wallet/selector";
import { MarketsPage } from "./pages/Markets";
import { TradePage } from "./pages/Trade";
import { PositionsPage } from "./pages/Positions";
import { PortfolioPage } from "./pages/Portfolio";
import { VaultPage } from "./pages/Vault";
import { StatsPage } from "./pages/Stats";
import { ActivityPage } from "./pages/Activity";
import { RiskPage } from "./pages/Risk";
import { AdminPage } from "./pages/Admin";
import { SettingsPage } from "./pages/Settings";
import { HedgingPage } from "./pages/Hedging";

const NAV: Array<[string, Array<[string, string, string]>]> = [
  [
    "Trade",
    [
      ["markets", "◈", "Markets"],
      ["trade", "↗", "Trade"],
      ["positions", "◫", "Positions"],
      ["portfolio", "◉", "Portfolio"],
    ],
  ],
  [
    "Protocol",
    [
      ["vault", "◌", "Liquidity vault"],
      ["hedging", "⇄", "Hedge executor"],
      ["stats", "▥", "Public statistics"],
      ["activity", "≡", "Activity"],
    ],
  ],
  [
    "Management",
    [
      ["admin", "⚙", "Admin console"],
      ["risk", "⌁", "Risk monitor"],
      ["settings", "⋯", "Settings"],
    ],
  ],
];

export function App() {
  const [stack, setStack] = useState<StackInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    api.stack().then(setStack, (e) => setErr(String(e?.message ?? e)));
  };
  useEffect(load, []);
  if (err)
    return (
      <div className="page" style={{ maxWidth: 640, paddingTop: 80 }}>
        <h1 style={{ fontWeight: 420, letterSpacing: "-.05em" }}>Cannot reach basis-node</h1>
        <p className="muted">
          The dashboard reads deployment details from <span className="code">{API_URL}/api/stack</span>. Start basis-node or set <span className="code">VITE_API_URL</span> / <span className="code">?api=</span>.
        </p>
        <ErrorBox error={err} onRetry={load} />
      </div>
    );
  if (!stack) return <div className="empty">Connecting to basis-node at {API_URL}…</div>;
  return (
    <AppProvider stack={stack}>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const route = useRoute();
  const app = useApp();
  const [walletOpen, setWalletOpen] = useState(false);
  const all = NAV.flatMap(([, items]) => items);
  const crumb = all.find((x) => x[0] === route.page)?.[2] ?? "Markets";
  const roles = app.roleOf(app.accountId);
  const initials = (app.accountId ?? "--").slice(0, 2).toUpperCase();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">◒</span>basis
          <span style={{ fontSize: 10, color: "#aaa", letterSpacing: 0, fontWeight: 500, marginLeft: -4 }}>AMM</span>
        </div>
        {NAV.map(([section, items]) => (
          <div key={section}>
            <div className="sectionLabel">{section}</div>
            <div className="nav">
              {items.map(([id, ico, label]) => (
                <button key={id} className={route.page === id ? "active" : ""} onClick={() => navigate(id)} data-testid={`nav-${id}`}>
                  <span className="ico">{ico}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="sidebarFoot">
          <div title={app.wsConnected ? "Live WebSocket feed connected" : "Live feed reconnecting"}>
            <span className="statusdot" style={{ background: app.wsConnected ? "#2d9b6f" : "#c9a13b" }} />
            {app.wsConnected ? "Live feed connected" : "Live feed reconnecting"}
          </div>
          <div className="profile">
            <span className="avatar">{initials}</span>
            <span>
              {app.accountId ?? "No account"}
              <br />
              <small style={{ color: "#aaa" }}>{roles.length ? roles.join(", ") : app.accountId ? "Trader" : "Read only"}</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="top">
          <div className="breadcrumb">
            Basis <span style={{ padding: "0 8px", color: "#ccc" }}>/</span> <strong>{crumb}</strong>
          </div>
          <div className="topright">
            <span data-testid="network">
              NEAR {app.stack.network} <span style={{ color: "#26a474" }}>●</span>
            </span>
            {app.stack.simulatedVenue && <span className="chip sim">Mock venue prices</span>}
            <button className="pill" onClick={() => setWalletOpen(true)} data-testid="wallet-button">
              {app.accountId ? `${app.accountId} ⌄` : "Connect wallet"}
            </button>
          </div>
        </header>
        <div className="page">
          <Page page={route.page} arg={route.arg} />
        </div>
      </main>
      {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    </div>
  );
}

function Page({ page, arg }: { page: string; arg?: string }) {
  switch (page) {
    case "trade":
      return <TradePage marketId={arg} />;
    case "positions":
      return <PositionsPage />;
    case "portfolio":
      return <PortfolioPage />;
    case "vault":
      return <VaultPage />;
    case "hedging":
      return <HedgingPage />;
    case "stats":
      return <StatsPage />;
    case "activity":
      return <ActivityPage />;
    case "risk":
      return <RiskPage />;
    case "admin":
      return <AdminPage tab={arg} />;
    case "settings":
      return <SettingsPage />;
    default:
      return <MarketsPage />;
  }
}

export function WalletModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const browserOk = !!selectorNetwork(app.stack);
  return (
    <Modal onClose={onClose} wide>
      <div className="eyebrow">Connect</div>
      <h2 style={{ marginTop: 12 }}>Choose a signer</h2>
      <p>
        Network <b>{app.stack.network}</b>, contract <span className="code">{app.stack.contractId}</span>. Every write is a NEAR transaction signed by the account you pick; the backend never signs for you.
      </p>
      {app.stack.network === "sandbox" && (
        <>
          <div className="smallTitle">Sandbox dev keys (local signing, sandbox only)</div>
          <div className="callout" style={{ marginTop: 0, marginBottom: 10 }}>
            These keys are served by the local sandbox node and sign inside this browser tab. They hold test funds on a private chain and are not a wallet.
          </div>
          {app.devAccounts.length === 0 && <div className="muted">No dev accounts exposed by basis-node.</div>}
          {app.devAccounts.map((d) => (
            <div className="configLine" key={d.accountId}>
              <div>
                <b>{d.accountId}</b>
                <div className="muted" style={{ fontSize: 11 }}>
                  {d.role} {app.roleOf(d.accountId).length ? `· ${app.roleOf(d.accountId).join(", ")}` : ""}
                </div>
              </div>
              <button
                className={app.accountId === d.accountId ? "secondary" : "primary"}
                data-testid={`connect-${d.role}`}
                onClick={() => {
                  app.connectDev(d.accountId);
                  app.toast(`Connected ${d.accountId} (sandbox dev key)`);
                  onClose();
                }}
              >
                {app.accountId === d.accountId ? "Connected" : "Use dev key"}
              </button>
            </div>
          ))}
        </>
      )}
      <div className="smallTitle">Browser wallet (MyNearWallet, Meteor)</div>
      {browserOk ? (
        <button
          className="primary"
          onClick={() =>
            app.connectBrowser().then(
              () => onClose(),
              (e) => app.toast(String(e?.message ?? e), "error"),
            )
          }
        >
          Open wallet selector
        </button>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Browser wallets work on testnet and mainnet. This deployment is <b>{app.stack.network}</b>, so use a sandbox dev key.
        </div>
      )}
      <div className="actionRow" style={{ marginTop: 22 }}>
        {app.accountId && (
          <button
            className="secondary"
            onClick={() => {
              void app.disconnect();
              onClose();
            }}
          >
            Disconnect
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
