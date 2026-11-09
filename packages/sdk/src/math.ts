/** TypeScript mirror of `crates/basis-math` (same rounding). Cross-checked against vectors that the
 * Rust crate generates (`crates/basis-math/vectors/vectors.json`). For display and research; the
 * contract remains the authority. */
import { BPS, LEV_SCALE, PPM, PRICE_SCALE, YEAR_NS } from "./units.js";

const mulDivFloor = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivCeil = (a: bigint, b: bigint, d: bigint) => {
  const p = a * b;
  return p % d === 0n ? p / d : p / d + 1n;
};
const pos = (x: bigint) => (x > 0n ? x : 0n);

export interface Terms {
  margin: bigint;
  notional: bigint;
  units: bigint;
  entryPrice: bigint;
  leverage: bigint;
}

export function openTerms(margin: bigint, leverage: bigint, entryPrice: bigint): Terms {
  if (entryPrice <= 0n || entryPrice >= PRICE_SCALE) throw new Error("INVALID_PRICE");
  if (leverage < LEV_SCALE) throw new Error("INVALID_LEVERAGE");
  const notional = mulDivFloor(margin, leverage, LEV_SCALE);
  const units = mulDivFloor(notional, PRICE_SCALE, entryPrice);
  return { margin, notional, units, entryPrice, leverage };
}

export const valueAt = (t: Terms, p: bigint) => mulDivFloor(t.units, p, PRICE_SCALE);
export const rawPnl = (t: Terms, p: bigint) => valueAt(t, p) - t.notional;
export const equity = (t: Terms, p: bigint, fees = 0n) => pos(t.margin + rawPnl(t, p) - fees);
export const profit = (t: Terms, p: bigint, fees = 0n) => equity(t, p, fees) - t.margin;
export const scenarioPnl = (t: Terms, payout: bigint) => {
  const r = rawPnl(t, payout);
  return r < -t.margin ? -t.margin : r;
};
export const maxProfit = (t: Terms, maxPayout = PRICE_SCALE) => pos(rawPnl(t, maxPayout));
export const maxPayout = (t: Terms, maxPay = PRICE_SCALE) => t.margin + maxProfit(t, maxPay);
export const financingBase = (t: Terms) => pos(t.notional - t.margin);

export function liquidationPrice(t: Terms, fees: bigint, maintenanceBps: bigint, maintenanceFixed: bigint): bigint {
  const numer = financingBase(t) + fees + maintenanceFixed;
  const denom = mulDivFloor(t.units, BPS - maintenanceBps, BPS);
  if (denom === 0n) return PRICE_SCALE;
  const x = mulDivFloor(numer, PRICE_SCALE, denom);
  return x > PRICE_SCALE ? PRICE_SCALE : x;
}

export const tickLeverageCeiling = (entry: bigint, tick: bigint, k: bigint) => mulDivFloor(entry, LEV_SCALE, tick * k);
export const openFee = (notional: bigint, bps: bigint) => mulDivCeil(notional, bps, BPS);
export const holdingFee = (base: bigint, aprBps: bigint, elapsedNs: bigint) => mulDivCeil(mulDivCeil(base, aprBps, BPS), elapsedNs, YEAR_NS);

export function impliedProbabilities(weights: bigint[]): bigint[] {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new Error("DIV_ZERO");
  const out = weights.map((w) => mulDivFloor(w, PPM, total));
  const assigned = out.reduce((a, b) => a + b, 0n);
  let idx = 0;
  weights.forEach((w, i) => {
    if (w > weights[idx]) idx = i;
  });
  out[idx] += PPM - assigned;
  return out;
}

export function holdToResolutionEv(t: Terms, payouts: bigint[], probsPpm: bigint[]): bigint {
  let gain = 0n;
  let loss = 0n;
  payouts.forEach((p, i) => {
    const v = scenarioPnl(t, p);
    if (v >= 0n) gain += v * probsPpm[i];
    else loss += -v * probsPpm[i];
  });
  return gain >= loss ? (gain - loss + PPM - 1n) / PPM : -((loss - gain) / PPM);
}

export const requiredRiskPremium = (ev: bigint, coverageBps: bigint) => mulDivCeil(pos(ev), coverageBps, BPS);

export function lpLoss(trader: bigint[], hedge: bigint[], costs = 0n): bigint {
  let w = 0n;
  trader.forEach((t, i) => {
    const v = pos(t - hedge[i] + costs);
    if (v > w) w = v;
  });
  return w;
}

export const VIRTUAL = 1_000_000n;
export const sharesForDeposit = (amount: bigint, supply: bigint, nav: bigint) => mulDivFloor(amount, supply + VIRTUAL, nav + VIRTUAL);
export const assetsForShares = (shares: bigint, supply: bigint, nav: bigint) => mulDivFloor(shares, nav + VIRTUAL, supply + VIRTUAL);
