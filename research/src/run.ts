#!/usr/bin/env tsx
/** Runs the strategy comparison and writes research/out/report.{json,md}. Optionally replays real
 * Polymarket price history (read-only chart bars, not depth): `--polymarket <tokenId>`. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, STRATEGIES, runAll, runFamily } from "./sim.js";
import { polymarketHistory, type Family } from "./paths.js";

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
