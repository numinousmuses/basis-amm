import { useState } from "react";
import { API_URL } from "../lib/api";
import { useApp } from "../lib/app";
import { loadPrefs, savePrefs, type Prefs } from "../lib/prefs";
import { selectorNetwork } from "../lib/wallet/selector";
import { Heading, Line, Toggle } from "../components/ui";
import { WalletModal } from "../App";

export function SettingsPage() {
  const app = useApp();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [wallet, setWallet] = useState(false);
  const [api, setApi] = useState(API_URL);
  const set = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    savePrefs(next);
  };
  const browserOk = !!selectorNetwork(app.stack);
  return (
    <>
      <Heading eyebrow="Basis / Operations" title="Settings" sub="Wallet mode, network and trading defaults. Preferences stay in this browser." />
      <div className="adminGrid">
        <div className="config">
          <h3>Wallet</h3>
          <Line k="Signer" v={<span data-testid="settings-signer">{app.walletLabel}</span>} />
          <Line k="Account" v={app.accountId ?? "none"} />
          <div className="seg">
            <button className={app.mode === "dev" ? "active" : ""} disabled={app.stack.network !== "sandbox"} onClick={() => setWallet(true)} data-testid="mode-dev">
              Sandbox dev key
            </button>
            <button className={app.mode === "browser" ? "active" : ""} disabled={!browserOk} onClick={() => app.connectBrowser().catch((e) => app.toast(String(e?.message ?? e), "error"))} data-testid="mode-browser">
              Browser wallet
            </button>
            <button className={app.mode === "none" ? "active" : ""} onClick={() => void app.disconnect()}>
              Read only
            </button>
          </div>
          <div className="callout">
            {app.stack.network === "sandbox"
              ? "Sandbox: dev keys from the local node sign in this tab. Browser wallets (MyNearWallet, Meteor) need testnet or mainnet."
              : "Testnet/mainnet: transactions are signed in MyNearWallet or Meteor via NEAR wallet selector. Dev keys are not available."}
          </div>
        </div>
        <div className="config">
          <h3>Network</h3>
          <Line k="Network" v={<span data-testid="settings-network">{app.stack.network}</span>} />
          <Line k="RPC" v={<span className="code">{app.stack.rpcUrl}</span>} />
          <Line k="Basis contract" v={<span className="code">{app.stack.contractId}</span>} />
          <Line k="Collateral token" v={<span className="code">{app.stack.tokenId} (test USDC)</span>} />
          <Line k="Venue" v={app.stack.simulatedVenue ? "Mock venue (simulated prices and fills)" : "Live adapters"} />
          <div className="configLine">
            <span className="key">basis-node API</span>
            <span className="inlineField">
              <input className="field" style={{ width: 230, maxWidth: "none", textAlign: "left" }} value={api} onChange={(e) => setApi(e.target.value)} aria-label="API URL" />
              <button
                className="mini"
                onClick={() => {
                  localStorage.setItem("basis.api", api);
                  window.location.search = "";
                  window.location.reload();
                }}
              >
                Use
              </button>
            </span>
          </div>
        </div>
        <div className="config">
          <h3>Trading preferences</h3>
          <div className="configLine">
            <span>Partial fills on by default</span>
            <Toggle on={prefs.partialFillsDefault} onChange={(v) => set({ partialFillsDefault: v })} label="Partial fills by default" testId="pref-partial" />
          </div>
          <div className="configLine">
            <span>Confirm before opening a position (shows the rules sheet)</span>
            <Toggle on={prefs.confirmBeforeOpen} onChange={(v) => set({ confirmBeforeOpen: v })} label="Confirm before opening" />
          </div>
          <div className="configLine">
            <span>Default entry slippage (bps)</span>
            <input className="field" type="number" value={prefs.slippageBps} onChange={(e) => set({ slippageBps: Math.max(0, Number(e.target.value) || 0) })} aria-label="Default slippage" />
          </div>
        </div>
        <div className="config">
          <h3>About this deployment</h3>
          <Line k="Quote signing key" v={<span className="code">{app.stack.quoteKey.slice(0, 16)}…</span>} />
          <Line k="Mark reporter" v={<span className="code">{app.stack.markReporter.slice(0, 16)}…</span>} />
          <Line k="Dev controls" v={app.stack.devControls ? "Enabled (mock venue panel in Admin)" : "Disabled"} />
          <div className="callout">Test funds only. Quotes are indicative; the contract re-prices every order at a mark observed after you commit.</div>
        </div>
      </div>
      {wallet && <WalletModal onClose={() => setWallet(false)} />}
    </>
  );
}
