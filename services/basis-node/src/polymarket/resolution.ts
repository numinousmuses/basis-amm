/** Real resolution reader for live Polymarket markets, from two independent sources:
 *  A. Polymarket's resolution API (`fetchResolutions`: status, payout vector, resolving tx);
 *  B. the chain itself: Conditional Tokens `payoutDenominator` / `payoutNumerators` read over a
 *     Polygon RPC (v1 markets). For v2 markets the API is the only implemented source.
 * Each source is signed by a different resolution reporter key, so the contract's quorum of two
 * only reaches agreement when the API and the chain agree; a mismatch lands in `Disputed`. */
import { createPublicClient as viemPublic, http, parseAbi, type Hex } from "viem";
import { polygon } from "viem/chains";
import { nowNs, resolutionReport, type Market } from "@basis/sdk";
import { pmPublic } from "./books.js";
import { liveRefs } from "./refs.js";
import type { NodeContext } from "../context.js";
import { log } from "../log.js";

export const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const ctfAbi = parseAbi(["function payoutDenominator(bytes32) view returns (uint256)", "function payoutNumerators(bytes32, uint256) view returns (uint256)"]);

export interface Observed {
  source: string;
  resolved: boolean;
  payoutsPpm: bigint[];
  evidence: string;
}

export const RPCS = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://1rpc.io/matic"];

export async function fromApi(conditionId: string, outcomes: number): Promise<Observed> {
  const rows: any[] = await pmPublic().fetchResolutions({ conditionIds: [conditionId] } as any);
  const r = rows[0];
  if (!r || r.status !== "resolved" || !Array.isArray(r.payouts)) return { source: "polymarket-api", resolved: false, payoutsPpm: [], evidence: r?.status ?? "none" };
  const nums = r.payouts.map((p: string) => Number(p));
  const total = nums.reduce((a: number, b: number) => a + b, 0) || 1;
  const ppm = nums.slice(0, outcomes).map((x: number) => BigInt(Math.round((x / total) * 1_000_000)));
  return { source: "polymarket-api", resolved: true, payoutsPpm: ppm, evidence: `${r.transactionHash ?? ""}@${r.resolvedBlock ?? ""}` };
}

export async function fromChain(conditionId: string, outcomes: number, rpc = RPCS[0]): Promise<Observed> {
  const c = viemPublic({ chain: polygon, transport: http(rpc) });
  const den = await c.readContract({ address: CTF, abi: ctfAbi, functionName: "payoutDenominator", args: [conditionId as Hex] });
  if (den === 0n) return { source: `ctf@${rpc}`, resolved: false, payoutsPpm: [], evidence: "payoutDenominator=0" };
  const ppm: bigint[] = [];
  for (let i = 0; i < outcomes; i++) {
    const n = await c.readContract({ address: CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [conditionId as Hex, BigInt(i)] });
    ppm.push((n * 1_000_000n) / den);
  }
  const block = await c.getBlockNumber();
  return { source: `ctf@${rpc}`, resolved: true, payoutsPpm: ppm, evidence: `payoutDenominator=${den} at block ${block}` };
}

/** Index of the descriptor scenario whose payout vector equals the observed one, if any. */
export function scenarioFor(m: Market, payoutsPpm: bigint[]): number | null {
  const i = m.descriptor.scenarios.findIndex((s) => s.payouts.length === payoutsPpm.length && s.payouts.every((p, j) => BigInt(p) === payoutsPpm[j]));
  return i >= 0 ? i : null;
}

export class PolymarketResolver {
  submitted = new Set<string>();
  last = new Map<string, { api?: Observed; chain?: Observed; at: string }>();
  constructor(readonly ctx: NodeContext) {}

  async check(m: Market) {
    const refs = liveRefs(m);
    if (!refs || ["Settled", "Invalid", "Unlisted"].includes(m.state)) return;
    const id = m.descriptor.market_id;
    const n = m.descriptor.outcomes.length;
    const api = await fromApi(refs.conditionId, n).catch((e) => ({ source: "polymarket-api", resolved: false, payoutsPpm: [], evidence: String(e?.message ?? e) }) as Observed);
    let chain: Observed | undefined;
    if (refs.version === "v1") {
      for (const rpc of RPCS) {
        chain = await fromChain(refs.conditionId, n, rpc).catch(() => undefined);
        if (chain) break;
      }
    }
    this.last.set(id, { api, chain, at: new Date().toISOString() });
    const sources: Array<[Observed | undefined, number]> = [[api, 0], [chain, 1]];
    for (const [obs, idx] of sources) {
      if (!obs?.resolved) continue;
      const key = `${id}:${idx}`;
      if (this.submitted.has(key)) continue;
      const scenario = scenarioFor(m, obs.payoutsPpm);
      if (scenario === null) {
        log("warn", "resolver", "payout vector matches no scenario", { market: id, payouts: obs.payoutsPpm.map(String) });
        continue;
      }
      const invalid = obs.payoutsPpm.every((p) => p === obs.payoutsPpm[0]);
      const report = resolutionReport({
        marketId: id,
        scenario,
        sourceTsNs: nowNs(),
        status: invalid ? "Invalid" : "Resolved",
        sourceChain: idx === 0 ? "polygon:137:polymarket-resolution-api" : "polygon:137:conditional-tokens",
        provenance: obs,
        attestationRef: `${obs.source}:${obs.evidence}`.slice(0, 200),
      });
      const signer = this.ctx.resolveReporters[idx];
      try {
        const r = await this.ctx.keeper.submitResolution(signer.sign(this.ctx.stack.contractId, report));
        this.submitted.add(key);
        log("info", "resolver", "resolution vote", { market: id, source: obs.source, scenario, tx: r.hash });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("DUPLICATE_RESOLUTION_VOTE") || msg.includes("ALREADY_SETTLED")) this.submitted.add(key);
        else log("warn", "resolver", "vote failed", { market: id, err: msg });
      }
    }
  }

  async tick() {
    for (const m of await this.ctx.anon.getMarkets()) if (liveRefs(m)) await this.check(m);
  }
}
