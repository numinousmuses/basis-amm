/** Browser wallets for testnet/mainnet via @near-wallet-selector (MyNearWallet, Meteor), adapted
 * to the SDK `TxSender` so every BasisClient write goes through the user's own wallet prompt.
 * Loaded lazily so the sandbox build does not pay for wallet modules it cannot use. */
import { BasisClient, type TxSender } from "@basis/sdk";
import type { StackInfo } from "../api";

export type SelectorNetwork = "testnet" | "mainnet";

export interface SelectorHandle {
  selector: any;
  modal: any;
  accountId: string | null;
  walletName: string | null;
  signOut: () => Promise<void>;
  client: (stack: StackInfo) => BasisClient;
}

let cached: Promise<{ selector: any; modal: any }> | null = null;

export function selectorNetwork(stack: StackInfo): SelectorNetwork | null {
  if (stack.network === "testnet" || stack.network === "mainnet") return stack.network;
  return null;
}

async function init(stack: StackInfo) {
  // Wallet SDKs expect a global Buffer (Node built-in); provide the browser polyfill first.
  if (!(globalThis as any).Buffer) (globalThis as any).Buffer = (await import("buffer")).Buffer;
  const network = selectorNetwork(stack);
  if (!network) throw new Error(`Browser wallets support testnet and mainnet only; this deployment is "${stack.network}". Use the sandbox dev-key signer.`);
  const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/modal-ui"),
    import("@near-wallet-selector/my-near-wallet"),
    import("@near-wallet-selector/meteor-wallet"),
  ]);
  await import("@near-wallet-selector/modal-ui/styles.css");
  const selector = await setupWalletSelector({
    network: { networkId: network, nodeUrl: stack.rpcUrl, helperUrl: "", explorerUrl: "", indexerUrl: "" } as any,
    modules: [setupMyNearWallet(), setupMeteorWallet()],
  });
  const modal = setupModal(selector, { contractId: stack.contractId });
  return { selector, modal };
}

export function loadSelector(stack: StackInfo) {
  if (!cached) cached = init(stack).catch((e) => ((cached = null), Promise.reject(e)));
  return cached;
}

/** TxSender over wallet-selector: one FunctionCall action per transaction. Returns the wallet's
 * FinalExecutionOutcome so `parseTx` can read receipts, logs and events. */
export function selectorSender(selector: any, signerId: string): TxSender {
  return async (call) => {
    const { actionCreators } = await import("@near-wallet-selector/core");
    const wallet = await selector.wallet();
    const outcome = await wallet.signAndSendTransaction({
      signerId,
      receiverId: call.receiverId,
      actions: [actionCreators.functionCall(call.methodName, call.args, call.gas, call.deposit)],
    });
    if (!outcome) throw new Error("WALLET_REDIRECT: the wallet will return to this page with the transaction hash");
    return outcome;
  };
}

export async function connectSelector(stack: StackInfo): Promise<SelectorHandle> {
  const { selector, modal } = await loadSelector(stack);
  const state = selector.store.getState();
  const acct = state.accounts.find((a: any) => a.active) ?? state.accounts[0];
  return {
    selector,
    modal,
    accountId: acct?.accountId ?? null,
    walletName: state.selectedWalletId ?? null,
    signOut: async () => {
      const w = await selector.wallet();
      await w.signOut();
    },
    client: (s: StackInfo) =>
      new BasisClient({ rpcUrl: s.rpcUrl, contractId: s.contractId, tokenId: s.tokenId, sender: selectorSender(selector, acct?.accountId), signerId: acct?.accountId }),
  };
}
