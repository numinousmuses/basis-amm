/** Runtime context shared by all services: stack ids, role clients, reporter keys, feed. */
import { BasisClient, ReporterKey } from "@basis/sdk";
import { clientFor, type DeployedStack } from "@basis/stack";
import type { Feed } from "./feeds.js";

export interface NodeContext {
  stack: DeployedStack;
  anon: BasisClient;
  keeper: BasisClient;
  executor: BasisClient;
  markReporter: ReporterKey;
  resolveReporters: ReporterKey[];
  feed: Feed;
  /** Default and per-market feed overrides (e.g. PolymarketFeed for live-token markets). */
  feeds: Map<string, Feed>;
  /** TEE oracle signer for markets with live Polymarket token ids (optional). */
  teeSigner?: import("./tee.js").MarkSigner;
}

export function makeContext(stack: DeployedStack, feed: Feed): NodeContext {
  return {
    stack,
    anon: clientFor(stack),
    keeper: clientFor(stack, stack.accounts.keeper),
    executor: clientFor(stack, stack.accounts.executor),
    markReporter: ReporterKey.fromHex(stack.reporterSecrets.mark),
    resolveReporters: [ReporterKey.fromHex(stack.reporterSecrets.resolveA), ReporterKey.fromHex(stack.reporterSecrets.resolveB)],
    feed,
    feeds: new Map(),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` every `ms`, never overlapping, logging failures without dying. */
export function loop(name: string, ms: number, fn: () => Promise<void>, onError: (e: unknown) => void): { stop(): void } {
  let stopped = false;
  (async () => {
    while (!stopped) {
      const t = Date.now();
      try {
        await fn();
      } catch (e) {
        onError(e);
      }
      await sleep(Math.max(50, ms - (Date.now() - t)));
    }
  })();
  return { stop: () => (stopped = true) };
}
