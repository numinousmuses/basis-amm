#!/usr/bin/env tsx
/** NEAR testnet + live Polymarket demo, end to end, recording every transaction.
 *   npx tsx scripts/testnet-polymarket-demo.ts infra/testnet/<name>-stack.secret.json
 * Runs basis-node in-process (lean, paper venue against LIVE Polymarket books), admits a liquid
 * live market (HEDGE_REQUIRED) and a really-resolved market, then: user order -> paper hedge at
 * the live ask -> OPEN -> close -> unwind; resolved market -> votes from the Polymarket API and the
 * Conditional Tokens contract -> finalize -> Settled. Writes docs/integration-proofs/testnet-polymarket.json. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowNs } from "@basis/sdk";
import { EXPLORER_TX, REPO_ROOT, clientFor } from "@basis/stack";
import { startNode } from "../services/basis-node/src/node.js";
import { admitPolymarketMarket, manifestFromPolymarket } from "../services/basis-node/src/polymarket/admit.js";
import { liveBooks } from "../services/basis-node/src/polymarket/books.js";
import { PaperPolymarketVenue } from "../services/basis-node/src/polymarket/venues.js";

const stack = JSON.parse(readFileSync(process.argv[2], "utf8"));
const steps: Array<{ step: string; tx?: string; url?: string; note?: string }> = [];
const rec = (step: string, tx?: string, note?: string) => {
  steps.push({ step, tx, url: tx && !tx.startsWith("paper:") ? EXPLORER_TX(tx) : undefined, note });
  console.log(step.padEnd(60), tx ?? "", note ?? "");
};
const until = async <T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 300_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
};

async function pickLiquid(): Promise<string> {
  const r = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=150&order=volume24hr&ascending=false", { headers: { "user-agent": "basis-amm-demo" } });
  for (const row of (await r.json()) as any[]) {
    if (!row.enableOrderBook || !row.endDate || Date.parse(row.endDate) < Date.now() + 10 * 86400_000) continue;
    try {
      const { manifest } = await manifestFromPolymarket(row.slug);
      const m: any = { descriptor: { market_id: "x", external_market_id: manifest.descriptor.external_market_id, outcomes: manifest.descriptor.outcomes.map((o: any, i: number) => ({ outcome_id: i, label: o.label, venue_token_ref: o.venue_token_ref })) } };
      const { books } = await liveBooks(m);
      const [b, a] = [BigInt(books[0].bids[0]?.price ?? 0), BigInt(books[0].asks[0]?.price ?? 0)];
      if (b > 150_000n && a < 850_000n && a - b <= 20_000n && books.every((x) => BigInt(x.bids[0]?.size ?? 0) > 500_000_000n)) return row.slug;
    } catch {
      /* next */
    }
  }
  throw new Error("no liquid market");
}

const slug = await pickLiquid();
const live = await admitPolymarketMarket(stack, slug, { strategy: "HedgeRequired" });
rec(`admit live market ${slug} (propose)`, live.proposeTx);
rec(`admit live market ${slug} (approve after timelock)`, live.approveTx);
const resolvedSlug = "will-joe-biden-get-coronavirus-before-the-election";
const resolved = await admitPolymarketMarket(stack, resolvedSlug, { strategy: "PoolOnly", marketId: "pm-live-resolved-demo" });
rec(`admit resolved market ${resolvedSlug} (approve)`, resolved.approveTx);

const node = await startNode(stack, { port: 8799, lean: true, polymarketVenue: new PaperPolymarketVenue(), exposeDevKeys: false, intervals: { resolver: 15000, executor: 5000, orders: 3000 } });
const alice = clientFor(stack, stack.accounts.alice);
const m = await alice.getMarket(live.marketId);
const req = await alice.requestOpen({
  nonce: String(Date.now()),
  market_id: live.marketId,
  outcome_id: 0,
  margin_amount: "25000000",
  requested_leverage: "20000",
  max_entry_price: "990000",
  max_hedge_slippage_bps: 200,
  max_fee: "40000000",
  deadline_ns: (nowNs() + 600_000_000_000n).toString(),
  take_profit_price: null,
  stop_loss_price: null,
  allow_partial_fill: true,
  minimum_acceptable_fill_ppm: "500000",
  policy_hash: m!.policy_hash,
  quote_id: "testnet-polymarket-demo",
});
rec("alice signs a 2x $25 YES order (ft_transfer_call)", req.hash);
const pos = await until("hedged position", async () => (await alice.getPositionsByOwner(stack.accounts.alice.accountId)).find((p) => p.position.market_id === live.marketId && p.position.state === "Open"));
const fills = await alice.getHedgeFills(live.marketId);
rec("vault hedged at the live Polymarket ask (paper fill)", fills[0]?.tx_hash, `${Number(fills[0]?.units) / 1e6} shares @ ${Number(fills[0]?.price) / 1e6}`);
rec("position OPEN at the contract's entry price", undefined, `entry ${Number(pos.position.terms.entry_price) / 1e6}, units ${Number(pos.position.terms.units) / 1e6}`);
const close = await alice.requestClose(pos.position.position_id, 1_000_000n, 0n, nowNs() + 300_000_000_000n);
rec("alice requests close", close.hash);
await until("closed", async () => (await alice.getPosition(pos.position.position_id))?.position.state === "Closed");
const closed = await alice.getPosition(pos.position.position_id);
rec("position CLOSED at the live bid", undefined, `paid out $${Number(closed!.position.paid_out) / 1e6}`);
await until("unwound", async () => (await alice.getHedgeFills(live.marketId)).some((f) => !f.side_buy));
const sell = (await alice.getHedgeFills(live.marketId)).find((f) => !f.side_buy)!;
rec("executor unwound the hedge at the live bid (paper fill)", sell.tx_hash, `${Number(sell.units) / 1e6} shares @ ${Number(sell.price) / 1e6}`);
const r = await until("resolution quorum", async () => {
  const x = await alice.getResolution(resolved.marketId);
  return x && x.reporters.length >= 2 ? x : undefined;
});
rec("resolution votes from Polymarket API and CTF contract agree", undefined, `scenario ${r.scenario} (${r.report_ids.join(", ")})`);
await until("settled", async () => (await alice.getMarket(resolved.marketId))?.state === "Settled");
rec("resolved market finalized and Settled", undefined, `resolved_scenario ${(await alice.getMarket(resolved.marketId))!.resolved_scenario}`);
await node.stop();
writeFileSync(join(REPO_ROOT, "docs/integration-proofs/testnet-polymarket.json"), JSON.stringify({ network: "testnet", contract: stack.contractId, live_market: { id: live.marketId, polymarket_slug: slug }, resolved_market: { id: resolved.marketId, polymarket_slug: resolvedSlug }, steps, ran_at: new Date().toISOString(), note: "Hedge fills are PAPER fills computed against the live Polymarket order book; no Polymarket order was placed. NEAR transactions are real testnet transactions." }, null, 2) + "\n");
console.log("done");
process.exit(0);
