/** Turn a live Polymarket market into a Basis-AMM manifest and admit it through governance
 * (propose, wait out the timelock, approve). Data only: no contract code knows about it. */
import { join } from "node:path";
import { manifestToChain, type MarketManifest } from "@basis/sdk";
import { POLICY_DIR, clientFor, deepMerge, loadManifest, type DeployedStack } from "@basis/stack";
import { pmPublic } from "./books.js";

export type Family = "crypto" | "sports" | "election" | "macro";

/** Leverage cap, floor coverage and ramp per family (docs/decisions.md). */
export const FAMILY_POLICY: Record<Family, { max_leverage: string; floor_coverage_bps: number; maintenance_ramp_s: number; max_spread_bps: number }> = {
  crypto: { max_leverage: "4", floor_coverage_bps: 1000, maintenance_ramp_s: 36000, max_spread_bps: 800 },
  election: { max_leverage: "4", floor_coverage_bps: 2500, maintenance_ramp_s: 604800, max_spread_bps: 800 },
  sports: { max_leverage: "3", floor_coverage_bps: 5000, maintenance_ramp_s: 5400, max_spread_bps: 1200 },
  macro: { max_leverage: "3", floor_coverage_bps: 1500, maintenance_ramp_s: 604800, max_spread_bps: 800 },
};

export function guessFamily(m: any): Family {
  const text = `${m.category ?? ""} ${m.question ?? ""} ${(m.tags ?? []).map((t: any) => t.label ?? t).join(" ")}`.toLowerCase();
  if (/\b(btc|bitcoin|eth|ethereum|sol|solana|crypto|xrp|doge)\b/.test(text)) return "crypto";
  if (/\b(nba|nfl|mlb|nhl|soccer|football|tennis|ufc|match|game|vs\.?)\b/.test(text)) return "sports";
  if (/\b(fed|fomc|rate|cpi|inflation|gdp|jobs|recession)\b/.test(text)) return "macro";
  return "election";
}

export async function manifestFromPolymarket(slug: string, opts: { family?: Family; strategy?: "PoolOnly" | "PoolPlusHedge" | "HedgeRequired"; marketId?: string } = {}): Promise<{ manifest: MarketManifest; market: any }> {
  const m: any = await pmPublic().fetchMarket({ slug } as any);
  if (!m?.outcomes?.yes || !m?.outcomes?.no) throw new Error(`${slug}: only binary yes/no markets are supported by this builder`);
  const v2 = m.version === "v2";
  const ref = (o: any) => (v2 ? `polygon:pmv2:${o.positionId}` : `polygon:ctf:${o.tokenId}`);
  const family = opts.family ?? guessFamily(m);
  const fp = FAMILY_POLICY[family];
  const base = loadManifest(join(POLICY_DIR, "_base.json"));
  const end = m.resolution?.endDate ?? m.endDate ?? m.state?.endDate;
  const expected = end && Date.parse(end) > Date.now() ? new Date(end).toISOString() : "now+604800";
  const manifest = deepMerge(base, {
    descriptor: {
      market_id: opts.marketId ?? `pm-live-${String(m.id)}`.slice(0, 64),
      external_market_id: `polymarket:${v2 ? "v2" : "v1"}:condition:${m.conditionId}`,
      underlying_event: m.question,
      category_label: m.category ?? family,
      outcomes: [
        { label: (m.outcomes.yes.label ?? "Yes").toUpperCase(), venue_token_ref: ref(m.outcomes.yes) },
        { label: (m.outcomes.no.label ?? "No").toUpperCase(), venue_token_ref: ref(m.outcomes.no) },
      ],
      invalid_scenario: { label: "UNKNOWN / 50-50", payouts: ["0.5", "0.5"] },
      resolution_adapter_id: "uma-ctf-resolution@1",
      resolution_source: `Polymarket UMA resolution for condition ${m.conditionId} (https://polymarket.com/event/${m.slug})`,
      expected_resolution: expected,
    },
    policy: {
      strategy: opts.strategy ?? "HedgeRequired",
      executor_adapter_id: "polymarket-clob@1",
      pricing_adapter_id: "polymarket-clob-mark@1",
      max_leverage: fp.max_leverage,
      max_spread_bps: fp.max_spread_bps,
      maintenance_ramp_s: fp.maintenance_ramp_s,
      hedge_budget_bps: 1500,
      fees: { floor_coverage_bps: fp.floor_coverage_bps },
      event_windows: [{ label: "Final hour before resolution", start: "res-3600", end: "res", mode: "CloseOnly" }],
      governance_approval: `admitted from live Polymarket data (${family} family policy)`,
      human_readable_rules: `Live Polymarket market ${m.slug}. Marks from the live CLOB book; hedges are exact outcome shares on Polymarket. Max ${fp.max_leverage}x. Risk premium covers ${fp.floor_coverage_bps / 100}% of the hold-to-resolution floor value. Settles on Polymarket's resolved payout vector, read from the resolution API and the chain.`,
    },
  } as any);
  return { manifest, market: m };
}

export async function admitPolymarketMarket(stack: DeployedStack, slug: string, opts: Parameters<typeof manifestFromPolymarket>[1] = {}) {
  const { manifest, market } = await manifestFromPolymarket(slug, opts);
  const admin = clientFor(stack, stack.accounts.admin);
  const risk = clientFor(stack, stack.accounts.risk);
  const adapters = await admin.getAdapters();
  for (const a of [manifest.policy.executor_adapter_id, manifest.policy.pricing_adapter_id, manifest.descriptor.resolution_adapter_id, manifest.policy.risk_model_id]) {
    if (!adapters.includes(a)) await admin.registerAdapter(a);
  }
  const { descriptor, policy } = manifestToChain(manifest);
  const r = await admin.proposeMarket(descriptor, policy);
  const cfg = await admin.getConfig();
  await new Promise((res) => setTimeout(res, Number(BigInt(cfg.policy_timelock_ns) / 1_000_000n) + 1500));
  const a = await risk.approvePolicy(Number(r.value));
  return { marketId: descriptor.market_id, manifest, polymarket: market, proposeTx: r.hash, approveTx: a.hash };
}
