/**
 * Spec section 11 "E2E acceptance demo", items 1-12, plus the adversarial list, against a real
 * nearcore sandbox running the compiled contracts. Each `it` names the spec item it proves.
 * Simulated venue fills and marks are labeled `mock-venue:*` / `simulated: true` throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ReporterKey,
  binaryBooks,
  manifestToChain,
  markReport,
  nowNs,
  openTerms,
  holdToResolutionEv,
  impliedProbabilities,
  requiredRiskPremium,
  openFee,
  type HedgeFillReceipt,
  type OutcomeBook,
} from "@basis/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  EXPLORER_TX,
  POLICY_DIR,
  REPO_ROOT,
  TESTNET_BUDGET,
  TESTNET_RPC,
  deployStack,
  loadExampleManifests,
  loadLegacyCredential,
  loadManifest,
  startSandbox,
  testnetConfig,
  type Sandbox,
} from "@basis/stack";
import { Ctx, D, LEV, P, expectFailure, sleep } from "../src/ctx.js";

const BTC = "pm-btc-above-100k-daily";
const SOL = "pm-sol-above-300-weekly";
const NBA = "pm-nba-lakers-celtics";
const ELECTION = "pm-senate-control-2026";
const FED = "pm-fed-dec-decision";
const ETH = "pm-eth-above-4k-weekly";
const GOLD = "pm-gold-above-3000";
const WEATHER = "pm-nyc-snow-december";

const lvl = (p: number, units: number) => ({ price: P(p).toString(), size: (BigInt(units) * D).toString() });
const book = (id: number, bid: number, ask: number, units = 100_000, levels = 5): OutcomeBook => ({
  outcome_id: id,
  bids: Array.from({ length: levels }, (_, i) => lvl(Math.round((bid - 0.01 * i) * 100) / 100, units)).filter((l) => BigInt(l.price) > 0n),
  asks: Array.from({ length: levels }, (_, i) => lvl(Math.round((ask + 0.01 * i) * 100) / 100, units)).filter((l) => BigInt(l.price) < 1_000_000n),
});
const yesBook = (bid: number, ask: number): OutcomeBook[] => [book(0, bid, ask), book(1, Math.round((1 - ask) * 100) / 100, Math.round((1 - bid) * 100) / 100)];

let sb: Sandbox | undefined;
let x: Ctx;
// BASIS_TARGET=testnet BASIS_TESTNET_MASTER=<account>.testnet runs the same suite on NEAR testnet.
const TARGET = process.env.BASIS_TARGET ?? "sandbox";

beforeAll(async () => {
  let stack;
  if (TARGET === "testnet") {
    mkdirSync(join(REPO_ROOT, "infra/testnet"), { recursive: true });
    const master = loadLegacyCredential(process.env.BASIS_TESTNET_MASTER!);
    stack = await deployStack({
      network: "testnet",
      rpcUrl: TESTNET_RPC,
      master,
      manifests: Object.values(loadExampleManifests()),
      config: testnetConfig(),
      nearPerAccount: TESTNET_BUDGET,
      userUsd: 20_000n,
      faucetLimitUsd: 100_000n,
      log: (m) => console.log(m),
      checkpointPath: join(REPO_ROOT, "infra/testnet/acceptance-keys.checkpoint.secret.json"),
    });
    mkdirSync(join(REPO_ROOT, "infra/testnet"), { recursive: true });
    writeFileSync(join(REPO_ROOT, "infra/testnet/acceptance-stack.secret.json"), JSON.stringify(stack, null, 2));
  } else {
    sb = await startSandbox();
    stack = await deployStack({
      network: "sandbox",
      rpcUrl: sb.rpcUrl,
      master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey },
      manifests: Object.values(loadExampleManifests()),
    });
  }
  x = new Ctx(stack);
  // Mock venue books (all labeled mock-venue). Entry asks at exactly $0.50 where the spec uses p0=$0.50.
  x.venue.set(BTC, { mids: [], books: yesBook(0.49, 0.5) });
  x.venue.set(SOL, { mids: [], books: [book(0, 0.49, 0.5), book(1, 0.49, 0.5)] });
  x.venue.set(NBA, { mids: [], books: yesBook(0.54, 0.55) });
  x.venue.set(ELECTION, { mids: [], books: yesBook(0.49, 0.5) });
  x.venue.set(FED, { mids: [], books: [book(0, 0.49, 0.5), book(1, 0.39, 0.4), book(2, 0.09, 0.1)] });
  x.venue.set(ETH, { mids: [], books: yesBook(0.49, 0.5) });
  x.venue.set(GOLD, { mids: [], books: [book(0, 0.8, 0.8), book(1, 0.2, 0.2)] });
  await x.pushMarks();
});

afterAll(async () => {
  if (x) {
    console.log("\nACCEPTANCE TX LOG");
    for (const l of x.log) console.log(`${l.step.padEnd(58)} ${l.tx} ${l.note ?? ""}`);
    if (TARGET === "testnet") {
      const pub = {
        network: "testnet",
        contract: x.stack.contractId,
        token: x.stack.tokenId,
        accounts: Object.fromEntries(Object.entries(x.stack.accounts).map(([k, v]) => [k, v.accountId])),
        deploy_txs: Object.fromEntries(Object.entries(x.stack.txs).map(([k, h]) => [k, EXPLORER_TX(h)])),
        steps: x.log.map((l) => ({ step: l.step, tx: l.tx, url: EXPLORER_TX(l.tx), note: l.note })),
        ran_at: new Date().toISOString(),
      };
      mkdirSync(join(REPO_ROOT, "docs/integration-proofs"), { recursive: true });
      writeFileSync(join(REPO_ROOT, "docs/integration-proofs/testnet-acceptance.json"), JSON.stringify(pub, null, 2) + "\n");
    }
  }
  await sb?.stop();
});

describe("spec 11 E2E acceptance", () => {
  it("1. contracts deployed, markets admitted by manifest, mock hedge executor registered", async () => {
    const markets = await x.c.anon.getMarkets();
    expect(markets.map((m) => m.descriptor.market_id).sort()).toEqual([BTC, ETH, FED, GOLD, NBA, ELECTION, SOL].sort());
    expect(markets.every((m) => m.state === "Active" && m.policy_epoch === 1)).toBe(true);
    const roles = await x.c.anon.getRoles();
    expect(roles.executors).toEqual([x.id("executor")]);
    const reporters = await x.c.anon.getReporters();
    expect(reporters).toHaveLength(3);
    expect(reporters.every((r) => r.attestation_measurement === "dev:unattested")).toBe(true);
    // Categories are display labels only: crypto, sports, elections, macro, commodities.
    expect(new Set(markets.map((m) => m.descriptor.category_label))).toEqual(new Set(["Crypto", "Sports", "Elections", "Macro", "Commodities"]));
    // Fed market is a 3-outcome market: no binary-only schema.
    expect(markets.find((m) => m.descriptor.market_id === FED)!.descriptor.outcomes).toHaveLength(3);
  });

  it("2. vault liquidity minted bLP; free vs reserved liquidity and insurance are separate", async () => {
    const v = await x.vault();
    expect(v.blp_supply).toBe((100_000n * D).toString());
    expect(v.nav).toBe((100_000n * D).toString());
    expect(v.share_price).toBe("1000000");
    expect(v.free_liquidity).toBe((100_000n * D).toString());
    expect(v.payout_reserve).toBe("0");
    expect(v.insurance_balance).toBe((5_000n * D).toString());
    expect(await x.c.anon.blpBalanceOf(x.id("lp"))).toBe((100_000n * D).toString());
    await x.assertConservation("after LP deposit");
  });

  it("8/12. partial fill default ON scales exposure to vault capacity; default-OFF all-or-none is refused", async () => {
    // $500 margin, 5x, p0=$0.50 needs $2,500 of max winning P&L; event budget is 2% of $100k = $2,000.
    const bobBefore = await x.balance("bob");
    const pv = await x.c.anon.previewOpen(FED, 0, 500n * D, LEV(5));
    expect(pv.max_profit).toBe((2_500n * D).toString());
    expect(BigInt(pv.admissible_fill_ppm)).toBeLessThan(1_000_000n);
    const off = await x.open("bob", { market: FED, margin: 500n * D, lev: LEV(5), partial: false, maxFee: 60n * D });
    expect(off.result).toContain("PARTIAL_FILL");
    expect(await x.balance("bob")).toBe(bobBefore); // full refund, nothing charged
    x.record("8. all-or-none rejected + refunded", off.exec);

    const aliceBefore = await x.balance("alice");
    const on = await x.open("alice", { market: FED, margin: 500n * D, lev: LEV(5), partial: true, minFillPpm: 250_000n, maxFee: 60n * D });
    x.record("8/12. partial fill (default ON) executed", on.exec);
    assert(on.positionId, on.result);
    const p = await x.position(on.positionId);
    const frac = BigInt(p.position.fill_fraction_ppm);
    expect(frac).toBeGreaterThan(799_000n);
    expect(frac).toBeLessThanOrEqual(800_000n);
    // Exposure, margin and event-derived max payout scale together.
    const m = BigInt(p.position.terms.margin);
    expect(m).toBe((500n * D * frac) / 1_000_000n);
    expect(BigInt(p.position.terms.units)).toBe(m * 5n * 2n);
    expect(BigInt(p.max_profit)).toBe(m * 5n); // Q*(1-p0) = 10M*(0.5) = 5M
    const risk = await x.c.anon.getRiskSummary(FED);
    expect(BigInt(risk.stress_loss)).toBeLessThanOrEqual(BigInt(risk.event_stress_cap));
    // Unused margin refunded: alice paid margin + fees only.
    const paid = aliceBefore - (await x.balance("alice"));
    expect(paid).toBe(m + BigInt(p.position.open_fee_paid) + BigInt(p.position.risk_premium_paid));
    await x.assertConservation("partial fill");
  });

  let aliceBtc = "";
  it("3. 5x YES POOL_ONLY at p0=$0.50 with $100 margin reserves $500 of LP payout capacity, no hedge", async () => {
    const v0 = await x.vault();
    const r0 = await x.c.anon.getRiskSummary(BTC);
    const aliceBefore = await x.balance("alice");
    const o = await x.open("alice", { market: BTC, margin: 100n * D, lev: LEV(5), maxFee: 15n * D });
    x.record("3. open 5x YES POOL_ONLY $100 @0.50", o.exec);
    assert(o.positionId, o.result);
    aliceBtc = o.positionId;
    const p = await x.position(aliceBtc);
    expect(p.position.mode).toBe("PoolOnly");
    expect(p.position.terms.entry_price).toBe("500000");
    expect(p.position.terms.notional).toBe((500n * D).toString());
    expect(p.position.terms.units).toBe((1_000n * D).toString());
    expect(p.max_profit).toBe((500n * D).toString());
    expect(p.max_payout).toBe((600n * D).toString());
    expect(p.position.hedge_fill_ids).toEqual([]);
    expect(await x.c.anon.getHedgeFills(BTC)).toEqual([]);
    const r1 = await x.c.anon.getRiskSummary(BTC);
    expect(BigInt(r1.payout_reserve) - BigInt(r0.payout_reserve)).toBe(500n * D);
    expect(BigInt(r1.stress_loss) - BigInt(r0.stress_loss)).toBe(500n * D);
    // Fee accounting: open fee 0.10% of notional + fair-value premium (5% of hold-to-resolution EV).
    const t = openTerms(100n * D, LEV(5), P(0.5));
    const probs = impliedProbabilities([P(0.495), P(0.505)]);
    const premium = requiredRiskPremium(holdToResolutionEv(t, [1_000_000n, 0n], probs), 500n);
    expect(p.position.open_fee_paid).toBe(openFee(t.notional, 10n).toString());
    expect(p.position.risk_premium_paid).toBe(premium.toString());
    expect(aliceBefore - (await x.balance("alice"))).toBe(100n * D + openFee(t.notional, 10n) + premium);
    // No LP NAV increase from the margin deposit itself: NAV moves only by fees retained for LPs.
    const v1 = await x.vault();
    const dNav = BigInt(v1.nav) - BigInt(v0.nav);
    const dLpFees = BigInt(v1.fees_to_lp) - BigInt(v0.fees_to_lp);
    expect(dNav - dLpFees).toBeGreaterThanOrEqual(-5n);
    expect(dNav - dLpFees).toBeLessThanOrEqual(5_000n); // hold fees accrued over a few seconds
    await x.assertConservation("pool open");
  });

  it("4. price updates move equity and liquidation trigger; +100% does not auto-close; early/partial close, stop, take-profit at executable bids", async () => {
    // Favorable mark $0.60: trader +$100 (100% of margin) and the position stays OPEN.
    x.venue.set(BTC, { mids: [], books: yesBook(0.6, 0.61) });
    await x.pushMarks([BTC]);
    let p = await x.position(aliceBtc);
    expect(p.position.state).toBe("Open");
    const pnl = BigInt(p.unrealized_pnl!);
    expect(pnl).toBeGreaterThan(99n * D);
    expect(pnl).toBeLessThanOrEqual(100n * D);
    expect(BigInt(p.liquidation_price)).toBeGreaterThan(P(0.42));
    expect(BigInt(p.liquidation_price)).toBeLessThan(P(0.43));
    expect(p.liquidatable).toBe(false);
    await expectFailure(x.c.lp.liquidate(aliceBtc, x.venue.mark(BTC)), "NOT_LIQUIDATABLE");

    // Bob and Carol open at $0.50 (re-set the book), Bob with a stop at $0.45.
    x.venue.set(BTC, { mids: [], books: yesBook(0.49, 0.5) });
    const bob = await x.open("bob", { market: BTC, margin: 100n * D, lev: LEV(5), maxFee: 15n * D, sl: P(0.45) });
    const carol = await x.open("carol", { market: BTC, margin: 200n * D, lev: LEV(5), maxFee: 30n * D });
    assert(bob.positionId && carol.positionId);

    // $0.60: Carol closes 50%, keeps the rest with a take-profit at $0.65.
    x.venue.set(BTC, { mids: [], books: yesBook(0.6, 0.61) });
    const carolBefore = await x.balance("carol");
    const half = await x.close("carol", carol.positionId, 500_000n, P(0.59));
    x.record("4. partial close 50% at executable bid $0.60", half.exec);
    expect(half.result).toBe(`CLOSED:${carol.positionId}:partial`);
    const cp = await x.position(carol.positionId);
    expect(cp.position.state).toBe("Open");
    expect(cp.position.terms.units).toBe((1_000n * D).toString());
    expect(cp.max_profit).toBe((500n * D).toString()); // remaining upside intact, no ceiling reinstated
    const got = (await x.balance("carol")) - carolBefore;
    expect(got).toBeGreaterThan(199n * D); // $100 margin share + $100 profit - close/hold fees
    expect(got).toBeLessThan(200n * D);
    await x.c.carol.setTriggers(carol.positionId, P(0.65), null);

    // $0.66: take-profit fires.
    x.venue.set(BTC, { mids: [], books: yesBook(0.66, 0.67) });
    const tp = await x.c.keeper.executeTrigger(carol.positionId, x.venue.mark(BTC));
    x.record("4. take-profit trigger at $0.66", tp);
    expect((await x.position(carol.positionId)).position.state).toBe("Closed");
    await expectFailure(x.c.keeper.executeTrigger(bob.positionId, x.venue.mark(BTC)), "TRIGGER_NOT_REACHED");

    // $0.44: Bob's stop fires: equity 100 + 1000*(0.44-0.50) = $40 before fees.
    x.venue.set(BTC, { mids: [], books: yesBook(0.44, 0.45) });
    const bobBefore = await x.balance("bob");
    const sl = await x.c.keeper.executeTrigger(bob.positionId, x.venue.mark(BTC));
    x.record("4. stop-loss trigger at $0.44", sl);
    const bp = await x.position(bob.positionId);
    expect(bp.position.state).toBe("Closed");
    const bobGot = (await x.balance("bob")) - bobBefore;
    expect(bobGot).toBeGreaterThan(39n * D);
    expect(bobGot).toBeLessThanOrEqual(40n * D);

    // Early full close by request at $0.44 for a fresh 2x position.
    const e = await x.open("bob", { market: BTC, margin: 50n * D, lev: LEV(2), maxFee: 5n * D });
    assert(e.positionId, e.result);
    const full = await x.close("bob", e.positionId);
    expect(full.result).toBe(`CLOSED:${e.positionId}:full`);
    x.record("4. early full close", full.exec);
    await x.assertConservation("closes");
  });

  it("4b/10. liquidation of losing positions: positive residual pays keeper + user; gap to $0 survives as accounted loss; failed reward transfer stays claimable", async () => {
    // Book at $0.45 ask. 5x would breach the tick-sensitivity ceiling p0/(k*tick) = 4.5x, so 4x.
    x.venue.set(BTC, { mids: [], books: yesBook(0.44, 0.45) });
    const tooHigh = await x.open("bob", { market: BTC, margin: 100n * D, lev: LEV(5), maxFee: 15n * D });
    expect(tooHigh.result).toContain("tick-sensitivity ceiling");
    const b = await x.open("bob", { market: BTC, margin: 100n * D, lev: LEV(4), maxFee: 15n * D });
    const c = await x.open("carol", { market: BTC, margin: 100n * D, lev: LEV(4), maxFee: 15n * D });
    assert(b.positionId, b.result);
    assert(c.positionId, c.result);
    // Q = 888.9 units; liquidation bid = (300 + 1) / (888.9 * 0.95) = $0.356.
    expect(BigInt((await x.position(b.positionId)).liquidation_price)).toBeGreaterThan(P(0.355));
    // $0.39: not yet liquidatable.
    x.venue.set(BTC, { mids: [], books: yesBook(0.39, 0.4) });
    await expectFailure(x.c.lp.liquidate(b.positionId, x.venue.mark(BTC)), "NOT_LIQUIDATABLE");
    // $0.35: liquidatable with positive residual; dave (not registered on the token) liquidates.
    x.venue.set(BTC, { mids: [], books: yesBook(0.35, 0.36) });
    const bobBefore = await x.balance("bob");
    const liq = await x.c.dave.call<string>("liquidate", { position_id: b.positionId, signed: x.venue.mark(BTC) }, { allowFailure: true });
    // The only failed receipt is the token refusing a transfer to an unregistered account.
    expect(liq.failures).toHaveLength(1);
    expect(liq.failures[0]).toContain("not registered");
    expect(liq.events.some((e) => e.event === "transfer_failed")).toBe(true);
    x.record("4b. permissionless liquidation (keeper reward transfer fails -> claimable)", liq);
    const ev = liq.events.find((e) => e.event === "liquidated")!;
    const reward = BigInt(ev.detail.reward);
    expect(reward).toBeGreaterThan(0n);
    expect(BigInt(ev.detail.to_user)).toBeGreaterThan(0n);
    expect(await x.c.anon.getClaimable(x.id("dave"))).toBe(reward.toString());
    expect((await x.balance("bob")) - bobBefore).toBe(BigInt(ev.detail.to_user));
    await expectFailure(x.c.keeper.liquidate(b.positionId, x.venue.mark(BTC)), "POSITION_NOT_OPEN");
    // Dave registers and claims his reward.
    await x.c.dave.registerToken(x.id("dave"));
    const cl = await x.c.dave.claim();
    x.record("10. failed callback recovered via claim()", cl);
    expect(BigInt(await x.c.anon.balanceOf(x.id("dave")))).toBe(reward);
    // Gap: price jumps from 0.35 to 0.20 -> carol equity < 0 -> she gets $0 and owes nothing.
    x.venue.set(BTC, { mids: [], books: yesBook(0.2, 0.21) });
    const carolBefore = await x.balance("carol");
    const gap = await x.c.lp.liquidate(c.positionId, x.venue.mark(BTC));
    x.record("4b. gap-to-zero liquidation", gap);
    const gev = gap.events.find((e) => e.event === "liquidated")!;
    expect(gev.detail.to_user).toBe("0");
    expect(gev.detail.reward).toBe("0");
    expect(await x.balance("carol")).toBe(carolBefore);
    const cp = await x.position(c.positionId);
    expect(cp.position.realized_pnl).toBe((-100n * D).toString()); // exactly -M, never beyond
    await x.assertConservation("liquidations");
  });

  let solYes = "";
  let solNo = "";
  it("6. opposing YES/NO user orders fill separately against the vault (no internal matching); combined stress is scenario-aggregated", async () => {
    const a = await x.open("alice", { market: SOL, outcome: 0, margin: 100n * D, lev: LEV(5), maxFee: 15n * D });
    const b = await x.open("bob", { market: SOL, outcome: 1, margin: 100n * D, lev: LEV(5), maxFee: 15n * D });
    x.record("6. YES fill vs vault", a.exec);
    x.record("6. NO fill vs vault (separate)", b.exec);
    assert(a.positionId && b.positionId);
    solYes = a.positionId;
    solNo = b.positionId;
    expect(a.exec.hash).not.toBe(b.exec.hash);
    const pa = await x.position(a.positionId);
    const pb = await x.position(b.positionId);
    expect(pa.position.order_id).not.toBe(pb.position.order_id);
    const r = await x.c.anon.getRiskSummary(SOL);
    // YES wins: +500 - 100 = 400. NO wins: -100 + 500 = 400. Not 1,000 (sum) and not 0 ("delta neutral").
    expect(r.trader_pnl_by_scenario).toEqual([(400n * D).toString(), (400n * D).toString()]);
    expect(r.stress_loss).toBe((400n * D).toString());
    expect(r.payout_reserve).toBe((400n * D).toString());
  });

  it("5. NO resolution: trader loses exactly $100; YES resolution: +$500 profit, $600 payout; unhedged LP pays $500", async () => {
    // Restore BTC to $0.60 (alice +$100, still open) before the event resolves YES.
    x.venue.set(BTC, { mids: [], books: yesBook(0.6, 0.61) });
    await x.pushMarks();
    expect((await x.position(aliceBtc)).position.state).toBe("Open");
    await x.resolve(BTC, 0);
    await expectFailure(x.c.lp.finalizeResolution(BTC), "SETTLEMENT_PENDING");
    await x.waitDispute(BTC);
    const fin = await x.c.lp.finalizeResolution(BTC);
    x.record("5. finalize BTC YES", fin);
    const v0 = await x.vault();
    const aliceBefore = await x.balance("alice");
    const st = await x.c.keeper.settlePositions(BTC, 50);
    x.record("5. settle BTC positions", st);
    const p = await x.position(aliceBtc);
    expect(p.position.state).toBe("Settled");
    const paid = (await x.balance("alice")) - aliceBefore;
    // $600 payout less holding fees accrued over the test (cents at most).
    expect(paid).toBeLessThanOrEqual(600n * D);
    expect(paid).toBeGreaterThan(599n * D);
    expect(BigInt(p.position.realized_pnl)).toBeGreaterThan(499n * D); // profit 5x margin, no +M cap
    const v1 = await x.vault();
    expect(BigInt(v0.realized_trader_pnl) - BigInt(v1.realized_trader_pnl)).toBeLessThan(-499n * D);

    // SOL resolves NO: alice's YES loses exactly her margin, bob's NO wins +$500.
    await x.resolve(SOL, 1);
    await x.waitDispute(SOL);
    await x.c.lp.finalizeResolution(SOL);
    const bobBefore = await x.balance("bob");
    await x.c.keeper.settlePositions(SOL, 50);
    const ya = await x.position(solYes);
    expect(ya.position.state).toBe("Settled");
    expect(ya.position.paid_out).toBe("0");
    expect(ya.position.realized_pnl).toBe((-100n * D).toString());
    const bobGot = (await x.balance("bob")) - bobBefore;
    expect(bobGot).toBeGreaterThan(599n * D);
    expect(bobGot).toBeLessThanOrEqual(600n * D);
    expect((await x.c.anon.getRiskSummary(SOL)).payout_reserve).toBe("0");
    await x.assertConservation("settlements");
  });

  it("5b. exact-share hedge contrast: removes winning-state loss but creates $400 adverse-state loss; invalid market pays 0.50", async () => {
    const c = await x.open("carol", { market: ELECTION, margin: 100n * D, lev: LEV(5), maxFee: 15n * D });
    assert(c.positionId, c.result);
    let r = await x.c.anon.getRiskSummary(ELECTION);
    expect(r.stress_loss).toBe((500n * D).toString());
    // Executor takes hedge capital within the policy budget and buys 1,000 YES @ $0.50 (simulated fill).
    const cap = await x.c.executor.requestHedgeCapital(ELECTION, 500n * D);
    x.record("5b. hedge capital to executor custody", cap);
    const m = await x.c.anon.getMarket(ELECTION);
    const fill: HedgeFillReceipt = {
      fill_id: `sim-fill-election-${Date.now()}`,
      market_id: ELECTION,
      outcome_id: 0,
      venue_token_ref: m!.descriptor.outcomes[0].venue_token_ref,
      side_buy: true,
      units: (1_000n * D).toString(),
      price: P(0.5).toString(),
      fee: "0",
      venue_order_id: "sim-order-1",
      tx_hash: "sim:0xelection-hedge-1",
      chain: m!.descriptor.chain,
      block_number: "1",
      order_id: null,
      executed_ns: nowNs().toString(),
      simulated: true,
    };
    await x.pushMarks([ELECTION]);
    const hf = await x.c.executor.submitHedgeFill(fill);
    x.record("5b. simulated exact-share hedge fill", hf);
    r = await x.c.anon.getRiskSummary(ELECTION);
    expect(r.hedge_pnl_by_scenario.slice(0, 2)).toEqual([(500n * D).toString(), (-500n * D).toString()]);
    // LP loss: YES 500-500 = 0; NO -100+500 = 400.
    expect(r.stress_loss).toBe((400n * D).toString());
    // Liquidity reservation gives no credit for offchain hedge proceeds.
    expect(r.payout_reserve).toBe((500n * D).toString());
    await expectFailure(x.c.executor.submitHedgeFill(fill), "duplicate receipt");
    await expectFailure(x.c.executor.submitHedgeFill({ ...fill, fill_id: "x1", venue_token_ref: "polygon:ctf:wrong" }), "wrong market or token");
    await expectFailure(x.c.executor.submitHedgeFill({ ...fill, fill_id: "x2", price: P(0.9).toString() }), "slippage");
    await expectFailure(x.c.alice.submitHedgeFill({ ...fill, fill_id: "x3" }), "UNAUTHORIZED");

    // Market cancelled/invalid: the descriptor's INVALID scenario pays 0.50 per unit.
    await x.resolve(ELECTION, 2, [x.resolveA], "Invalid");
    await x.waitDispute(ELECTION);
    await x.c.lp.finalizeResolution(ELECTION);
    await expectFailure(x.c.executor.recordHedgeRedemption(ELECTION, 0, 1_000n * D, 1n, "sim:redeem"), "proceeds differ");
    const red = await x.c.executor.recordHedgeRedemption(ELECTION, 0, 1_000n * D, 500n * D, "sim:0xredeem");
    x.record("5b. hedge redemption at invalid 0.50 payout", red);
    await x.c.keeper.settlePositions(ELECTION, 10);
    const p = await x.position(c.positionId);
    expect(p.position.state).toBe("Settled");
    // 100 + 1000*0.5 - 500 = $100 back, less a few cents of holding fee.
    expect(BigInt(p.position.paid_out)).toBeGreaterThan(99n * D);
    // Executor returns custody cash; custody ledger goes to zero.
    const custody = BigInt((await x.vault()).hedge_custody_cash);
    expect(custody).toBe(500n * D);
    const ret = await x.c.executor.hedgeReturn(custody, ELECTION, "redeemed invalid-market hedge");
    x.record("5b. custody returned", ret);
    expect((await x.vault()).hedge_custody_cash).toBe("0");
    await x.assertConservation("hedge round trip");
  });

  it("3b/8/10. HEDGE_REQUIRED: reserve -> commit -> fills -> provisional -> OPEN; partial scales; all-or-none refunds; orphan inventory freezes opens", async () => {
    await x.pushMarks();
    const mk = await x.c.anon.getMarket(ETH);
    const token = mk!.descriptor.outcomes[0].venue_token_ref;
    const receipt = (orderId: string, units: bigint, n: number): HedgeFillReceipt => ({
      fill_id: `sim-eth-${orderId}-${n}-${Date.now()}`,
      market_id: ETH,
      outcome_id: 0,
      venue_token_ref: token,
      side_buy: true,
      units: units.toString(),
      price: P(0.5).toString(),
      fee: "0",
      venue_order_id: `sim-${orderId}-${n}`,
      tx_hash: `sim:0xeth-${orderId}-${n}`,
      chain: mk!.descriptor.chain,
      block_number: String(n),
      order_id: orderId,
      executed_ns: nowNs().toString(),
      simulated: true,
    });

    // Full hedge.
    const o = await x.open("bob", { market: ETH, margin: 100n * D, lev: LEV(5), maxFee: 15n * D });
    expect(o.result).toBe(`RISK_RESERVED:${o.orderId}`);
    expect((await x.c.anon.getOrder(o.orderId))!.state).toBe("RiskReserved");
    expect((await x.c.anon.getPositionsByOwner(x.id("bob"))).some((p) => p.position.market_id === ETH)).toBe(false);
    const com = await x.c.executor.commitHedge(o.orderId);
    x.record("3b. hedge budget committed to executor", com);
    await expectFailure(x.c.bob.cancelOpen(o.orderId), "ORDER_NOT_CANCELLABLE");
    await x.c.executor.submitHedgeFill(receipt(o.orderId, 600n * D, 1));
    await x.c.executor.submitHedgeFill(receipt(o.orderId, 400n * D, 2));
    await expectFailure(x.c.executor.submitHedgeFill(receipt(o.orderId, 1n * D, 3)), "overfill");
    expect((await x.c.anon.getOrder(o.orderId))!.state).toBe("HedgedProvisional");
    const fin = await x.c.keeper.finalizeOpenHedged(o.orderId);
    x.record("3b. HEDGE_REQUIRED finalized OPEN", fin);
    const pid = String(fin.value).slice(5);
    const p = await x.position(pid);
    expect(p.position.mode).toBe("HedgeRequired");
    expect(p.position.hedge_fill_ids).toHaveLength(2);
    expect(p.position.terms.units).toBe((1_000n * D).toString());
    await expectFailure(x.c.keeper.finalizeOpenHedged(o.orderId), "ORDER_NOT_PROVISIONAL"); // exactly once

    // Partial hedge (60%) with partial fills ON: position scaled to 60%, rest refunded.
    const carolBefore = await x.balance("carol");
    const q = await x.open("carol", { market: ETH, margin: 100n * D, lev: LEV(5), maxFee: 15n * D, minFillPpm: 500_000n });
    await x.c.executor.commitHedge(q.orderId);
    await x.c.executor.submitHedgeFill(receipt(q.orderId, 600n * D, 1));
    const f2 = await x.c.keeper.finalizeOpenHedged(q.orderId);
    x.record("8. HEDGE_REQUIRED partial 60% finalized", f2);
    const p2 = await x.position(String(f2.value).slice(5));
    expect(p2.position.fill_fraction_ppm).toBe("600000");
    expect(p2.position.terms.margin).toBe((60n * D).toString());
    const carolPaid = carolBefore - (await x.balance("carol"));
    expect(carolPaid).toBe(60n * D + BigInt(p2.position.open_fee_paid));

    // All-or-none with a partial venue fill: rejected, full refund, inventory stays vault-owned.
    const aliceBefore = await x.balance("alice");
    const z = await x.open("alice", { market: ETH, margin: 100n * D, lev: LEV(5), maxFee: 15n * D, partial: false });
    await x.c.executor.commitHedge(z.orderId);
    await x.c.executor.submitHedgeFill(receipt(z.orderId, 500n * D, 1));
    const f3 = await x.c.keeper.finalizeOpenHedged(z.orderId);
    expect(String(f3.value)).toContain("PARTIAL_FILL");
    expect(await x.balance("alice")).toBe(aliceBefore);
    x.record("8. all-or-none HEDGE_REQUIRED refunded", f3);
    // Orphan: 500 vault-owned units back no position -> reconciler freezes opens on the market.
    const rec = await x.c.keeper.reportReconciliation(ETH, false, "orphan hedge inventory 500 units from rejected all-or-none order");
    x.record("10. reconciliation mismatch freezes opens", rec);
    expect((await x.c.anon.getEffectiveActions(ETH)).reasons).toContain("POLYGON_RECONCILIATION_FAILED");
    await expectFailure(x.c.alice.requestOpen(await x.intent({ market: ETH, margin: 100n * D, lev: LEV(5) })), "OPEN_NOT_ALLOWED");
    // Risk council writes the orphan off: insurance covers it first (loss waterfall), then LP.
    const v0 = await x.vault();
    const wo = await x.c.risk.writeOffHedge(ETH, 0, 500n * D, 0n, "orphan unwind loss (simulated)");
    x.record("10. orphan write-off: insurance first", wo);
    const v1 = await x.vault();
    expect(BigInt(v0.insurance_balance) - BigInt(v1.insurance_balance)).toBe(250n * D);
    expect(v1.lp_impairment).toBe(v0.lp_impairment);
    await x.c.admin.liftRestrictions(ETH);
    expect((await x.c.anon.getEffectiveActions(ETH)).open).toBe(true);
    // Executor returns unspent custody (budgets were notional + slippage).
    const custody = BigInt((await x.vault()).hedge_custody_cash);
    if (custody > 0n) await x.c.executor.hedgeReturn(custody, ETH, "unspent hedge budget");
    await x.assertConservation("hedge required");
  });

  it("7/8. new market admitted by manifest without redeploy; CLOSE_ONLY via a new policy version keeps the old version pinned to open positions; stale or in-flight policy refused", async () => {
    const codeBefore = (await x.c.anon.provider.viewAccount({ accountId: x.stack.contractId } as any)) as any;
    // New category (weather) via manifest + timelocked approval.
    const weather = manifestToChain(loadManifest(join(POLICY_DIR, "post-deploy/weather-nyc-snow.json")));
    const pr = await x.c.admin.proposeMarket(weather.descriptor, weather.policy);
    x.record("7. propose new weather market (no redeploy)", pr);
    await sleep(1500);
    await x.c.risk.approvePolicy(Number(pr.value));
    expect((await x.c.anon.getMarket(WEATHER))!.state).toBe("Active");
    const codeAfter = (await x.c.anon.provider.viewAccount({ accountId: x.stack.contractId } as any)) as any;
    expect(codeAfter.code_hash).toBe(codeBefore.code_hash);
    // A market whose payout vector is not proven is rejected.
    const bad = manifestToChain(loadManifest(join(POLICY_DIR, "post-deploy/bad-payout-vector.json")));
    await expectFailure(x.c.admin.proposeMarket(bad.descriptor, bad.policy), "PAYOUT_VECTOR_UNPROVEN");

    // NBA: alice opens under policy epoch 1.
    await x.pushMarks();
    const a = await x.open("alice", { market: NBA, margin: 100n * D, lev: LEV(3), maxFee: 15n * D });
    assert(a.positionId, a.result);
    const oldHash = (await x.position(a.positionId)).position.policy_hash;
    // Bob's order is in flight when the policy changes.
    const inflight = await x.request("bob", { market: NBA, margin: 100n * D, lev: LEV(3), maxFee: 15n * D });
    const nba = manifestToChain(loadExampleManifests()[NBA]);
    nba.policy.event_windows = [{ label: "Catalyst: injury report", start_ns: (nowNs() - 1_000_000_000n).toString(), end_ns: (nowNs() + 3_600_000_000_000n).toString(), mode: "CloseOnly" }];
    nba.policy.fees.open_bps = 20;
    const pp = await x.c.admin.proposePolicy(NBA, nba.policy);
    await sleep(1500);
    const ap = await x.c.risk.approvePolicy(Number(pp.value));
    x.record("7. CLOSE_ONLY policy v2 activated during catalyst", ap);
    const mkt = await x.c.anon.getMarket(NBA);
    expect(mkt!.policy_epoch).toBe(2);
    expect(mkt!.policy_hash).not.toBe(oldHash);
    const eff = await x.c.anon.getEffectiveActions(NBA);
    expect(eff.open).toBe(false);
    expect(eff.close).toBe(true);
    expect(eff.reasons.some((r) => r.startsWith("EVENT_WINDOW_CLOSE_ONLY"))).toBe(true);
    // Existing position keeps epoch 1 terms.
    const ap1 = await x.position(a.positionId);
    expect(ap1.position.policy_hash).toBe(oldHash);
    expect(ap1.position.policy_epoch).toBe(1);
    expect(await x.c.anon.getPolicyHistory(NBA)).toEqual([oldHash, mkt!.policy_hash]);
    // In-flight order signed against the old hash is refused at execution and refunded.
    const ex = await x.c.keeper.executeOpen(inflight.orderId, x.venue.mark(NBA));
    expect(String(ex.value)).toContain("POLICY_CHANGED");
    // New order with a stale hash is refused at request.
    await expectFailure(x.c.bob.requestOpen(await x.intent({ market: NBA, margin: 100n * D, lev: LEV(3), policyHash: oldHash })), "POLICY_MISMATCH");
    // New order on the current hash is refused as close-only, but alice can still close.
    await expectFailure(x.c.bob.requestOpen(await x.intent({ market: NBA, margin: 100n * D, lev: LEV(3) })), "MARKET_CLOSE_ONLY");
    const cl = await x.close("alice", a.positionId);
    expect(cl.result).toContain("CLOSED");
    // Guardian can only restrict.
    await x.c.guardian.setCloseOnly(WEATHER);
    expect((await x.c.anon.getEffectiveActions(WEATHER)).open).toBe(false);
    await expectFailure(x.c.guardian.liftRestrictions(WEATHER), "UNAUTHORIZED");
    await x.c.admin.liftRestrictions(WEATHER);
    await x.assertConservation("policy changes");
  });

  it("9. oracle provenance: signatures, freshness, commit ordering and replay are enforced; attestation does not substitute for venue finality", async () => {
    const forged = ReporterKey.random().sign(x.stack.contractId, x.venue.mark(GOLD).report);
    await expectFailure(x.c.keeper.pushMark(forged), "UNKNOWN_REPORTER");
    const good = x.venue.mark(GOLD);
    const tampered = { ...good, report: { ...good.report, outcomes: [book(0, 0.5, 0.5), book(1, 0.5, 0.5)] } };
    await expectFailure(x.c.keeper.pushMark(tampered), "ORACLE_BAD_SIGNATURE");
    const stale = x.venue.mark(GOLD, nowNs() - 600_000_000_000n, 3_600_000_000_000n);
    await expectFailure(x.c.keeper.pushMark(stale), "PRICE_STALE");
    // Order commit then a mark observed BEFORE the commit: refused (anti last-look).
    const early = x.venue.mark(GOLD, nowNs() - 2_000_000_000n);
    const req = await x.request("bob", { market: GOLD, margin: 50n * D, lev: LEV(2), maxFee: 5n * D });
    await expectFailure(x.c.keeper.executeOpen(req.orderId, early), "precedes order commit");
    // Replay of an older-than-stored mark is refused.
    await x.c.keeper.pushMark(x.venue.mark(GOLD));
    await expectFailure(x.c.keeper.pushMark(early), "PRICE_STALE");
    await x.c.bob.cancelOpen(req.orderId);
    // Mark key cannot resolve; a resolution while the venue is still open is refused.
    const fake = x.venue.reporter.sign(x.stack.contractId, { ...x.venue.mark(GOLD).report, kind: "FinalResolution", final_scenario: 0, market_status: "Resolved" });
    await expectFailure(x.c.keeper.submitResolution(fake), "cannot resolve");
    const openStatus = x.resolveA.sign(x.stack.contractId, { ...x.venue.mark(GOLD).report, kind: "FinalResolution", final_scenario: 0, market_status: "Open" });
    await expectFailure(x.c.keeper.submitResolution(openStatus), "SETTLEMENT_PENDING");
    // TS encoder and contract agree on the signed digest byte for byte.
    const r = x.venue.mark(GOLD).report;
    const { reportDigest } = await import("@basis/sdk");
    expect(await x.c.anon.reportDigestHex(r)).toBe(Buffer.from(reportDigest(x.stack.contractId, r)).toString("hex"));
  });

  it("10. stale marks, settlement disputes and paused withdrawals", async () => {
    // Settlement dispute: reporters disagree -> Disputed -> finalize refused -> reset -> re-vote.
    await x.resolve(WEATHER, 0, [x.resolveA]);
    await x.resolve(WEATHER, 1, [x.resolveB]);
    expect((await x.c.anon.getResolution(WEATHER))!.status).toBe("Disputed");
    await expectFailure(x.c.lp.finalizeResolution(WEATHER), "ORACLE_DISPUTED");
    await x.c.risk.resetResolution(WEATHER);
    await x.resolve(WEATHER, 0, [x.resolveA]);
    await x.c.guardian.disputeResolution(WEATHER, "source mismatch under review");
    await expectFailure(x.c.lp.finalizeResolution(WEATHER), "ORACLE_DISPUTED");
    await x.c.risk.resetResolution(WEATHER);
    await x.resolve(WEATHER, 0, [x.resolveA, x.resolveB]);
    await x.waitDispute(WEATHER);
    const fin = await x.c.lp.finalizeResolution(WEATHER);
    x.record("10. weather market finalized after dispute + reset", fin);
    // Paused withdrawals.
    await x.c.guardian.pauseWithdrawals();
    await expectFailure(x.c.lp.requestWithdraw(10n * D), "VAULT_PAUSED");
    await x.c.admin.liftRestrictions(null);
    // Stale mark: a report older than the policy staleness cannot execute an order.
    await x.pushMarks();
    const req = await x.request("bob", { market: GOLD, margin: 50n * D, lev: LEV(2), maxFee: 5n * D });
    const old = markReport({ marketId: GOLD, books: x.venue.books(GOLD), sourceTsNs: nowNs() - 130_000_000_000n, validForNs: 3_600_000_000_000n });
    await expectFailure(x.c.keeper.executeOpen(req.orderId, x.venue.reporter.sign(x.stack.contractId, old)), "PRICE_STALE");
    await x.c.bob.cancelOpen(req.orderId);
    await x.assertConservation("disputes and pauses");
  });

  it("11. $0.80 YES, $100, 5x: +$125 win, $225 payout, -$100 loss, naive EV +$80; fee-only pricing is rejected, engine reprices", async () => {
    await x.pushMarks();
    const pv = await x.c.anon.previewOpen(GOLD, 0, 100n * D, LEV(5));
    expect(pv.entry_price).toBe("800000");
    expect(pv.units).toBe((625n * D).toString());
    expect(pv.max_profit).toBe((125n * D).toString());
    expect(pv.max_payout).toBe((225n * D).toString());
    expect(pv.max_loss).toBe((100n * D).toString());
    expect(pv.trader_ev_hold_to_resolution).toBe((80n * D).toString());
    expect(pv.admissible_fill_ppm).toBe("1000000"); // reserves are sufficient...
    const feeOnly = BigInt(pv.open_fee);
    const aliceBefore = await x.balance("alice");
    const naive = await x.open("alice", { market: GOLD, margin: 100n * D, lev: LEV(5), maxFee: feeOnly });
    expect(naive.result).toContain("FAIR_VALUE"); // ...but that does not make the quote fair
    expect(await x.balance("alice")).toBe(aliceBefore);
    x.record("11. naive $0.80 5x quote rejected FAIR_VALUE", naive.exec);
    // Reprice: highest leverage whose required premium fits the same budget, using the SDK mirror.
    const { openTerms: ot, holdToResolutionEv: ev, requiredRiskPremium: rp, openFee: of } = await import("@basis/sdk");
    let best = 0n;
    for (let l = 10_000n; l <= 50_000n; l += 1_000n) {
      const t = ot(100n * D, l, P(0.8));
      const prem = rp(ev(t, [1_000_000n, 0n], [800_000n, 200_000n]), 500n);
      if (prem + of(t.notional, 10n) <= 2n * D) best = l;
    }
    expect(best).toBeGreaterThan(10_000n);
    const ok = await x.open("alice", { market: GOLD, margin: 100n * D, lev: best, maxFee: 2n * D });
    x.record(`11. repriced to ${Number(best) / 10_000}x and opened`, ok.exec);
    expect(ok.result).toMatch(/^OPEN:/);
  });

  it("12. reserves depend on L, p0 and the full payout (not M); manipulated shallow or wide books are refused", async () => {
    await x.pushMarks();
    x.venue.set(SOL, { mids: [], books: [book(0, 0.49, 0.5), book(1, 0.49, 0.5)] });
    const r = async (m: string, o: number, mm: bigint, l: number) => BigInt((await x.c.anon.previewOpen(m, o, mm, LEV(l))).max_profit);
    expect(await r(GOLD, 0, 100n * D, 5)).toBe(125n * D);
    expect(await r(GOLD, 0, 100n * D, 2)).toBe(50n * D);
    expect(await r(FED, 2, 100n * D, 5)).toBe(4_500n * D); // HIKE @ $0.10: 5x -> Q=5000, max profit $4,500
    // Shallow manipulated book: a 10-unit ask at a manipulated price cannot carry a $500 notional.
    x.venue.set(GOLD, { mids: [], books: [{ outcome_id: 0, bids: [lvl(0.79, 10)], asks: [lvl(0.8, 10)] }, book(1, 0.2, 0.2)] });
    const thin = await x.open("bob", { market: GOLD, margin: 100n * D, lev: LEV(5), maxFee: 10n * D });
    expect(thin.result).toMatch(/PARTIAL_FILL|RISK_LIMIT/);
    // Wide manipulated spread is refused at the oracle guard.
    x.venue.set(GOLD, { mids: [], books: [book(0, 0.3, 0.8), book(1, 0.2, 0.7)] });
    await expectFailure(x.c.keeper.pushMark(x.venue.mark(GOLD)), "SLIPPAGE");
    x.venue.set(GOLD, { mids: [], books: [book(0, 0.8, 0.8), book(1, 0.2, 0.2)] });
  });

  it("adversarial: LP withdrawals cannot drain reserved capital; keeper-only execution; no user debt; global invariants", async () => {
    await x.pushMarks();
    const v = await x.vault();
    const free = BigInt(v.free_liquidity);
    const shares = BigInt(await x.c.anon.blpBalanceOf(x.id("lp")));
    // Withdrawing everything exceeds free liquidity -> queued, not paid.
    const big = await x.c.lp.requestWithdraw(shares);
    const wid = String(big.value);
    const w = (await x.c.anon.getWithdrawalsByOwner(x.id("lp"))).find((w) => w.withdrawal_id === wid)!;
    expect(w.status).toBe("Queued");
    expect(free).toBeLessThan(BigInt(v.nav));
    await x.c.lp.cancelWithdraw(wid);
    // A small withdrawal settles immediately at the conservative share price.
    const lpBefore = await x.balance("lp");
    const price = BigInt((await x.vault()).share_price);
    const small = await x.c.lp.requestWithdraw(1_000n * D);
    x.record("adv. small LP withdrawal settled", small);
    // Paid at the conservative share price (bLP is below $1 after LPs paid winning traders).
    const got = (await x.balance("lp")) - lpBefore;
    expect(got).toBeLessThanOrEqual((1_000n * D * price) / 1_000_000n + 1_000n);
    expect(got).toBeGreaterThan((1_000n * D * price) / 1_000_000n - 1_000_000n);
    // Only keepers execute orders (anti last-look selection by the user).
    const req = await x.request("bob", { market: GOLD, margin: 50n * D, lev: LEV(2), maxFee: 5n * D });
    await expectFailure(x.c.bob.executeOpen(req.orderId, x.venue.mark(GOLD)), "UNAUTHORIZED");
    await x.c.bob.cancelOpen(req.orderId);
    // Nonce replay.
    const intent = await x.intent({ market: GOLD, margin: 50n * D, lev: LEV(2), maxFee: 5n * D });
    await x.c.bob.requestOpen(intent);
    await expectFailure(x.c.bob.requestOpen(intent), "NONCE_REUSED");
    // Missing partial-fill field must not silently opt in (legacy client).
    const legacy: any = { ...(await x.intent({ market: GOLD, margin: 50n * D, lev: LEV(2) })) };
    delete legacy.allow_partial_fill;
    await expectFailure(x.c.bob.transferCall(55n * D, { action: "open", intent: legacy }), "BAD_MSG");

    // Invariants over every position ever opened: loss never beyond margin, wins beyond margin exist.
    const all = [
      ...(await x.c.anon.getPositionsByOwner(x.id("alice"))),
      ...(await x.c.anon.getPositionsByOwner(x.id("bob"))),
      ...(await x.c.anon.getPositionsByOwner(x.id("carol"))),
    ];
    for (const p of all) {
      expect(BigInt(p.position.realized_pnl)).toBeGreaterThanOrEqual(-BigInt(p.position.terms.margin) - 1n);
      expect(BigInt(p.position.paid_out)).toBeGreaterThanOrEqual(0n);
    }
    expect(all.some((p) => BigInt(p.position.realized_pnl) > BigInt(p.position.terms.margin))).toBe(true);
    const vs = await x.vault();
    expect(BigInt(vs.fees_to_lp) + BigInt(vs.fees_to_insurance) + BigInt(vs.fees_to_treasury)).toBe(BigInt(vs.fees_assessed));
    expect(BigInt(vs.nav)).toBe(BigInt(vs.total_assets) - BigInt(vs.user_claim_liability));
    await x.assertConservation("final");
  });
});
