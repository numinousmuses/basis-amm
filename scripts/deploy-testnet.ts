#!/usr/bin/env tsx
/** Deploy a fresh Basis-AMM stack to NEAR testnet from a funded legacy-keychain account.
 *
 *   pnpm tsx scripts/deploy-testnet.ts <master>.testnet [name]
 *
 * Writes infra/testnet/<name>-stack.secret.json (role keys: gitignored, never commit) and a
 * public docs/integration-proofs/testnet-<name>.json with account ids and explorer links. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPLORER_ACCOUNT,
  EXPLORER_TX,
  REPO_ROOT,
  TESTNET_BUDGET,
  TESTNET_RPC,
  deployStack,
  loadExampleManifests,
  loadLegacyCredential,
  testnetConfig,
} from "@basis/stack";

const [masterId, name = "live"] = process.argv.slice(2);
if (!masterId) throw new Error("usage: deploy-testnet.ts <master>.testnet [name]");
mkdirSync(join(REPO_ROOT, "infra/testnet"), { recursive: true });
const stack = await deployStack({
  network: "testnet",
  rpcUrl: TESTNET_RPC,
  master: loadLegacyCredential(masterId),
  manifests: Object.values(loadExampleManifests()),
  config: testnetConfig({ policy_timelock_ns: "30000000000" }),
  // BASIS_LEAN_BUDGET=1 trims the demo-only accounts so a stack fits in ~24.5 NEAR.
  nearPerAccount: process.env.BASIS_LEAN_BUDGET
    ? { ...TESTNET_BUDGET, core: 11n * 10n ** 24n, usdc: (23n * 10n ** 24n) / 10n, admin: (12n * 10n ** 24n) / 10n, risk: (8n * 10n ** 24n) / 10n, guardian: 5n * 10n ** 23n, lp: 8n * 10n ** 23n, alice: 10n ** 24n, bob: 10n ** 24n, carol: 5n * 10n ** 23n, dave: 3n * 10n ** 23n }
    : TESTNET_BUDGET,
  userUsd: 20_000n,
  faucetLimitUsd: 100_000n,
  log: (m) => console.log(m),
  checkpointPath: join(REPO_ROOT, `infra/testnet/${name}-keys.checkpoint.secret.json`),
});
mkdirSync(join(REPO_ROOT, "infra/testnet"), { recursive: true });
const secretPath = join(REPO_ROOT, `infra/testnet/${name}-stack.secret.json`);
writeFileSync(secretPath, JSON.stringify(stack, null, 2));
const pub = {
  network: "testnet",
  rpc: TESTNET_RPC,
  contract: stack.contractId,
  contract_url: EXPLORER_ACCOUNT(stack.contractId),
  token: stack.tokenId,
  token_url: EXPLORER_ACCOUNT(stack.tokenId),
  accounts: Object.fromEntries(Object.entries(stack.accounts).map(([k, v]) => [k, v.accountId])),
  markets: stack.marketIds,
  deploy_txs: Object.fromEntries(Object.entries(stack.txs).map(([k, h]) => [k, EXPLORER_TX(h)])),
  deployed_at: stack.deployedAt,
};
mkdirSync(join(REPO_ROOT, "docs/integration-proofs"), { recursive: true });
writeFileSync(join(REPO_ROOT, `docs/integration-proofs/testnet-${name}.json`), JSON.stringify(pub, null, 2) + "\n");
console.log(`\nDeployed ${stack.contractId}\nsecret stack file: ${secretPath}\nrun: cd services/basis-node && npx tsx src/main.ts --stack ${secretPath} --port 8798`);
