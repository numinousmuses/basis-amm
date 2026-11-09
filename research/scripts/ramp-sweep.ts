import { runFamily, DEFAULTS } from "../src/sim.js";
import { FAMILIES } from "../src/paths.js";
const CAPS: Record<string, number> = { "crypto-daily": 4, "sports-in-play": 3, election: 4, "fed-meeting": 3 };
const SEEDS = [7, 11, 23, 42, 99];
function be(fam: any, ramp: number, frac: number) {
  let tot = 0;
  for (const seed of SEEDS) {
    let lo = 0, hi = 1.5;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const r = runFamily(fam, { ...DEFAULTS, seed, maxLeverage: CAPS[fam.name], floorCoverage: mid, eventsPerFamily: 120, rampMaintenanceBps: ramp, rampFraction: frac });
      if (r.strategies.POOL_ONLY.totalPnl >= 0) hi = mid; else lo = mid;
    }
    tot += hi;
  }
  return tot / SEEDS.length;
}
for (const fam of FAMILIES) {
  const row = [fam.name];
  for (const [ramp, frac] of [[0, 0.2], [2500, 0.2], [5000, 0.2], [5000, 0.4], [8000, 0.4]]) row.push(`${ramp}/${frac}: ${(be(fam, ramp, frac) * 100).toFixed(1)}%`);
  console.log(row.join(" | "));
}
