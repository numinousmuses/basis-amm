#!/usr/bin/env tsx
/** Runs the strategy comparison and writes research/out/report.{json,md}. Optionally replays real
 * Polymarket price history (read-only chart bars, not depth): `--polymarket <tokenId>`. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, STRATEGIES, runAll, runFamily } from "./sim.js";
import { FAMILIES, polymarketHistory, type Family } from "./paths.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "../out");
mkdirSync(out, { recursive: true });
const cfg = { ...DEFAULTS };
const reports = runAll(cfg);

const args = process.argv.slice(2);
const pmIdx = args.indexOf("--polymarket");
if (pmIdx >= 0) {
  const token = args[pmIdx + 1];
  const hist = await polymarketHistory(token);
  if (hist.length > 10) {
    // Calibrate a family from the real series' step volatility and jump frequency.
    const logit = (p: number) => Math.log(Math.min(0.99, Math.max(0.01, p)) / (1 - Math.min(0.99, Math.max(0.01, p))));
    const d = hist.slice(1).map((p, i) => logit(p) - logit(hist[i]));
    const sd = Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length);
    const jumps = d.filter((x) => Math.abs(x) > 3 * sd).length / d.length;
    const fam: Family = { name: `polymarket:${token.slice(0, 10)}`, steps: hist.length, vol: sd, jumpRate: jumps, jumpSize: 4 * sd, haltRate: 0 };
    reports.push(runFamily(fam, cfg));
  }
}

const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
let md = `# Strategy simulation (synthetic paths)\n\nSeed ${cfg.seed}, ${cfg.eventsPerFamily} events x ${cfg.tradersPerEvent} traders per family, vault ${usd(cfg.vaultUsd)}, keeper every ${cfg.keeperEvery} step, floor coverage ${cfg.floorCoverage * 100}%.\nPaths are synthetic logit random walks with jumps. Chart-only replays of real markets have no executable depth; no production cap should be derived from this.\n\n`;
for (const r of reports) {
  md += `## ${r.family}\n\n${r.trades} trades. Bankruptcies (equity below zero at liquidation) ${r.bankruptciesPer10k.toFixed(1)} per 10k, mean shortfall ${usd(r.meanShortfallWhenBankrupt)}. Trader EV per trade ${usd(r.traderEvPerTrade)}, win rate ${(r.traderWinRate * 100).toFixed(1)}%, ${r.tradersBeatingMargin} traders made more than 100% of margin.\nExits: ${Object.entries(r.exits).map(([k, v]) => `${k} ${v}`).join(", ")}.\nFees: open ${usd(r.fees.open)}, risk premium ${usd(r.fees.premium)}, holding ${usd(r.fees.hold)}, close ${usd(r.fees.close)}.\n\n| Strategy | LP P&L | Mean per event | Worst event loss | CVaR95 | CVaR99 | Peak capital per event |\n|---|---|---|---|---|---|---|\n`;
  for (const s of STRATEGIES) {
    const x = r.strategies[s];
    md += `| ${s} | ${usd(x.totalPnl)} | ${usd(x.meanEventPnl)} | ${usd(x.worstEventLoss)} | ${usd(x.cvar95)} | ${usd(x.cvar99)} | ${usd(x.peakCapitalPerEvent)} |\n`;
  }
  md += "\n";
}
writeFileSync(join(out, "report.json"), JSON.stringify({ config: cfg, reports }, null, 2));
writeFileSync(join(out, "report.md"), md);
console.log(md);

// Floor-coverage sweep: LP P&L for POOL_ONLY as the fair-value premium covers more of the
// hold-to-resolution floor value. This is the input to the section 14 fee decision.
const sweep = [0.05, 0.1, 0.25, 0.5, 0.75, 1.0];
let sm = "\n## Floor-coverage sweep (POOL_ONLY LP P&L, all families)\n\n| Coverage | " + reports.slice(0, 4).map((r) => r.family).join(" | ") + " |\n|---|" + reports.slice(0, 4).map(() => "---").join("|") + "|\n";
const sweepOut: Record<string, Record<string, number>> = {};
for (const cov of sweep) {
  const rs = runAll({ ...cfg, floorCoverage: cov });
  sweepOut[cov] = Object.fromEntries(rs.map((r) => [r.family, r.strategies.POOL_ONLY.totalPnl]));
  sm += `| ${cov * 100}% | ${rs.map((r) => usd(r.strategies.POOL_ONLY.totalPnl)).join(" | ")} |\n`;
}
writeFileSync(join(out, "report.md"), md + sm);
writeFileSync(join(out, "sweep.json"), JSON.stringify(sweepOut, null, 2));
console.log(sm);

// Calibration: per family, the break-even floor coverage for POOL_ONLY LPs under the recommended
// leverage cap, averaged over five seeds, plus a 25% buffer rounded up to 5%. The recommendation is
// then checked on every seed. Input to `floor_coverage_bps` and `max_leverage` (docs/decisions.md).
const CAPS: Record<string, number> = { "crypto-daily": 4, "sports-in-play": 3, election: 4, "fed-meeting": 3 };
const SEEDS = [7, 11, 23, 42, 99];
function breakeven(fam: (typeof FAMILIES)[number], seed: number): number {
  let lo = 0;
  let hi = 1.5;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const r = runFamily(fam, { ...cfg, seed, maxLeverage: CAPS[fam.name], floorCoverage: mid, eventsPerFamily: 120, rampMaintenanceBps: 5000, rampFraction: 0.4 });
    if (r.strategies.POOL_ONLY.totalPnl >= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}
const rec: Record<string, unknown> = {};
let rm = "\n## Calibrated leverage cap and floor coverage\n\nWith the pre-resolution maintenance ramp (losers only, to 50% over the final 40% of each market). Break-even averaged over 5 seeds, +25% buffer, rounded up to 5%; then re-run on every seed.\n\n| Family | Leverage cap | Mean break-even | Worst seed | Recommended | Seeds with LP profit | Mean LP P&L | Trader EV per trade |\n|---|---|---|---|---|---|---|---|\n";
for (const fam of FAMILIES) {
  const bs = SEEDS.map((sd) => breakeven(fam, sd));
  const mean = bs.reduce((a, b) => a + b, 0) / bs.length;
  const recBps = Math.ceil((mean * 1.25 * 100) / 5) * 5 * 100;
  const runs = SEEDS.map((sd) => runFamily(fam, { ...cfg, seed: sd, maxLeverage: CAPS[fam.name], floorCoverage: recBps / 10_000, rampMaintenanceBps: 5000, rampFraction: 0.4 }));
  const wins = runs.filter((r) => r.strategies.POOL_ONLY.totalPnl > 0).length;
  const lp = runs.reduce((a, r) => a + r.strategies.POOL_ONLY.totalPnl, 0) / runs.length;
  const tev = runs.reduce((a, r) => a + r.traderEvPerTrade, 0) / runs.length;
  rec[fam.name] = { leverage_cap: CAPS[fam.name], breakeven_by_seed: bs, recommended_bps: recBps, seeds_profitable: wins, mean_lp_pnl: lp, trader_ev_per_trade: tev };
  rm += `| ${fam.name} | ${CAPS[fam.name]}x | ${(mean * 100).toFixed(1)}% | ${(Math.max(...bs) * 100).toFixed(1)}% | ${recBps / 100}% | ${wins}/5 | ${usd(lp)} | ${usd(tev)} |\n`;
}
writeFileSync(join(out, "recommended.json"), JSON.stringify(rec, null, 2));
writeFileSync(join(out, "report.md"), md + sm + rm);
console.log(rm);
