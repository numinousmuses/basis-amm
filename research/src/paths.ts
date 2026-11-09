/** Synthetic event price paths. A binary claim's price is a martingale in [0,1] that ends at the
 * resolved payout. We simulate a logit random walk with Poisson jumps whose size and frequency
 * depend on the event family, then force the terminal jump to 0 or 1 drawn from the final price
 * (so the mark is an unbiased probability). Real markets also gap; this is what liquidation,
 * reserves and the floor premium must survive. */
export interface Family {
  name: string;
  steps: number;
  vol: number;
  jumpRate: number;
  jumpSize: number;
  /** fraction of steps that are illiquid (keeper cannot act) */
  haltRate: number;
}

export const FAMILIES: Family[] = [
  { name: "crypto-daily", steps: 288, vol: 0.06, jumpRate: 0.01, jumpSize: 0.8, haltRate: 0.0 },
  { name: "sports-in-play", steps: 240, vol: 0.05, jumpRate: 0.03, jumpSize: 1.2, haltRate: 0.05 },
  { name: "election", steps: 400, vol: 0.02, jumpRate: 0.004, jumpSize: 1.5, haltRate: 0.0 },
  { name: "fed-meeting", steps: 300, vol: 0.01, jumpRate: 0.0, jumpSize: 0.0, haltRate: 0.0 },
];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface Path {
  family: string;
  prices: number[];
  halted: boolean[];
  outcome: 0 | 1;
}

export function simulatePath(f: Family, r: () => number, p0 = 0.2 + 0.6 * r()): Path {
  let x = logit(p0);
  const prices = [p0];
  const halted = [false];
  for (let t = 1; t < f.steps; t++) {
    x += f.vol * gaussian(r);
    if (r() < f.jumpRate) x += (r() < 0.5 ? -1 : 1) * f.jumpSize * (0.5 + r());
    if (f.name === "fed-meeting" && t === f.steps - 20) x += gaussian(r) * 2.5; // announcement
    const p = Math.min(0.99, Math.max(0.01, sigmoid(x)));
    prices.push(Math.round(p * 100) / 100);
    halted.push(r() < f.haltRate);
  }
  const last = prices[prices.length - 1];
  const outcome: 0 | 1 = r() < last ? 1 : 0;
  prices.push(outcome);
  halted.push(false);
  return { family: f.name, prices, halted, outcome };
}

/** Read-only replay of real Polymarket price history (chart bars, not executable depth). */
export async function polymarketHistory(tokenId: string, fidelityMin = 60): Promise<number[]> {
  const r = await fetch(`https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=${fidelityMin}`, { headers: { "user-agent": "basis-amm-research/0.1" } });
  if (!r.ok) throw new Error(`prices-history HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.history ?? []).map((h: any) => Number(h.p));
}
