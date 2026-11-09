import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MarketManifest } from "@basis/sdk";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const POLICY_DIR = join(REPO_ROOT, "policies/examples");

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

export function loadManifest(path: string): MarketManifest {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const ext = raw.extends ? loadManifest(join(dirname(path), raw.extends)) : {};
  const { extends: _e, _comment: _c, ...rest } = raw;
  return deepMerge(ext as MarketManifest, rest);
}

export function loadExampleManifests(dir = POLICY_DIR): Record<string, MarketManifest> {
  const out: Record<string, MarketManifest> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
    const m = loadManifest(join(dir, f));
    out[m.descriptor.market_id] = m;
  }
  return out;
}

/** Spec section 11's demo scenarios are written for 5x positions. The shipped policies cap most
 * markets at 3-4x (docs/decisions.md), so the acceptance suite deploys these fixture markets with
 * a labeled 5x override. Never used outside tests. */
export const SPEC_FIXTURE_5X = ["pm-btc-above-100k-daily", "pm-sol-above-300-weekly", "pm-senate-control-2026", "pm-fed-dec-decision", "pm-eth-above-4k-weekly", "pm-gold-above-3000"];

export function specFixtureManifests(dir = POLICY_DIR): MarketManifest[] {
  return Object.values(loadExampleManifests(dir)).map((m) =>
    SPEC_FIXTURE_5X.includes(m.descriptor.market_id)
      ? deepMerge(m, { policy: { max_leverage: "5", governance_approval: "TEST FIXTURE: 5x override for spec section 11 demo numbers" } })
      : m,
  );
}
