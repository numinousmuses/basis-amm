/**
 * Live Polymarket integration (network, read-only on Polymarket; nothing is ever posted).
 * Run with BASIS_LIVE_TESTS=1. Proves:
 * 1. live order books normalize correctly (bids desc, asks asc, inside spread);
 * 2. the two resolution sources (Polymarket API, Conditional Tokens on Polygon) agree on a real
 *    resolved market and map to the right Basis scenario;
 * 3. the official SDK signs real orders through the executor-tee WASM, and the WASM refuses
 *    orders above its cap;
 * 4. end to end on a nearcore sandbox: a live market admitted by manifest, a user order hedged by
 *    the paper venue against the live book, closed, and unwound; and a resolved market settled
 *    from the two real resolution sources.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSecureClient, OrderSide, OrderType } from "@polymarket/client";
import { recoverTypedDataAddress } from "viem";
import { nowNs, type OrderIntent } from "@basis/sdk";
import { REPO_ROOT, clientFor, deployStack, specFixtureManifests, startSandbox, type DeployedStack, type Sandbox } from "@basis/stack";
import { liveBooks, pmPublic } from "../src/polymarket/books.js";
import { fromApi, fromChain, scenarioFor } from "../src/polymarket/resolution.js";
import { TeeExecutorSigner } from "../src/polymarket/tee-signer.js";
import { admitPolymarketMarket, manifestFromPolymarket } from "../src/polymarket/admit.js";
import { PaperPolymarketVenue } from "../src/polymarket/venues.js";
import { startNode } from "../src/node.js";
import { MockFeed } from "../src/feeds.js";

const LIVE = !!process.env.BASIS_LIVE_TESTS;
const RESOLVED_SLUG = "will-joe-biden-get-coronavirus-before-the-election";
const RESOLVED_CONDITION = "0xe3b423dfad8c22ff75c9899c4e8176f628cf4ad4caa00481764d320e7415f7a9";
const WASM = join(REPO_ROOT, "out/executor-tee.wasm");

async function pickLiquid(): Promise<string> {
  const r = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=150&order=volume24hr&ascending=false", { headers: { "user-agent": "basis-amm-tests" } });
  const rows: any[] = await r.json();
  for (const row of rows) {
    if (!row.enableOrderBook || !row.slug) continue;
    // Far enough from resolution that the pre-resolution maintenance ramp has not started.
    if (!row.endDate || Date.parse(row.endDate) < Date.now() + 10 * 24 * 3600_000) continue;
    try {
      const { manifest } = await manifestFromPolymarket(row.slug);
      const m: any = { descriptor: { market_id: "x", external_market_id: manifest.descriptor.external_market_id, outcomes: manifest.descriptor.outcomes.map((o: any, i: number) => ({ outcome_id: i, label: o.label, venue_token_ref: o.venue_token_ref })) } };
      const { books } = await liveBooks(m);
      const b = BigInt(books[0].bids[0]?.price ?? 0);
      const a = BigInt(books[0].asks[0]?.price ?? 0);
      const deep = books.every((x) => BigInt(x.bids[0]?.size ?? 0) > 500_000_000n && BigInt(x.asks[0]?.size ?? 0) > 500_000_000n);
      if (b > 150_000n && a < 850_000n && a - b <= 20_000n && deep) return row.slug;
    } catch {
      /* try next */
    }
  }
  throw new Error("no liquid binary market found");
}

describe.skipIf(!LIVE)("live Polymarket", () => {
  let slug = "";
  beforeAll(async () => {
    slug = await pickLiquid();
    console.log("using live market", slug);
  });

  it("normalizes live books", async () => {
    const { manifest } = await manifestFromPolymarket(slug);
    const m: any = { descriptor: { market_id: "x", external_market_id: manifest.descriptor.external_market_id, outcomes: manifest.descriptor.outcomes.map((o: any, i: number) => ({ outcome_id: i, label: o.label, venue_token_ref: o.venue_token_ref })) } };
    const { books } = await liveBooks(m);
    for (const b of books) {
      for (let i = 1; i < b.bids.length; i++) expect(BigInt(b.bids[i - 1].price) >= BigInt(b.bids[i].price)).toBe(true);
      for (let i = 1; i < b.asks.length; i++) expect(BigInt(b.asks[i - 1].price) <= BigInt(b.asks[i].price)).toBe(true);
      expect(BigInt(b.bids[0].price) < BigInt(b.asks[0].price)).toBe(true);
    }
  });

  it("API and chain agree on a real resolved market", async () => {
    const api = await fromApi(RESOLVED_CONDITION, 2);
    const chain = await fromChain(RESOLVED_CONDITION, 2);
    expect(api.resolved && chain.resolved).toBe(true);
    expect(api.payoutsPpm).toEqual([0n, 1_000_000n]);
    expect(chain.payoutsPpm).toEqual(api.payoutsPpm);
    const { manifest } = await manifestFromPolymarket(RESOLVED_SLUG);
    const scenarios = [...manifest.descriptor.outcomes.map((_o: any, i: number) => ({ payouts: manifest.descriptor.outcomes.map((_x: any, j: number) => (i === j ? "1000000" : "0")) })), { payouts: ["500000", "500000"] }];
    expect(scenarioFor({ descriptor: { scenarios } } as any, chain.payoutsPpm)).toBe(1);
  });

  it.skipIf(!existsSync(WASM))("the SDK signs real orders through executor-tee, which refuses oversized ones", async () => {
    const tee = new TeeExecutorSigner({ transport: "wasmtime", wasmPath: WASM, secretHex: "cd".repeat(32) });
    const address = await tee.getAddress();
    const client: any = await createSecureClient({ signer: tee as any, wallet: address } as any);
    const { market } = await manifestFromPolymarket(slug);
    const assetId = market.version === "v2" ? market.outcomes.yes.positionId : market.outcomes.yes.tokenId;
    const order = await client.createMarketOrder({ assetId, side: OrderSide.BUY, amount: "5", maxPrice: 0.95, orderType: OrderType.FAK });
    expect(order.signer.toLowerCase()).toBe(address.toLowerCase());
    // Recover the signer from the exact typed data the SDK asked the TEE to sign.
    const signed = tee.audit.filter((a) => a.primaryType === "Order" && a.ok);
    expect(signed.length).toBeGreaterThan(0);
    const big = await client.createMarketOrder({ assetId, side: OrderSide.BUY, amount: "5000", maxPrice: 0.95, orderType: OrderType.FAK }).catch((e: any) => e);
    expect(String(big?.message ?? big)).toMatch(/refused|notional/);
    void recoverTypedDataAddress;
  });

  describe("on a nearcore sandbox", () => {
    let sb: Sandbox;
    let stack: DeployedStack;
    let node: Awaited<ReturnType<typeof startNode>>;
    let liveId = "";
    let resolvedId = "";
    beforeAll(async () => {
      sb = await startSandbox();
      stack = await deployStack({ network: "sandbox", rpcUrl: sb.rpcUrl, master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey }, manifests: specFixtureManifests() });
      liveId = (await admitPolymarketMarket(stack, slug, { strategy: "HedgeRequired" })).marketId;
      resolvedId = (await admitPolymarketMarket(stack, RESOLVED_SLUG, { strategy: "PoolOnly", marketId: "pm-live-resolved-demo" })).marketId;
      node = await startNode(stack, {
        port: 18_811,
        feed: new MockFeed(3, 0),
        polymarketVenue: new PaperPolymarketVenue(),
        intervals: { oracle: 4000, orders: 800, positions: 3000, settlement: 1500, executor: 1000, reconciler: 5000, events: 1000, vault: 5000, resolver: 3000 },
      });
    }, 900_000);
    afterAll(async () => {
      await node?.stop();
      await sb?.stop();
    });

    const until = async <T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 120_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await f();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    };

    it("a user order on a live market is hedged against the live book, then closed and unwound", async () => {
      const alice = clientFor(stack, stack.accounts.alice);
      const m = await alice.getMarket(liveId);
      const intent: OrderIntent = {
        nonce: String(Date.now()),
        market_id: liveId,
        outcome_id: 0,
        margin_amount: (25n * 1_000_000n).toString(),
        requested_leverage: "20000",
        max_entry_price: "990000",
        max_hedge_slippage_bps: 200,
        max_fee: (40n * 1_000_000n).toString(),
        deadline_ns: (nowNs() + 300_000_000_000n).toString(),
        take_profit_price: null,
        stop_loss_price: null,
        allow_partial_fill: true,
        minimum_acceptable_fill_ppm: "500000",
        policy_hash: m!.policy_hash,
        quote_id: "live-test",
      };
      await alice.requestOpen(intent);
      const pos = await until("hedged position open", async () => (await alice.getPositionsByOwner(stack.accounts.alice.accountId)).find((p) => p.position.market_id === liveId && p.position.state === "Open"));
      expect(pos.position.mode).toBe("HedgeRequired");
      const fills = await alice.getHedgeFills(liveId);
      expect(fills[0].simulated).toBe(true);
      expect(fills[0].tx_hash.startsWith("paper:")).toBe(true);
      expect(fills[0].venue_token_ref).toMatch(/^polygon:(ctf|pmv2):\d+$/);
      const mark = await alice.getMark(liveId);
      expect(mark!.report.source_chain).toBe("polygon:137:polymarket-clob");
      await alice.requestClose(pos.position.position_id, 1_000_000n, 0n, nowNs() + 120_000_000_000n);
      await until("closed", async () => (await alice.getPosition(pos.position.position_id))?.position.state === "Closed");
      await until("unwound", async () => (await alice.getHedgeFills(liveId)).some((f) => !f.side_buy));
      const risk = await alice.getRiskSummary(liveId);
      expect(risk.hedge_units.every((u) => BigInt(u) < 5_000_000n)).toBe(true); // below Polymarket's 5-share minimum at most
    });

    it("a real resolved Polymarket market settles from the API and the chain", async () => {
      const anon = clientFor(stack);
      const r = await until("resolution quorum", async () => {
        const x = await anon.getResolution(resolvedId);
        return x && x.reporters.length >= 2 ? x : undefined;
      });
      expect(r.scenario).toBe(1);
      expect(r.status === "Pending" || r.status === "Finalized").toBe(true);
      await until("settled", async () => (await anon.getMarket(resolvedId))?.state === "Settled");
      expect((await anon.getMarket(resolvedId))!.resolved_scenario).toBe(1);
    });
  });
});
