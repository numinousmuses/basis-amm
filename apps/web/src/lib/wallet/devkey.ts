/** Sandbox dev-key signer. Signs locally with a secret key served by basis-node's
 * `/api/dev/accounts`, which only exists on the local sandbox. Never used on testnet. */
import { Account, JsonRpcProvider } from "near-api-js";
import { BasisClient } from "@basis/sdk";
import type { StackInfo, DevAccount } from "../api";

export function devKeyClient(stack: StackInfo, dev: DevAccount): BasisClient {
  const account = new Account(dev.accountId, new JsonRpcProvider({ url: stack.rpcUrl }), dev.secretKey as any);
  return new BasisClient({ rpcUrl: stack.rpcUrl, contractId: stack.contractId, tokenId: stack.tokenId, account });
}
