/** Strategy simulator for spec section 11 "Historical backtesting and simulation".
 *
 * Every trader holds a nonrecourse synthetic claim (loss floored at -M, no profit cap). The vault
 * is the counterparty. We compare, on identical paths and traders:
 *   POOL_ONLY       vault holds cash reserves, no hedge
 *   EXACT_HEDGE     vault buys Q exact outcome shares at entry, sells/redeems on exit
 *   MARGIN_ESCROW   same exposure financed as a margin loan (old model A): P&L equals
 *                   EXACT_HEDGE, capital usage differs (N - M locked per trade)
 *   PROXY_HEDGE     vault hedges with a correlated proxy that matches the event outcome with
 *                   probability `proxyMatch` (basis risk)
 * Floats are fine here: this is research, not accounting. `test/sim.test.ts` cross-checks the
 * per-trade payoff against the fixed-point SDK math the contract uses. */
import { FAMILIES, mulberry32, simulatePath, type Family, type Path } from "./paths.js";

export interface SimConfig {
  seed: number;
  eventsPerFamily: number;
  tradersPerEvent: number;
  vaultUsd: number;
  stepMinutes: number;
  spread: number;
  openBps: number;
  closeBps: number;
  holdApr: number;
  maintenanceBps: number;
  maintenanceFixed: number;
  floorCoverage: number;
  keeperEvery: number;
  proxyMatch: number;
  maxLeverage: number;
  minAdverseTicks: number;
}

export const DEFAULTS: SimConfig = {
  seed: 7,
  eventsPerFamily: 200,
  tradersPerEvent: 50,
  vaultUsd: 100_000,
  stepMinutes: 5,
  spread: 0.01,
  openBps: 10,
  closeBps: 10,
  holdApr: 0.1,
  maintenanceBps: 500,
  maintenanceFixed: 1,
  floorCoverage: 0.05,
  keeperEvery: 1,
  proxyMatch: 0.8,
  maxLeverage: 5,
  minAdverseTicks: 10,
};

export const STRATEGIES = ["POOL_ONLY", "EXACT_HEDGE", "MARGIN_ESCROW", "PROXY_HEDGE"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface TradeResult {
  family: string;
  margin: number;
  leverage: number;
  entry: number;
  units: number;
  exit: "resolution" | "liquidation" | "take_profit" | "stop_loss" | "voluntary";
  payout: number;
  bankrupt: boolean;
  shortfall: number;
  fees: { open: number; premium: number; hold: number; close: number };
  vaultPnl: Record<Strategy, number>;
  maxProfit: number;
  capital: Record<Strategy, number>;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Simulate one trader on one path. Side: buy YES (outcome 1) or NO (outcome 0). */
export function simulateTrade(path: Path, fam: Family, c: SimConfig, r: () => number): TradeResult {
  const n = path.prices.length;
  const t0 = Math.floor(r() * (n - 2) * 0.6);
  const yes = r() < 0.5;
  const px = (t: number) => (yes ? path.prices[t] : 1 - path.prices[t]);
  const half = c.spread / 2;
  const entry = clamp(px(t0) + half, 0.02, 0.98);
  const tickCap = entry / (c.minAdverseTicks * 0.01);
  const lev = clamp(1 + r() * (c.maxLeverage - 1), 1, Math.min(c.maxLeverage, tickCap));
  const margin = Math.round(20 + Math.exp(3.5 + r() * 1.5));
  const notional = margin * lev;
  const units = notional / entry;
  const maxProfit = Math.max(0, units - notional);
  const mid = px(t0);
  const ev = mid * maxProfit - (1 - mid) * margin; // hold-to-resolution EV, floored at -M
  const fees = { open: (notional * c.openBps) / 10_000, premium: Math.max(0, ev) * c.floorCoverage, hold: 0, close: 0 };
  const tp = r() < 0.3 ? entry + (1 - entry) * (0.3 + 0.5 * r()) : null;
  const sl = r() < 0.3 ? entry * (0.6 + 0.3 * r()) : null;
  const voluntaryHazard = 0.004;
  const yearFrac = c.stepMinutes / (365 * 24 * 60);
  let exitT = n - 1;
  let exit: TradeResult["exit"] = "resolution";
  for (let t = t0 + 1; t < n - 1; t++) {
    fees.hold += (notional - margin) * c.holdApr * yearFrac;
    const bid = clamp(px(t) - half, 0, 1);
    const halted = path.halted[t];
    const equity = margin + units * (bid - entry) - fees.hold;
    const maint = units * bid * (c.maintenanceBps / 10_000) + c.maintenanceFixed;
    const keeperCanAct = !halted && (t - t0) % c.keeperEvery === 0;
    if (keeperCanAct && equity <= maint) {
      exitT = t;
      exit = "liquidation";
      break;
    }
    if (!halted && tp !== null && bid >= tp) {
      exitT = t;
      exit = "take_profit";
      break;
    }
    if (!halted && sl !== null && bid <= sl) {
      exitT = t;
      exit = "stop_loss";
      break;
    }
    if (!halted && r() < voluntaryHazard) {
      exitT = t;
      exit = "voluntary";
      break;
    }
  }
  const exitPx = exit === "resolution" ? px(n - 1) : clamp(px(exitT) - half, 0, 1);
  const gross = margin + units * (exitPx - entry);
  const shortfall = Math.max(0, -gross);
  const beforeFees = Math.max(0, gross);
  const holdCollected = Math.min(fees.hold, beforeFees);
  fees.hold = holdCollected;
  fees.close = exit === "resolution" ? 0 : Math.min((units * exitPx * c.closeBps) / 10_000, beforeFees - holdCollected);
  const payout = beforeFees - holdCollected - fees.close;
  const upfront = fees.open + fees.premium;
  // Vault cash P&L: receives margin + upfront fees, pays out `payout` (hold/close fees retained).
  const pool = margin + upfront - payout;
  // Exact hedge: buy Q at the entry ask (= entry), sell at the exit bid (= exitPx) or redeem.
  const exact = pool + units * (exitPx - entry);
  // Proxy: a correlated instrument that tracks the mark but resolves the same way only `proxyMatch` of the time.
  const proxyOutcome = exit === "resolution" ? (r() < c.proxyMatch ? px(n - 1) : 1 - px(n - 1)) : clamp(exitPx + (r() - 0.5) * 0.05, 0, 1);
  const proxy = pool + units * (proxyOutcome - entry);
  return {
    family: fam.name,
    margin,
    leverage: lev,
    entry,
    units,
    exit,
    payout,
    bankrupt: shortfall > 0,
    shortfall,
    fees,
    vaultPnl: { POOL_ONLY: pool, EXACT_HEDGE: exact, MARGIN_ESCROW: exact, PROXY_HEDGE: proxy },
    maxProfit,
    // Capital the vault must lock: full reserve, share purchase cost, or the loan principal.
    capital: { POOL_ONLY: maxProfit, EXACT_HEDGE: notional, MARGIN_ESCROW: notional - margin, PROXY_HEDGE: notional },
  };
}

export interface StrategyStats {
  totalPnl: number;
  meanEventPnl: number;
  worstEventLoss: number;
  cvar95: number;
  cvar99: number;
  peakCapitalPerEvent: number;
  lpReturnOnVault: number;
}

export interface FamilyReport {
  family: string;
  trades: number;
  bankruptciesPer10k: number;
  meanShortfallWhenBankrupt: number;
  exits: Record<string, number>;
  traderEvPerTrade: number;
  traderWinRate: number;
  tradersBeatingMargin: number;
  fees: { open: number; premium: number; hold: number; close: number };
  strategies: Record<Strategy, StrategyStats>;
}

function cvar(losses: number[], q: number) {
  const s = [...losses].sort((a, b) => b - a);
  const k = Math.max(1, Math.floor(s.length * (1 - q)));
  return s.slice(0, k).reduce((a, b) => a + b, 0) / k;
}

export function runFamily(fam: Family, c: SimConfig): FamilyReport {
  const r = mulberry32(c.seed + fam.name.length * 1009);
  const trades: TradeResult[] = [];
  const eventPnl: Record<Strategy, number[]> = { POOL_ONLY: [], EXACT_HEDGE: [], MARGIN_ESCROW: [], PROXY_HEDGE: [] };
  const eventCap: Record<Strategy, number[]> = { POOL_ONLY: [], EXACT_HEDGE: [], MARGIN_ESCROW: [], PROXY_HEDGE: [] };
  for (let e = 0; e < c.eventsPerFamily; e++) {
    const path = simulatePath(fam, r);
    const sums: Record<Strategy, number> = { POOL_ONLY: 0, EXACT_HEDGE: 0, MARGIN_ESCROW: 0, PROXY_HEDGE: 0 };
    const caps: Record<Strategy, number> = { POOL_ONLY: 0, EXACT_HEDGE: 0, MARGIN_ESCROW: 0, PROXY_HEDGE: 0 };
    for (let k = 0; k < c.tradersPerEvent; k++) {
      const t = simulateTrade(path, fam, c, r);
      trades.push(t);
      for (const s of STRATEGIES) {
        sums[s] += t.vaultPnl[s];
        caps[s] += t.capital[s];
      }
    }
    for (const s of STRATEGIES) {
      eventPnl[s].push(sums[s]);
      eventCap[s].push(caps[s]);
    }
  }
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  const bankrupt = trades.filter((t) => t.bankrupt);
  const fees = trades.reduce((a, t) => ({ open: a.open + t.fees.open, premium: a.premium + t.fees.premium, hold: a.hold + t.fees.hold, close: a.close + t.fees.close }), { open: 0, premium: 0, hold: 0, close: 0 });
  const strategies = Object.fromEntries(
    STRATEGIES.map((s) => {
      const pnl = eventPnl[s];
      const losses = pnl.map((x) => -x);
      const total = pnl.reduce((a, b) => a + b, 0);
      return [
        s,
        {
          totalPnl: total,
          meanEventPnl: total / pnl.length,
          worstEventLoss: Math.max(0, ...losses),
          cvar95: Math.max(0, cvar(losses, 0.95)),
          cvar99: Math.max(0, cvar(losses, 0.99)),
          peakCapitalPerEvent: Math.max(...eventCap[s]),
          lpReturnOnVault: total / c.vaultUsd,
        },
      ];
    }),
  ) as Record<Strategy, StrategyStats>;
  return {
    family: fam.name,
    trades: trades.length,
    bankruptciesPer10k: (bankrupt.length / trades.length) * 10_000,
    meanShortfallWhenBankrupt: bankrupt.length ? bankrupt.reduce((a, t) => a + t.shortfall, 0) / bankrupt.length : 0,
    exits,
    traderEvPerTrade: trades.reduce((a, t) => a + (t.payout - t.margin - t.fees.open - t.fees.premium), 0) / trades.length,
    traderWinRate: trades.filter((t) => t.payout > t.margin + t.fees.open + t.fees.premium).length / trades.length,
    tradersBeatingMargin: trades.filter((t) => t.payout - t.margin > t.margin).length,
    fees,
    strategies,
  };
}

export function runAll(c: SimConfig = DEFAULTS, families = FAMILIES): FamilyReport[] {
  return families.map((f) => runFamily(f, c));
}
