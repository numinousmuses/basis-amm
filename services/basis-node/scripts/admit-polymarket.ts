#!/usr/bin/env tsx
/** Admit a live Polymarket market onto a deployed stack (sandbox or testnet).
 *   npx tsx scripts/admit-polymarket.ts --stack <deployment.json> --slug <polymarket slug> [--family crypto|sports|election|macro] [--strategy HedgeRequired|PoolPlusHedge|PoolOnly]
 *   npx tsx scripts/admit-polymarket.ts --discover 20      # list liquid live markets */
import { readFileSync } from "node:fs";
import { admitPolymarketMarket } from "../src/polymarket/admit.js";
import { pmPublic } from "../src/polymarket/books.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (opt("discover")) {
  const page: any = await pmPublic().listMarkets({ closed: false, pageSize: Number(opt("discover")) } as any).firstPage();
  for (const m of page.items) console.log(`${m.slug.padEnd(70)} ${m.version} yes=${m.outcomes?.yes?.price} ${m.category ?? ""}`);
  process.exit(0);
}
const stack = JSON.parse(readFileSync(opt("stack")!, "utf8"));
const r = await admitPolymarketMarket(stack, opt("slug")!, { family: opt("family") as any, strategy: opt("strategy") as any });
console.log(JSON.stringify({ marketId: r.marketId, proposeTx: r.proposeTx, approveTx: r.approveTx, polymarket: `https://polymarket.com/market/${r.polymarket.slug}` }, null, 2));
process.exit(0);
