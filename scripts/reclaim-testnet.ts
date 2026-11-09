#!/usr/bin/env tsx
/** Sweep spare testnet NEAR from a deployed stack's role accounts into `target`, leaving each
 * account its storage cost plus a 0.05 NEAR buffer (0.5 NEAR for the contract accounts).
 *   npx tsx scripts/reclaim-testnet.ts infra/testnet/<name>-stack.secret.json <target>.testnet */
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider } from "near-api-js";
import { TESTNET_RPC } from "@basis/stack";

const [file, target] = process.argv.slice(2);
const stack = JSON.parse(readFileSync(file, "utf8"));
const provider = new JsonRpcProvider({ url: TESTNET_RPC });
const NEAR = 10n ** 24n;
let total = 0n;
for (const [role, k] of Object.entries<any>(stack.accounts)) {
  const acct = new Account(k.accountId, provider, k.secretKey);
  const st: any = await provider.viewAccount({ accountId: k.accountId } as any);
  const amount = BigInt(st.amount);
  const storage = BigInt(st.storage_usage) * 10n ** 19n;
  const keep = storage + (role === "core" || role === "usdc" ? NEAR / 2n : NEAR / 20n);
  const spare = amount - keep;
  if (spare <= NEAR / 100n) continue;
  await acct.transfer({ receiverId: target, amount: spare } as any);
  total += spare;
  console.log(`${role.padEnd(9)} sent ${(Number(spare) / 1e24).toFixed(3)} NEAR`);
}
console.log(`total ${(Number(total) / 1e24).toFixed(3)} NEAR -> ${target}`);
