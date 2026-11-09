/** NEAR testnet helpers: legacy-keychain credentials, a per-role NEAR budget sized to the faucet,
 * and a config with a smaller onchain event ring (storage is staked NEAR on testnet). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProtocolConfig } from "@basis/sdk";
import { NEAR, sandboxConfig, type KeyedAccount, type RoleName } from "./deploy.js";

export const TESTNET_RPC = process.env.NEAR_TESTNET_RPC ?? "https://rpc.testnet.fastnear.com";
export const EXPLORER_TX = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const EXPLORER_ACCOUNT = (id: string) => `https://testnet.nearblocks.io/address/${id}`;

export function loadLegacyCredential(accountId: string): KeyedAccount {
  const p = join(homedir(), ".near-credentials/testnet", `${accountId}.json`);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { accountId, secretKey: j.private_key ?? j.secret_key };
}

const milli = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;

/** ~24 NEAR total. The core account locks ~7.2 NEAR for the 711 KB wasm plus state. */
export const TESTNET_BUDGET: Record<RoleName, bigint> = {
  core: milli(12),
  usdc: milli(2.5),
  admin: milli(1.2),
  risk: milli(0.4),
  guardian: milli(0.3),
  keeper: milli(3),
  executor: milli(0.8),
  lp: milli(0.4),
  alice: milli(0.8),
  bob: milli(0.8),
  carol: milli(0.6),
  dave: milli(0.3),
};

export function testnetConfig(over: Partial<ProtocolConfig> = {}): ProtocolConfig {
  return sandboxConfig({ event_log_capacity: 300, ...over });
}
