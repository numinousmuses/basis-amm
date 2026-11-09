/** Deploy and configure a full Basis-AMM stack (token + core + roles + reporters + markets +
 * liquidity) on any NEAR network where `master` can create sub-accounts: the local sandbox or
 * testnet. The same code path is used by the e2e suite and the testnet deployment script. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import {
  BasisClient,
  ReporterKey,
  TGAS,
  manifestToChain,
  type MarketManifest,
  type ProtocolConfig,
  type Roles,
} from "@basis/sdk";
import { REPO_ROOT } from "./manifests.js";

export interface KeyedAccount {
  accountId: string;
  secretKey: string;
}

export const ROLE_NAMES = ["core", "usdc", "admin", "risk", "guardian", "keeper", "executor", "lp", "alice", "bob", "carol", "dave"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface DeployedStack {
  network: string;
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  accounts: Record<RoleName, KeyedAccount>;
  reporterSecrets: { mark: string; resolveA: string; resolveB: string };
  marketIds: string[];
  deployedAt: string;
  txs: Record<string, string>;
}

export const NEAR = 10n ** 24n;

export function sandboxConfig(over: Partial<ProtocolConfig> = {}): ProtocolConfig {
  return {
    max_leverage_ceiling: "100000",
    global_stress_cap_bps: 1000,
    policy_timelock_ns: "1000000000",
    min_lp_deposit: "10000000",
    nav_staleness_ns: "300000000000",
    min_insurance_for_opens: "1000000000",
    max_positions_per_market: 200,
    max_fee_bps_bound: 500,
    max_event_stress_cap_bps: 1000,
    max_hedge_budget_bps: 2000,
    blp_transferable: true,
    event_log_capacity: 4000,
    require_attested_marks: false,
    tee: null,
    ...over,
  };
}

export function accountFor(rpcUrl: string, k: KeyedAccount): Account {
  return new Account(k.accountId, new JsonRpcProvider({ url: rpcUrl }), k.secretKey as any);
}

export function clientFor(stack: Pick<DeployedStack, "rpcUrl" | "contractId" | "tokenId">, k?: KeyedAccount): BasisClient {
  return new BasisClient({
    rpcUrl: stack.rpcUrl,
    contractId: stack.contractId,
    tokenId: stack.tokenId,
    account: k ? accountFor(stack.rpcUrl, k) : undefined,
  });
}

export interface DeployOptions {
  network: string;
  rpcUrl: string;
  master: KeyedAccount;
  manifests: MarketManifest[];
  config?: ProtocolConfig;
  wasmDir?: string;
  nearPerAccount?: Partial<Record<RoleName, bigint>>;
  lpUsd?: bigint;
  insuranceUsd?: bigint;
  userUsd?: bigint;
  faucetLimitUsd?: bigint;
  reporterSecrets?: DeployedStack["reporterSecrets"];
  log?: (msg: string) => void;
  /** Written after every account creation so generated keys survive a failed deploy. */
  checkpointPath?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deployStack(o: DeployOptions): Promise<DeployedStack> {
  const log = o.log ?? (() => {});
  const provider = new JsonRpcProvider({ url: o.rpcUrl });
  const master = new Account(o.master.accountId, provider, o.master.secretKey as any);
  const wasmDir = o.wasmDir ?? join(REPO_ROOT, "out");
  const coreWasm = readFileSync(join(wasmDir, "basis_core.wasm"));
  const tokenWasm = readFileSync(join(wasmDir, "mock_usdc.wasm"));
  const txs: Record<string, string> = {};

  const defaults: Record<RoleName, bigint> = {
    core: 9n * NEAR,
    usdc: 3n * NEAR,
    admin: 3n * NEAR,
    risk: 2n * NEAR,
    guardian: 2n * NEAR,
    keeper: 5n * NEAR,
    executor: 3n * NEAR,
    lp: 2n * NEAR,
    alice: 2n * NEAR,
    bob: 2n * NEAR,
    carol: 2n * NEAR,
    // dave is deliberately NOT registered on the collateral token: exercises failed transfers.
    dave: 2n * NEAR,
  };
  const accounts = {} as Record<RoleName, KeyedAccount>;
  for (const name of ROLE_NAMES) {
    const accountId = `${name}.${o.master.accountId}`;
    const kp = KeyPair.fromRandom("ed25519");
    const amount = o.nearPerAccount?.[name] ?? defaults[name];
    const r: any = await master.createAccount({ newAccountId: accountId, publicKey: kp.getPublicKey().toString(), nearToTransfer: amount } as any);
    txs[`create:${name}`] = r?.transaction?.hash ?? "";
    accounts[name] = { accountId, secretKey: kp.toString() };
    if (o.checkpointPath) writeFileSync(o.checkpointPath, JSON.stringify({ master: o.master.accountId, accounts }, null, 2));
    log(`created ${accountId}`);
  }
  const acct = (n: RoleName) => accountFor(o.rpcUrl, accounts[n]);

  // Collateral token.
  let r: any = await acct("usdc").deployContract(tokenWasm);
  txs["deploy:usdc"] = r?.transaction?.hash ?? "";
  const tokenId = accounts.usdc.accountId;
  const contractId = accounts.core.accountId;
  const faucetLimit = (o.faucetLimitUsd ?? 1_000_000n) * 1_000_000n;
  r = await acct("usdc").callFunctionRaw({ contractId: tokenId, methodName: "new", args: { owner: accounts.admin.accountId, faucet_limit: faucetLimit.toString() }, gas: 100n * TGAS });
  txs["init:usdc"] = r?.transaction?.hash ?? "";
  log(`token ${tokenId} deployed`);

  // Core contract.
  r = await acct("core").deployContract(coreWasm);
  txs["deploy:core"] = r?.transaction?.hash ?? "";
  const roles: Roles = {
    admin: accounts.admin.accountId,
    risk_council: accounts.risk.accountId,
    guardian: accounts.guardian.accountId,
    executors: [accounts.executor.accountId],
    keepers: [accounts.keeper.accountId],
  };
  const config = o.config ?? sandboxConfig();
  r = await acct("core").callFunctionRaw({ contractId, methodName: "new", args: { collateral_token: tokenId, roles, config, blp_symbol: "bLP" }, gas: 100n * TGAS });
  txs["init:core"] = r?.transaction?.hash ?? "";
  log(`core ${contractId} deployed`);

  const stackRef = { rpcUrl: o.rpcUrl, contractId, tokenId };
  const admin = clientFor(stackRef, accounts.admin);
  const risk = clientFor(stackRef, accounts.risk);

  // Register every protocol participant on the collateral token so payouts never bounce.
  for (const n of ["core", "admin", "keeper", "executor", "lp", "alice", "bob", "carol", "risk", "guardian"] as RoleName[]) {
    await admin.registerToken(accounts[n].accountId);
  }

  // Adapters and reporters.
  const adapters = new Set<string>();
  for (const m of o.manifests) {
    adapters.add(m.descriptor.resolution_adapter_id);
    adapters.add(m.policy.executor_adapter_id);
    adapters.add(m.policy.pricing_adapter_id);
    adapters.add(m.policy.risk_model_id);
  }
  for (const a of adapters) await admin.registerAdapter(a);
  const secrets = o.reporterSecrets ?? {
    mark: Buffer.from(ReporterKey.random().secret).toString("hex"),
    resolveA: Buffer.from(ReporterKey.random().secret).toString("hex"),
    resolveB: Buffer.from(ReporterKey.random().secret).toString("hex"),
  };
  const markKey = ReporterKey.fromHex(secrets.mark);
  await admin.registerReporter({ public_key: markKey.publicKeyHex, label: "mark-worker-1", can_mark: true, can_resolve: false, attestation_measurement: "dev:unattested", active: true, tee_attested: false });
  await admin.registerReporter({ public_key: ReporterKey.fromHex(secrets.resolveA).publicKeyHex, label: "resolution-reporter-A", can_mark: false, can_resolve: true, attestation_measurement: "dev:unattested", active: true, tee_attested: false });
  await admin.registerReporter({ public_key: ReporterKey.fromHex(secrets.resolveB).publicKeyHex, label: "resolution-reporter-B", can_mark: false, can_resolve: true, attestation_measurement: "dev:unattested", active: true, tee_attested: false });
  log("adapters and reporters registered");

  // Markets: propose, wait for the timelock, approve.
  const proposalIds: number[] = [];
  for (const m of o.manifests) {
    const { descriptor, policy } = manifestToChain(m);
    const res = await admin.proposeMarket(descriptor, policy);
    proposalIds.push(Number(res.value));
    txs[`propose:${descriptor.market_id}`] = res.hash;
  }
  await sleep(Number(BigInt(config.policy_timelock_ns) / 1_000_000n) + 1500);
  for (const id of proposalIds) {
    const res = await risk.approvePolicy(id);
    txs[`approve:${id}`] = res.hash;
  }
  log(`${proposalIds.length} markets approved`);

  // Collateral, insurance and LP liquidity.
  const userUsd = (o.userUsd ?? 50_000n) * 1_000_000n;
  for (const n of ["alice", "bob", "carol"] as RoleName[]) await admin.faucet(accounts[n].accountId, userUsd);
  const insurance = (o.insuranceUsd ?? 5_000n) * 1_000_000n;
  await admin.faucet(accounts.admin.accountId, insurance);
  txs["insurance_seed"] = (await admin.seedInsurance(insurance)).hash;
  const lpUsd = (o.lpUsd ?? 100_000n) * 1_000_000n;
  const lp = clientFor(stackRef, accounts.lp);
  let left = lpUsd;
  while (left > 0n) {
    const chunk = left > faucetLimit ? faucetLimit : left;
    await admin.faucet(accounts.lp.accountId, chunk);
    left -= chunk;
  }
  txs["lp_deposit"] = (await lp.lpDeposit(lpUsd)).hash;
  log("insurance seeded and LP deposited");

  return {
    network: o.network,
    rpcUrl: o.rpcUrl,
    contractId,
    tokenId,
    accounts,
    reporterSecrets: secrets,
    marketIds: o.manifests.map((m) => m.descriptor.market_id),
    deployedAt: new Date().toISOString(),
    txs,
  };
}
