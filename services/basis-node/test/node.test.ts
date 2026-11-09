/** basis-node integration: the user only signs transactions; the node's keeper, oracle worker,
 * mock hedge executor, reconciler and indexer do everything else automatically. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { nowNs, type OrderIntent } from "@basis/sdk";
import { clientFor, deployStack, specFixtureManifests, startSandbox, type DeployedStack, type Sandbox } from "@basis/stack";
import { startNode } from "../src/node.js";
import { MockFeed } from "../src/feeds.js";

const D = 1_000_000n;
const BTC = "pm-btc-above-100k-daily";
const ETH = "pm-eth-above-4k-weekly";
const SOL = "pm-sol-above-300-weekly";
const PORT = 18_797;
const API = `http://127.0.0.1:${PORT}`;

let sb: Sandbox;
let stack: DeployedStack;
let node: Awaited<ReturnType<typeof startNode>>;
let feed: MockFeed;
let nonce = BigInt(Date.now());

async function until<T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function intent(market: string, o: Partial<OrderIntent> & { margin: bigint; lev: bigint }): Promise<OrderIntent> {
  const m = await clientFor(stack).getMarket(market);
  nonce += 1n;
  const { margin, lev, ...rest } = o;
  return {
    nonce: nonce.toString(),
    market_id: market,
    outcome_id: 0,
    margin_amount: margin.toString(),
    requested_leverage: lev.toString(),
    max_entry_price: "990000",
    max_hedge_slippage_bps: 100,
    max_fee: (200n * D).toString(),
    deadline_ns: (nowNs() + 120_000_000_000n).toString(),
    take_profit_price: null,
    stop_loss_price: null,
    allow_partial_fill: true,
    minimum_acceptable_fill_ppm: "500000",
    policy_hash: m!.policy_hash,
    quote_id: `test-${nonce}`,
    ...rest,
  };
}

beforeAll(async () => {
  sb = await startSandbox();
  stack = await deployStack({
    network: "sandbox",
    rpcUrl: sb.rpcUrl,
    master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey },
    manifests: specFixtureManifests(),
  });
  feed = new MockFeed(7, 0);
  feed.set(BTC, { mids: [495_000n, 505_000n] });
  feed.set(ETH, { mids: [495_000n, 505_000n] });
  feed.set(SOL, { mids: [495_000n, 505_000n] });
  node = await startNode(stack, {
    port: PORT,
    feed,
    devControls: true,
    exposeDevKeys: true,
    intervals: { oracle: 3000, orders: 700, positions: 1500, settlement: 1500, executor: 800, reconciler: 3000, events: 700, vault: 2000 },
  });
});

afterAll(async () => {
  await node?.stop();
  await sb?.stop();
});

describe("basis-node automation", () => {
  it("serves stack, markets and dev accounts", async () => {
    const st = await (await fetch(`${API}/api/stack`)).json();
    expect(st.contractId).toBe(stack.contractId);
    expect(st.simulatedVenue).toBe(true);
    const markets = await (await fetch(`${API}/api/markets`)).json();
    expect(markets).toHaveLength(7);
    const accts = await (await fetch(`${API}/api/dev/accounts`)).json();
    expect(accts.map((a: any) => a.role)).toContain("alice");
  });

  it("quote engine returns the contract's own preview and a reprice suggestion", async () => {
    const q = await (await fetch(`${API}/api/quote`, { method: "POST", body: JSON.stringify({ market_id: BTC, outcome_id: 0, margin: (100n * D).toString(), leverage: "50000", max_fee: (1n * D).toString() }) })).json();
    expect(q.preview.entry_price).toBe("500000");
    expect(q.admissible).toBe(false);
    expect(q.reasons.some((r: string) => r.startsWith("FAIR_VALUE"))).toBe(true);
    expect(BigInt(q.suggested_leverage)).toBeLessThan(50_000n);
    expect(q.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("keeper executes a user's POOL_ONLY order and a close request without any manual step", async () => {
    const alice = clientFor(stack, stack.accounts.alice);
    await alice.requestOpen(await intent(BTC, { margin: 100n * D, lev: 50_000n }));
    const pos = await until("position open", async () => (await alice.getPositionsByOwner(stack.accounts.alice.accountId)).find((p) => p.position.state === "Open"));
    expect(pos.position.terms.entry_price).toBe("500000");
    const req = await alice.requestClose(pos.position.position_id, 1_000_000n, 0n, nowNs() + 60_000_000_000n);
    expect(req.value).toBeDefined();
    const closed = await until("closed", async () => {
      const p = await alice.getPosition(pos.position.position_id);
      return p?.position.state === "Closed" ? p : undefined;
    });
    // Closed at the $0.49 executable bid: 100 + 1000*(0.49-0.50) = $90 less close/hold fees.
    expect(BigInt(closed.position.paid_out)).toBeGreaterThan(89n * D);
    expect(BigInt(closed.position.paid_out)).toBeLessThan(90n * D);
  });

  it("mock executor completes the HEDGE_REQUIRED handshake; reconciler sees matching custody", async () => {
    const bob = clientFor(stack, stack.accounts.bob);
    await bob.requestOpen(await intent(ETH, { margin: 100n * D, lev: 50_000n }));
    const pos = await until("hedged position", async () => (await bob.getPositionsByOwner(stack.accounts.bob.accountId)).find((p) => p.position.market_id === ETH && p.position.state === "Open"));
    expect(pos.position.mode).toBe("HedgeRequired");
    expect(pos.position.hedge_fill_ids.length).toBe(1);
    const fills = await bob.getHedgeFills(ETH);
    expect(fills.every((f) => f.simulated)).toBe(true);
    await until("custody returned", async () => (await bob.getVaultSummary()).hedge_custody_cash === "0");
    const rec = await until("reconciliation", async () => {
      const r = await (await fetch(`${API}/api/reconciliation`)).json();
      return r[ETH];
    });
    expect(rec.ok).toBe(true);
  });

  it("keeper fires a take-profit and liquidates a losing position after mock price moves", async () => {
    const carol = clientFor(stack, stack.accounts.carol);
    const bob = clientFor(stack, stack.accounts.bob);
    await carol.requestOpen(await intent(SOL, { margin: 100n * D, lev: 30_000n, take_profit_price: "600000" }));
    await bob.requestOpen(await intent(SOL, { margin: 100n * D, lev: 50_000n, outcome_id: 1 }));
    const [c, b] = await until("both open", async () => {
      const c = (await carol.getPositionsByOwner(stack.accounts.carol.accountId)).find((p) => p.position.market_id === SOL && p.position.state === "Open");
      const b = (await bob.getPositionsByOwner(stack.accounts.bob.accountId)).find((p) => p.position.market_id === SOL && p.position.state === "Open");
      return c && b ? [c, b] : undefined;
    });
    // YES rallies to 0.62: carol's take-profit fires; bob's 5x NO is now deep under water.
    await fetch(`${API}/api/dev/venue`, { method: "POST", body: JSON.stringify({ market_id: SOL, mids: ["625000", "375000"] }) });
    await until("tp closed", async () => (await carol.getPosition(c.position.position_id))?.position.state === "Closed");
    await until("liquidated", async () => (await bob.getPosition(b.position.position_id))?.position.state === "Liquidated");
    expect(node.keeper.stats.triggers).toBeGreaterThanOrEqual(1);
    expect(node.keeper.stats.liquidations).toBeGreaterThanOrEqual(1);
  });

  it("mock resolution -> keeper finalizes after the dispute window and settles every position", async () => {
    const alice = clientFor(stack, stack.accounts.alice);
    await alice.requestOpen(await intent(BTC, { margin: 50n * D, lev: 20_000n }));
    const p = await until("open", async () => (await alice.getPositionsByOwner(stack.accounts.alice.accountId)).find((x) => x.position.market_id === BTC && x.position.state === "Open"));
    // Let the open's unused-fee refund land before taking the baseline balance.
    await until("refund landed", async () => (await alice.getConservation()).in_flight === "0");
    const before = BigInt(await alice.balanceOf(stack.accounts.alice.accountId));
    await fetch(`${API}/api/dev/resolve`, { method: "POST", body: JSON.stringify({ market_id: BTC, scenario: 0 }) });
    const settled = await until("settled", async () => {
      const x = await alice.getPosition(p.position.position_id);
      return x?.position.state === "Settled" ? x : undefined;
    });
    // 2x $50 at $0.50: N=$100, Q=200 units. YES pays M + Q - N = $150 (less cents of holding fee).
    expect(BigInt(settled.position.paid_out)).toBeGreaterThan(149n * D);
    expect(BigInt(settled.position.paid_out)).toBeLessThanOrEqual(150n * D);
    await until("payout transfer landed", async () => (await alice.getConservation()).in_flight === "0");
    expect(BigInt(await alice.balanceOf(stack.accounts.alice.accountId)) - before).toBe(BigInt(settled.position.paid_out));
  });

  it("indexer mirrors onchain events into SQLite and pushes them over the WebSocket", async () => {
    const got: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("message", (m) => got.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    const ev = await until("events", async () => {
      const e = await (await fetch(`${API}/api/events?kind=position_opened&limit=50`)).json();
      return e.length >= 3 ? e : undefined;
    });
    expect(ev[0].data.detail ?? ev[0].data).toBeDefined();
    await until("ws message", async () => got.some((g) => g.type === "mark" || g.type === "vault" || g.type === "event"));
    ws.close();
    const hist = await (await fetch(`${API}/api/vault/history`)).json();
    expect(hist.length).toBeGreaterThan(0);
    const marks = await (await fetch(`${API}/api/markets/${SOL}/marks`)).json();
    expect(marks.length).toBeGreaterThan(0);
    const cons = await until("no transfer in flight", async () => {
      const c = await clientFor(stack).getConservation();
      return c.in_flight === "0" ? c : undefined;
    });
    expect(BigInt(cons.tracked_on_contract)).toBe(BigInt(await clientFor(stack).balanceOf(stack.contractId)));
  });
});
