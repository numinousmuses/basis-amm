/** Wires every service into one process. Exported so tests can run the node in-process. */
import type { DeployedStack } from "@basis/stack";
import { BasisClient } from "@basis/sdk";
import { makeContext, loop } from "./context.js";
import { MockFeed, type Feed } from "./feeds.js";
import { OracleWorker } from "./oracle.js";
import { Keeper } from "./keeper.js";
import { MockExecutor, Reconciler } from "./executor.js";
import { Store } from "./store.js";
import { Indexer } from "./indexer.js";
import { QuoteEngine } from "./quote.js";
import { startApi } from "./api.js";
import { log } from "./log.js";

export interface NodeOptions {
  port?: number;
  dbPath?: string;
  feed?: Feed;
  devControls?: boolean;
  exposeDevKeys?: boolean;
  /** Testnet: push marks only where NAV needs them (gas costs real testnet NEAR). */
  lean?: boolean;
  teeSigner?: import("./tee.js").MarkSigner;
  intervals?: Partial<Record<"oracle" | "orders" | "positions" | "settlement" | "executor" | "reconciler" | "events" | "marks" | "vault", number>>;
}

export async function startNode(stack: DeployedStack, o: NodeOptions = {}) {
  const feed = o.feed ?? new MockFeed();
  if (o.lean) BasisClient.enableViewCache(stack.rpcUrl, 3000);
  const ctx = makeContext(stack, feed);
  ctx.teeSigner = o.teeSigner;
  const store = new Store(o.dbPath ?? ":memory:");
  const oracle = new OracleWorker(ctx, { lean: o.lean, pushEveryMs: 180_000 });
  const keeper = new Keeper(ctx, oracle);
  const executor = new MockExecutor(ctx, oracle, store);
  const reconciler = new Reconciler(ctx, executor);
  const indexer = new Indexer(ctx, store, oracle);
  const quotes = new QuoteEngine(ctx, oracle);
  // Lean (testnet) intervals keep view traffic under public RPC rate limits.
  const base = o.lean
    ? { oracle: 20000, orders: 2500, positions: 15000, settlement: 15000, executor: 4000, reconciler: 60000, events: 5000, marks: 2000, vault: 30000 }
    : { oracle: 5000, orders: 1000, positions: 4000, settlement: 4000, executor: 1500, reconciler: 15000, events: 1500, marks: 1000, vault: 10000 };
  const iv = { ...base, ...o.intervals };
  const err = (svc: string) => (e: unknown) => log("warn", svc, "tick failed", { err: String((e as any)?.message ?? e) });
  await oracle.tick().catch(err("oracle"));
  const loops = [
    loop("oracle", iv.oracle, () => oracle.tick(), err("oracle")),
    loop("orders", iv.orders, () => keeper.tickOrders(), err("keeper")),
    loop("positions", iv.positions, () => keeper.tickPositions(), err("keeper")),
    loop("settlement", iv.settlement, () => keeper.tickSettlement(), err("keeper")),
    loop("executor", iv.executor, () => executor.tick(), err("executor")),
    loop("reconciler", iv.reconciler, () => reconciler.tick(), err("reconciler")),
    loop("events", iv.events, () => indexer.tickEvents(), err("indexer")),
    loop("marks", iv.marks, async () => indexer.tickMarks(), err("indexer")),
    loop("vault", iv.vault, () => indexer.tickVault(), err("indexer")),
  ];
  const server = startApi({ ctx, store, oracle, indexer, keeper, executor, reconciler, quotes, devControls: o.devControls ?? false, exposeDevKeys: o.exposeDevKeys ?? false, cacheTtlMs: o.lean ? 4000 : 0, startedAt: Date.now() }, o.port ?? 8797);
  return {
    ctx,
    store,
    oracle,
    keeper,
    executor,
    reconciler,
    indexer,
    quotes,
    feed,
    async stop() {
      loops.forEach((l) => l.stop());
      await new Promise((r) => server.close(() => r(null)));
    },
  };
}
