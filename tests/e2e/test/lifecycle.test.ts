/**
 * Contract lifecycle features added for live hedging, on a real nearcore sandbox:
 * - pre-resolution maintenance ramp liquidates losing positions earlier and never touches winners;
 * - hedge receipts: up to 2% overfill accepted (order credited to its reserved size), unwind sells
 *   allowed on HEDGE_REQUIRED markets;
 * - positions record `closed_ns`;
 * - hedge-executor session key registered through the OutLayer callback for a pinned build
 *   (sandbox-only mock OutLayer returning the real executor-tee program's output).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { TGAS, manifestToChain, nowNs, type HedgeFillReceipt, type OutcomeBook } from "@basis/sdk";
import { POLICY_DIR, REPO_ROOT, deployStack, loadManifest, specFixtureManifests, startSandbox, type Sandbox } from "@basis/stack";
import { Ctx, D, LEV, P, expectFailure, sleep } from "../src/ctx.js";

const RAMP = "pm-ramp-test";
const ETH = "pm-eth-above-4k-weekly";
const lvl = (p: number, units: number) => ({ price: P(p).toString(), size: (BigInt(units) * D).toString() });
const book = (id: number, bid: number, ask: number): OutcomeBook => ({
  outcome_id: id,
  bids: [0, 1, 2].map((i) => lvl(Math.round((bid - 0.01 * i) * 100) / 100, 100_000)),
  asks: [0, 1, 2].map((i) => lvl(Math.round((ask + 0.01 * i) * 100) / 100, 100_000)),
});

let sb: Sandbox;
let x: Ctx;

beforeAll(async () => {
  sb = await startSandbox();
  x = new Ctx(await deployStack({ network: "sandbox", rpcUrl: sb.rpcUrl, master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey }, manifests: specFixtureManifests() }));
  x.venue.set(ETH, { mids: [], books: [book(0, 0.49, 0.5), book(1, 0.49, 0.5)] });
  await x.pushMarks();
});
afterAll(async () => sb?.stop());

describe("lifecycle", () => {
  let winner = "";
  let loser = "";
  it("maintenance ramp: a losing position becomes liquidatable as resolution nears, a winner never does", async () => {
    // A market resolving in ~150 s whose maintenance ramps from 5% to 50% over those 150 s.
    const m = loadManifest(join(POLICY_DIR, "crypto-sol-weekly.json"));
    m.descriptor.market_id = RAMP;
    m.descriptor.expected_resolution = "now+150";
    m.policy.maintenance_ramp_s = 150;
    m.policy.pre_resolution_maintenance_bps = 5000;
    m.policy.event_windows = [];
    m.policy.max_leverage = "5";
    const { descriptor, policy } = manifestToChain(m);
    const pr = await x.c.admin.proposeMarket(descriptor, policy);
    await sleep(1500);
    await x.c.risk.approvePolicy(Number(pr.value));
    // YES and NO books both at 0.49/0.50.
    x.venue.set(RAMP, { mids: [], books: [book(0, 0.49, 0.5), book(1, 0.49, 0.5)] });
    await x.pushMarks();
    const a = await x.open("alice", { market: RAMP, outcome: 0, margin: 100n * D, lev: LEV(3), maxFee: 100n * D });
    const b = await x.open("bob", { market: RAMP, outcome: 1, margin: 100n * D, lev: LEV(3), maxFee: 100n * D });
    loser = a.positionId!;
    winner = b.positionId!;
    expect(loser && winner).toBeTruthy();
    const pa = await x.position(loser);
    expect(pa.position.ramp_maintenance_bps).toBe(5000);
    expect(BigInt(pa.position.ramp_end_ns) - BigInt(pa.position.ramp_start_ns)).toBe(150_000_000_000n);
    // YES slips to 0.46 (alice -$24 of $100 margin), NO rises to 0.53 (bob in profit).
    x.venue.set(RAMP, { mids: [], books: [book(0, 0.46, 0.47), book(1, 0.53, 0.54)] });
    await x.pushMarks([RAMP]);
    await expectFailure(x.c.lp.liquidate(loser, x.venue.mark(RAMP)), "NOT_LIQUIDATABLE");
    // Wait until the ramp has climbed past alice's equity ratio (76 / 276 = 27.5%, i.e. ~50% of the ramp).
    const end = BigInt(pa.position.ramp_end_ns);
    const target = BigInt(pa.position.ramp_start_ns) + ((end - BigInt(pa.position.ramp_start_ns)) * 7n) / 10n;
    const waitMs = Number((target - nowNs()) / 1_000_000n);
    if (waitMs > 0) await sleep(waitMs);
    const view = await x.position(loser);
    expect(view.effective_maintenance_bps).toBeGreaterThan(3000);
    const liq = await x.c.lp.liquidate(loser, x.venue.mark(RAMP));
    x.record("ramp. losing position liquidated by the pre-resolution ramp", liq);
    expect((await x.position(loser)).position.state).toBe("Liquidated");
    expect((await x.position(loser)).position.closed_ns).not.toBeNull();
    // Bob is in profit: the ramp never applies to him.
    const wv = await x.position(winner);
    expect(wv.liquidatable).toBe(false);
    await expectFailure(x.c.lp.liquidate(winner, x.venue.mark(RAMP)), "NOT_LIQUIDATABLE");
  });

  it("hedge receipts: 2% overfill tolerance credits only the reserved size; unwind sells allowed on HEDGE_REQUIRED", async () => {
    await x.pushMarks([ETH]);
    const mk = await x.c.anon.getMarket(ETH);
    const token = mk!.descriptor.outcomes[0].venue_token_ref;
    const rcpt = (orderId: string | null, units: bigint, buy: boolean, n: number, price = 0.5): HedgeFillReceipt => ({
      fill_id: `life-${orderId}-${n}-${Date.now()}`,
      market_id: ETH,
      outcome_id: 0,
      venue_token_ref: token,
      side_buy: buy,
      units: units.toString(),
      price: P(price).toString(),
      fee: "0",
      venue_order_id: `o-${n}`,
      tx_hash: `sim:0xlife${n}`,
      chain: mk!.descriptor.chain,
      block_number: String(n),
      order_id: orderId,
      executed_ns: nowNs().toString(),
      simulated: true,
    });
    const o = await x.open("alice", { market: ETH, margin: 100n * D, lev: LEV(5), maxFee: 100n * D });
    await x.c.executor.commitHedge(o.orderId);
    await expectFailure(x.c.executor.submitHedgeFill(rcpt(o.orderId, 1_030n * D, true, 1)), "overfill"); // 3% over
    const r = await x.c.executor.submitHedgeFill(rcpt(o.orderId, 1_015n * D, true, 2, 0.49)); // 1.5% over, within the $505 custody budget
    x.record("hedge. 1.5% overfill accepted, order credited to its reserved size", r);
    const ord = await x.c.anon.getOrder(o.orderId);
    expect(ord!.hedge_units).toBe((1_000n * D).toString());
    expect((await x.c.anon.getRiskSummary(ETH)).hedge_units[0]).toBe((1_015n * D).toString());
    const fin = await x.c.keeper.finalizeOpenHedged(o.orderId);
    const pid = String(fin.value).slice(5);
    expect((await x.position(pid)).position.terms.units).toBe((1_000n * D).toString());
    // Position closes; the executor unwinds its shares with a standalone SELL receipt.
    await x.close("alice", pid);
    expect((await x.position(pid)).position.closed_ns).not.toBeNull();
    const sell = await x.c.executor.submitHedgeFill(rcpt(null, 1_015n * D, false, 3, 0.49));
    x.record("hedge. unwind sell on a HEDGE_REQUIRED market", sell);
    expect((await x.c.anon.getRiskSummary(ETH)).hedge_units[0]).toBe("0");
    // A standalone BUY is still refused outside POOL_PLUS_HEDGE.
    await expectFailure(x.c.executor.submitHedgeFill(rcpt(null, 10n * D, true, 4)), "standalone hedges need POOL_PLUS_HEDGE");
  });

  it("hedge executor session key registered via OutLayer callback for the pinned executor-tee build", async () => {
    const SECRET = "ab".repeat(32);
    const bin = join(REPO_ROOT, "target/debug/executor-tee");
    const out = JSON.parse(execFileSync(bin, { input: JSON.stringify({ mode: "address" }), env: { ...process.env, PROTECTED_EXECUTOR_KEY: SECRET } }).toString());
    expect(out.ok).toBe(true);
    const wasm = join(REPO_ROOT, "out/executor-tee.wasm");
    const hash = createHash("sha256").update(readFileSync(wasm)).digest("hex");
    const provider = new JsonRpcProvider({ url: sb.rpcUrl });
    const root = new Account(sb.rootAccountId, provider, sb.rootSecretKey as any);
    const kp = KeyPair.fromRandom("ed25519");
    const olId = `outlayer2.${sb.rootAccountId}`;
    await root.createAccount({ newAccountId: olId, publicKey: kp.getPublicKey().toString(), nearToTransfer: 5n * 10n ** 24n } as any);
    const ol = new Account(olId, provider, kp.toString() as any);
    await ol.deployContract(readFileSync(join(REPO_ROOT, "out/mock_outlayer.wasm")));
    await ol.callFunctionRaw({ contractId: olId, methodName: "new", args: { owner: olId }, gas: 30n * TGAS });
    await ol.callFunctionRaw({ contractId: olId, methodName: "set_output", args: { wasm_hash: hash, mode: "address", output: JSON.stringify(out) }, gas: 30n * TGAS });
    const cfg = await x.c.anon.getConfig();
    await x.c.admin.proposeConfig({
      ...cfg,
      tee_executor: { outlayer_contract: olId, wasm_url: "https://github.com/numinousmuses/basis-amm/releases/download/v0.3.0/executor-tee.wasm", wasm_hash: hash, build_target: "wasm32-wasip2", secrets_profile: "basis-executor", secrets_owner: x.id("admin"), max_execution_seconds: 30 },
    });
    await sleep(1500);
    await x.c.risk.applyConfig();
    const r = await x.c.admin.requestTeeExecutor("polymarket-session-key-1", 10n ** 23n);
    x.record("tee. hedge executor session key registered", r);
    expect(String(r.value)).toBe(`TEE_EXECUTOR:${out.address}`);
    const keys = await x.c.anon.getTeeExecutors();
    expect(keys[0].evm_address).toBe(out.address);
    expect(keys[0].wasm_hash).toBe(hash);
    await x.c.guardian.call("deactivate_tee_executor", { evm_address: out.address });
    expect((await x.c.anon.getTeeExecutors())[0].active).toBe(false);
    await x.assertConservation("lifecycle");
  });
});
