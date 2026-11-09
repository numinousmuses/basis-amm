/** App-wide state: deployment info from basis-node, the signing wallet, the live WebSocket feed,
 * toasts and the hash router. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BasisClient } from "@basis/sdk";
import { api, wsUrl, type DevAccount, type StackInfo } from "./api";
import { devKeyClient } from "./wallet/devkey";
import { connectSelector, selectorNetwork, type SelectorHandle } from "./wallet/selector";

// ------------------------------------------------------------------ router

export function parseHash(h: string): { page: string; arg?: string } {
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { page: parts[0] ?? "markets", arg: parts[1] ? decodeURIComponent(parts[1]) : undefined };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const f = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return route;
}

export const navigate = (page: string, arg?: string) => {
  window.location.hash = `#/${page}${arg ? "/" + encodeURIComponent(arg) : ""}`;
};

// ------------------------------------------------------------------ live feed

export type LiveMsg =
  | { type: "event"; seq: string; kind: string; ts_ns: string; data: any }
  | { type: "mark"; market: string; ts_ms: number; mids: string[] }
  | ({ type: "vault" } & Record<string, any>);

// ------------------------------------------------------------------ context

export type WalletMode = "dev" | "browser" | "none";

export interface AppCtx {
  stack: StackInfo;
  anon: BasisClient;
  mode: WalletMode;
  accountId: string | null;
  client: BasisClient | null;
  walletLabel: string;
  devAccounts: DevAccount[];
  connectDev: (accountId: string) => void;
  connectBrowser: () => Promise<void>;
  disconnect: () => Promise<void>;
  roleOf: (accountId: string | null) => string[];
  /** Incremented after every confirmed write so account views refetch. */
  version: number;
  bump: () => void;
  subscribe: (fn: (m: LiveMsg) => void) => () => void;
  wsConnected: boolean;
  toast: (msg: string, kind?: "info" | "error") => void;
}

const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside provider");
  return c;
};

/** Subscribe to live WebSocket messages for the lifetime of the component. */
export function useLive(fn: (m: LiveMsg) => void) {
  const { subscribe } = useApp();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}

export function AppProvider({ stack, children }: { stack: StackInfo; children: ReactNode }) {
  const anon = useMemo(() => new BasisClient({ rpcUrl: stack.rpcUrl, contractId: stack.contractId, tokenId: stack.tokenId }), [stack]);
  const [devAccounts, setDevAccounts] = useState<DevAccount[]>([]);
  const [mode, setMode] = useState<WalletMode>(() => (localStorage.getItem(`basis.mode.${stack.contractId}`) as WalletMode) ?? "none");
  const [devId, setDevId] = useState<string | null>(() => localStorage.getItem(`basis.dev.${stack.contractId}`));
  const [browser, setBrowser] = useState<SelectorHandle | null>(null);
  const [version, setVersion] = useState(0);
  const [toastMsg, setToast] = useState<{ msg: string; kind: string; id: number } | null>(null);
  const listeners = useRef(new Set<(m: LiveMsg) => void>());
  const [wsConnected, setWs] = useState(false);

  const toast = useCallback((msg: string, kind: "info" | "error" = "info") => {
    const id = Date.now();
    setToast({ msg, kind, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), kind === "error" ? 6000 : 3200);
  }, []);

  useEffect(() => {
    if (stack.network !== "sandbox") return;
    api.devAccounts().then(setDevAccounts, () => setDevAccounts([]));
  }, [stack]);

  // Restore a browser wallet session (wallet-selector keeps its own storage).
  useEffect(() => {
    if (mode !== "browser" || !selectorNetwork(stack)) return;
    connectSelector(stack).then(setBrowser, (e) => toast(String(e?.message ?? e), "error"));
  }, [mode, stack, toast]);

  // Wallet redirect return (MyNearWallet): show the transaction hash it hands back.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const hashes = q.get("transactionHashes");
    const err = q.get("errorCode");
    if (hashes) toast(`Wallet transaction confirmed: ${hashes.split(",")[0]}`);
    if (err) toast(`Wallet returned an error: ${err}`, "error");
  }, [toast]);

  // WebSocket with reconnect.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => setWs(true);
      ws.onclose = () => {
        setWs(false);
        if (!stop) retry = setTimeout(open, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data) as LiveMsg;
          for (const l of listeners.current) l(m);
        } catch {
          /* ignore */
        }
      };
    };
    open();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const subscribe = useCallback((fn: (m: LiveMsg) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const dev = devAccounts.find((d) => d.accountId === devId) ?? null;
  const client = useMemo(() => {
    if (mode === "dev" && dev) return devKeyClient(stack, dev);
    if (mode === "browser" && browser?.accountId) return browser.client(stack);
    return null;
  }, [mode, dev, browser, stack]);
  const accountId = mode === "dev" ? (dev?.accountId ?? null) : mode === "browser" ? (browser?.accountId ?? null) : null;

  const persistMode = (m: WalletMode) => {
    localStorage.setItem(`basis.mode.${stack.contractId}`, m);
    setMode(m);
  };

  const connectDev = useCallback(
    (id: string) => {
      localStorage.setItem(`basis.dev.${stack.contractId}`, id);
      setDevId(id);
      persistMode("dev");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stack],
  );

  const connectBrowser = useCallback(async () => {
    const h = await connectSelector(stack);
    persistMode("browser");
    if (!h.accountId) {
      h.modal.show();
      const sub = h.selector.store.observable.subscribe((s: any) => {
        if (s.accounts.length) {
          sub.unsubscribe();
          connectSelector(stack).then(setBrowser);
        }
      });
    } else setBrowser(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack]);

  const disconnect = useCallback(async () => {
    if (mode === "browser" && browser) await browser.signOut().catch(() => {});
    setBrowser(null);
    persistMode("none");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, browser]);

  const roleOf = useCallback(
    (id: string | null) => {
      if (!id) return [];
      const r = stack.roles;
      const out: string[] = [];
      if (r.admin === id) out.push("admin");
      if (r.risk_council === id) out.push("risk council");
      if (r.guardian === id) out.push("guardian");
      if (r.keepers.includes(id)) out.push("keeper");
      if (r.executors.includes(id)) out.push("executor");
      return out;
    },
    [stack],
  );

  const walletLabel = mode === "dev" && dev ? `Sandbox dev key: ${dev.role}` : mode === "browser" && browser ? `Browser wallet${browser.walletName ? `: ${browser.walletName}` : ""}` : "Not connected";

  const value: AppCtx = {
    stack,
    anon,
    mode,
    accountId,
    client,
    walletLabel,
    devAccounts,
    connectDev,
    connectBrowser,
    disconnect,
    roleOf,
    version,
    bump: () => setVersion((v) => v + 1),
    subscribe,
    wsConnected,
    toast,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && (
        <div className={`toast${toastMsg.kind === "error" ? " toastError" : ""}`} role="status" data-testid="toast">
          {toastMsg.msg}
        </div>
      )}
    </Ctx.Provider>
  );
}
