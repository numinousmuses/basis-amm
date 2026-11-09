/** Mapping between Basis-AMM market descriptors and live Polymarket identifiers.
 *
 * venue_token_ref:  `polygon:ctf:<decimal CTF token id>`   (v1 markets, legacy Conditional Tokens)
 *                   `polygon:pmv2:<decimal position id>`   (Polymarket Protocol V2 markets)
 * external_market_id: `polymarket:<v1|v2>:condition:<0x condition id>` */
import type { Market } from "@basis/sdk";

export const REF_RE = /^polygon:(ctf|pmv2):(\d{10,})$/;
export const EXT_RE = /^polymarket:(v1|v2):condition:(0x[0-9a-fA-F]{62,64})$/;

export interface LiveRefs {
  version: "v1" | "v2";
  conditionId: string;
  assetIds: string[];
}

export function liveRefs(m: Market): LiveRefs | null {
  const ext = m.descriptor.external_market_id.match(EXT_RE);
  if (!ext) return null;
  const ids: string[] = [];
  for (const o of m.descriptor.outcomes) {
    const r = o.venue_token_ref.match(REF_RE);
    if (!r) return null;
    ids.push(r[2]);
  }
  return { version: ext[1] as "v1" | "v2", conditionId: ext[2], assetIds: ids };
}

export function isLive(m: Market): boolean {
  return liveRefs(m) !== null;
}

/** Fixed-point helpers between Polymarket decimal strings and Basis 1e6 units. */
export const toMicro = (s: string | number): bigint => {
  const str = typeof s === "number" ? s.toFixed(6) : s;
  const [w, f = ""] = str.split(".");
  return BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6) || "0");
};
export const fromMicro = (v: bigint): string => {
  const w = v / 1_000_000n;
  const f = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
};
