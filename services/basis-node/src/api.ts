/** REST + WebSocket read API for the dashboard and workers (spec section 4.9 and 9). Writes are
 * never accepted here on behalf of users: the UI prepares wallet transactions and the user signs.
 * `/api/dev/*` routes exist only when dev controls are enabled (sandbox / labeled testnet demo). */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { resolutionReport, nowNs, manifestToChain } from "@basis/sdk";
import { loadExampleManifests } from "@basis/stack";
import type { NodeContext } from "./context.js";
import type { Store } from "./store.js";
import type { Indexer } from "./indexer.js";
import type { Keeper } from "./keeper.js";
import type { MockExecutor, Reconciler } from "./executor.js";
import type { QuoteEngine } from "./quote.js";
import type { OracleWorker } from "./oracle.js";
import type { PolymarketResolver } from "./polymarket/resolution.js";
import { createPublicClient as pmClient } from "@polymarket/client";
import { admitPolymarketMarket } from "./polymarket/admit.js";
import { MockFeed, discoverPolymarket } from "./feeds.js";
import { log } from "./log.js";

export interface ApiDeps {
  ctx: NodeContext;
  store: Store;
  indexer: Indexer;
  keeper: Keeper;
  executor: MockExecutor;
  reconciler: Reconciler;
  quotes: QuoteEngine;
  oracle: OracleWorker;
  resolver: PolymarketResolver;
  devControls: boolean;
  exposeDevKeys: boolean;
  cacheTtlMs?: number;
  startedAt: number;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

export function startApi(d: ApiDeps, port: number) {
  const { ctx, store } = d;
  /** Newer of the onchain stored mark and the worker's latest signed (not yet pushed) mark. */
  const freshest = (id: string, onchain: any) => {
    const off = d.oracle.latest.get(id);
    const onTs = onchain ? BigInt(onchain.report.source_timestamp_ns) : 0n;
    if (off && BigInt(off.report.source_timestamp_ns) > onTs) {
      return { mark: { report: off.report, reporter: off.public_key, stored_ns: "0" }, mark_source: "signed-offchain" };
    }
    return { mark: onchain, mark_source: onchain ? "onchain" : null };
  };
  const routes: Array<[string, RegExp, (m: RegExpMatchArray, req: IncomingMessage, url: URL) => Promise<unknown>]> = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, uptime_s: Math.round((Date.now() - d.startedAt) / 1000), keeper: d.keeper.stats, last_seq: store.lastSeq() })],
    [
      "GET",
      /^\/api\/stack$/,
      async () => ({
        network: ctx.stack.network,
        rpcUrl: ctx.stack.rpcUrl,
        contractId: ctx.stack.contractId,
        tokenId: ctx.stack.tokenId,
        roles: await ctx.anon.getRoles(),
        devControls: d.devControls,
        quoteKey: d.quotes.publicKey,
        markReporter: ctx.markReporter.publicKeyHex,
        simulatedVenue: true,
      }),
    ],
    [
      "GET",
      /^\/api\/markets$/,
      async () => {
        const markets = await ctx.anon.getMarkets();
        return Promise.all(
          markets.map(async (m) => {
            const id = m.descriptor.market_id;
            const [mark, actions, risk, policy] = await Promise.all([ctx.anon.getMark(id), ctx.anon.getEffectiveActions(id), ctx.anon.getRiskSummary(id), m.policy_hash ? ctx.anon.getPolicy(m.policy_hash) : null]);
            const dayAgo = store.marks(id, Date.now() - 24 * 3600_000, 1)[0];
            return { market: m, ...freshest(id, mark), actions, risk, policy, mid_24h_ago: dayAgo?.mids ?? null };
          }),
        );
      },
    ],
    [
      "GET",
      /^\/api\/markets\/([^/]+)$/,
      async (m) => {
        const id = decodeURIComponent(m[1]);
        const market = await ctx.anon.getMarket(id);
        if (!market) throw new HttpError(404, "UNKNOWN_MARKET");
        const [mark, actions, risk, policy, history, resolution, fills] = await Promise.all([
          ctx.anon.getMark(id),
          ctx.anon.getEffectiveActions(id),
          ctx.anon.getRiskSummary(id),
          ctx.anon.getPolicy(market.policy_hash),
          ctx.anon.getPolicyHistory(id),
          ctx.anon.getResolution(id),
          ctx.anon.getHedgeFills(id),
        ]);
        return { market, ...freshest(id, mark), actions, risk, policy, policy_history: history, resolution, hedge_fills: fills };
      },
    ],
    ["GET", /^\/api\/markets\/([^/]+)\/marks$/, async (m, _r, u) => store.marks(decodeURIComponent(m[1]), Number(u.searchParams.get("since") ?? Date.now() - 6 * 3600_000), Number(u.searchParams.get("limit") ?? 500))],
    ["GET", /^\/api\/markets\/([^/]+)\/positions$/, async (m) => ctx.anon.getOpenPositions(decodeURIComponent(m[1]))],
    ["GET", /^\/api\/policies\/([0-9a-f]+)$/, async (m) => ctx.anon.getPolicy(m[1])],
    ["GET", /^\/api\/vault$/, async () => ({ summary: await ctx.anon.getVaultSummary(), conservation: await ctx.anon.getConservation(), config: await ctx.anon.getConfig(), pause: await ctx.anon.getPause(), queued: await ctx.anon.getQueuedWithdrawals() })],
    ["GET", /^\/api\/vault\/history$/, async (_m, _r, u) => store.vault(Number(u.searchParams.get("since") ?? Date.now() - 24 * 3600_000))],
    ["GET", /^\/api\/events$/, async (_m, _r, u) => store.events(Number(u.searchParams.get("from") ?? 0), Number(u.searchParams.get("limit") ?? 100), u.searchParams.get("kind") ?? undefined)],
    [
      "GET",
      /^\/api\/accounts\/([^/]+)$/,
      async (m) => {
        const a = decodeURIComponent(m[1]);
        const [positions, orders, withdrawals, claimable, usdc, blp] = await Promise.all([
          ctx.anon.getPositionsByOwner(a),
          ctx.anon.getOrdersByOwner(a),
          ctx.anon.getWithdrawalsByOwner(a),
          ctx.anon.getClaimable(a),
          ctx.anon.balanceOf(a).catch(() => "0"),
          ctx.anon.blpBalanceOf(a).catch(() => "0"),
        ]);
        return { account: a, positions, orders, withdrawals, claimable, usdc, blp };
      },
    ],
    ["POST", /^\/api\/quote$/, async (_m, req) => d.quotes.quote(await body(req))],
    ["GET", /^\/api\/reconciliation$/, async () => Object.fromEntries(d.reconciler.lastReport)],
    ["GET", /^\/api\/executor\/fills$/, async () => store.fills()],
    [
      "GET",
      /^\/api\/polymarket\/status$/,
      async () => {
        const venue = d.executor.polymarketVenue;
        const signer: any = (venue as any)?.o?.signer;
        return {
          venue: venue?.name ?? null,
          simulated: venue?.simulated ?? true,
          executor_address: signer?.getAddress ? await signer.getAddress().catch(() => null) : null,
          signer_audit: signer?.audit?.slice(-20) ?? [],
          spent_today_usd: store.spentToday(),
          caps: venue && !venue.simulated ? { max_order_usd: (venue as any).o.maxOrderUsd, max_daily_usd: (venue as any).o.maxDailyUsd } : null,
          resolutions: Object.fromEntries(d.resolver.last),
          custody: Object.fromEntries([...d.executor.custody].map(([k, v]) => [k, v.map(String)])),
        };
      },
    ],
    [
      "GET",
      /^\/api\/polymarket\/market\/([^/]+)$/,
      async (m) => {
        const c: any = pmClient();
        return c.fetchMarket({ slug: decodeURIComponent(m[1]) });
      },
    ],
    ["GET", /^\/api\/manifests$/, async () => Object.values(loadExampleManifests()).map((m) => ({ manifest: m, chain: manifestToChain(m) }))],
    ["GET", /^\/api\/polymarket\/discover$/, async (_m, _r, u) => discoverPolymarket(Number(u.searchParams.get("limit") ?? 20))],
    [
      "GET",
      /^\/api\/dev\/accounts$/,
      async () => {
        if (!d.exposeDevKeys) throw new HttpError(403, "dev keys are only exposed on the local sandbox");
        const pick = ["alice", "bob", "carol", "lp", "admin", "risk", "guardian"] as const;
        return pick.map((r) => ({ role: r, ...ctx.stack.accounts[r] }));
      },
    ],
    [
      "POST",
      /^\/api\/dev\/venue$/,
      async (_m, req) => {
        if (!d.devControls) throw new HttpError(403, "dev controls disabled");
        const b = await body(req);
        const feed = ctx.feeds.get(b.market_id) ?? ctx.feed;
        if (!(feed instanceof MockFeed)) throw new HttpError(400, "market is not on the mock venue");
        if (b.clear) feed.clear(b.market_id);
        else feed.set(b.market_id, { mids: b.mids?.map((x: string) => BigInt(x)), status: b.status });
        log("info", "api", "mock venue override", { market: b.market_id, mids: b.mids, status: b.status });
        return { ok: true, label: "MOCK VENUE CONTROL: simulated prices, not a real market" };
      },
    ],
    [
      "POST",
      /^\/api\/dev\/admit-polymarket$/,
      async (_m, req) => {
        if (!d.devControls) throw new HttpError(403, "dev controls disabled");
        const b = await body(req);
        const r = await admitPolymarketMarket(ctx.stack, String(b.slug), { family: b.family, strategy: b.strategy });
        return { ok: true, market_id: r.marketId, propose_tx: r.proposeTx, approve_tx: r.approveTx, polymarket_slug: r.polymarket.slug };
      },
    ],
    [
      "POST",
      /^\/api\/dev\/resolve$/,
      async (_m, req) => {
        if (!d.devControls) throw new HttpError(403, "dev controls disabled");
        const b = await body(req);
        const out = [];
        for (const k of ctx.resolveReporters) {
          const r = resolutionReport({ marketId: b.market_id, scenario: Number(b.scenario), sourceTsNs: nowNs(), status: b.status ?? "Resolved", sourceChain: "mock-venue:uma-ctf-sim", attestationRef: "basis-node@0.1:unattested-dev" });
          out.push((await ctx.keeper.submitResolution(k.sign(ctx.stack.contractId, r))).hash);
        }
        const feed = ctx.feeds.get(b.market_id) ?? ctx.feed;
        if (feed instanceof MockFeed) feed.set(b.market_id, { status: b.status ?? "Resolved" });
        return { ok: true, txs: out, label: "MOCK RESOLUTION: simulated venue outcome" };
      },
    ],
  ];

  // Short-TTL cache for GET reads: many dashboard tabs polling must not multiply RPC load.
  const cache = new Map<string, { at: number; body: Promise<unknown> }>();
  const ttlMs = d.cacheTtlMs ?? 0;
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) {
        try {
          if (method === "GET" && ttlMs > 0 && !url.pathname.startsWith("/api/dev")) {
            const key = url.pathname + url.search;
            const hit = cache.get(key);
            if (hit && Date.now() - hit.at < ttlMs) return json(res, 200, await hit.body);
            const body = handler(m, req, url);
            cache.set(key, { at: Date.now(), body });
            body.catch(() => cache.delete(key));
            return json(res, 200, await body);
          }
          return json(res, 200, await handler(m, req, url));
        } catch (e: any) {
          const code = e instanceof HttpError ? e.code : 500;
          return json(res, code, { error: String(e?.message ?? e) });
        }
      }
    }
    json(res, 404, { error: "not found" });
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  d.indexer.listeners.add((msg) => {
    const s = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(s);
  });
  server.listen(port);
  log("info", "api", "listening", { port });
  return server;
}

export class HttpError extends Error {
  constructor(
    readonly code: number,
    msg: string,
  ) {
    super(msg);
  }
}
