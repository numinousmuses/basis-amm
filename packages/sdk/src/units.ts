/** Fixed-point conventions shared with `crates/basis-math`. All values are bigint. */
export const USD = 1_000_000n;
export const PRICE_SCALE = 1_000_000n;
export const UNIT = 1_000_000n;
export const BPS = 10_000n;
export const LEV_SCALE = 10_000n;
export const PPM = 1_000_000n;
export const YEAR_NS = 365n * 24n * 3600n * 1_000_000_000n;
export const NS_PER_MS = 1_000_000n;

export const usd = (dollars: number | string): bigint => decimalToFixed(String(dollars), 6);
export const price = (p: number | string): bigint => decimalToFixed(String(p), 6);
export const lev = (x: number | string): bigint => decimalToFixed(String(x), 4);
export const nowNs = (): bigint => BigInt(Date.now()) * NS_PER_MS;

/** Parse a decimal string into a fixed-point bigint with `decimals` places (truncating). */
export function decimalToFixed(s: string, decimals: number): bigint {
  const neg = s.trim().startsWith("-");
  const [w, f = ""] = s.trim().replace(/^-/, "").split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -v : v;
}

/** Format a fixed-point bigint as a decimal string. */
export function fixedToDecimal(v: bigint, decimals: number, maxFrac = decimals): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const w = a / base;
  let f = (a % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${w.toLocaleString("en-US")}${f ? "." + f : ""}`;
}

export const fmtUsd = (v: bigint | string, maxFrac = 2): string => {
  const b = BigInt(v);
  const s = fixedToDecimal(b < 0n ? -b : b, 6, maxFrac);
  const [w, f = ""] = s.split(".");
  const frac = maxFrac > 0 ? "." + f.padEnd(maxFrac, "0") : "";
  return `${b < 0n ? "-" : ""}$${w}${frac}`;
};
export const fmtPrice = (v: bigint | string): string => `$${fixedToDecimal(BigInt(v), 6, 4).padEnd(4, "0")}`;
export const fmtLev = (v: bigint | string): string => `${fixedToDecimal(BigInt(v), 4, 2)}x`;
export const fmtUnits = (v: bigint | string): string => fixedToDecimal(BigInt(v), 6, 2);
export const fmtPpm = (v: bigint | string): string => `${fixedToDecimal(BigInt(v) * 100n, 6, 2)}%`;
