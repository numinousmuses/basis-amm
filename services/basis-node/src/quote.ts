/** Quote engine: wraps the contract's own `preview_open` (single source of truth for the math),
 * adds a reprice suggestion (highest leverage that passes the fair-price gate within the user's
 * fee budget and vault capacity) and signs an expiring indicative quote. Quotes never bind the
 * contract: execution re-prices at a mark observed after the user's commit. */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { LEV_SCALE, type OpenPreview } from "@basis/sdk";
import type { NodeContext } from "./context.js";
import type { OracleWorker } from "./oracle.js";

export interface QuoteRequest {
  market_id: string;
  outcome_id: number;
  margin: string;
  leverage: string;
  max_fee?: string;
}

export interface Quote {
  quote_id: string;
  expires_ms: number;
  preview: OpenPreview;
  total_upfront_fee: string;
  admissible: boolean;
  reasons: string[];
  suggested_leverage: string | null;
  signature: string;
  quote_key: string;
}

export class QuoteEngine {
  private secret = ed25519.utils.randomPrivateKey();
  readonly publicKey = bytesToHex(ed25519.getPublicKey(this.secret));
  constructor(
    readonly ctx: NodeContext,
    readonly oracle?: OracleWorker,
  ) {}

  async quote(q: QuoteRequest): Promise<Quote> {
    // Lean mode: make sure the contract holds a recent mark so preview_open is not stale.
    if (this.oracle?.opts.lean) {
      const m = await this.ctx.anon.getMarket(q.market_id);
      if (m) await this.oracle.ensureOnchain(m, 60_000).catch(() => {});
    }
    const margin = BigInt(q.margin);
    const lev = BigInt(q.leverage);
    const pv = await this.ctx.anon.previewOpen(q.market_id, q.outcome_id, margin, lev);
    const fee = BigInt(pv.open_fee) + BigInt(pv.risk_premium);
    const reasons = [...pv.reasons];
    const maxFee = q.max_fee ? BigInt(q.max_fee) : null;
    if (maxFee !== null && fee > maxFee) reasons.push(`FAIR_VALUE: upfront ${fee} exceeds max_fee ${maxFee}`);
    const admissible = pv.actions.open && reasons.length === 0;
    let suggested: bigint | null = null;
    if (!admissible) {
      const cap = [BigInt(pv.policy_max_leverage), BigInt(pv.protocol_max_leverage), BigInt(pv.tick_leverage_ceiling), lev].reduce((a, b) => (a < b ? a : b));
      for (let l = cap; l >= LEV_SCALE; l -= LEV_SCALE / 10n) {
        const p = await this.ctx.anon.previewOpen(q.market_id, q.outcome_id, margin, l);
        const f = BigInt(p.open_fee) + BigInt(p.risk_premium);
        if ((maxFee === null || f <= maxFee) && BigInt(p.admissible_fill_ppm) === 1_000_000n && !p.reasons.some((r) => r.startsWith("RISK_LIMIT"))) {
          suggested = l;
          break;
        }
      }
    }
    const expires = Date.now() + 15_000;
    const body = JSON.stringify({ q, entry: pv.entry_price, fee: fee.toString(), policy: pv.policy_hash, expires });
    const digest = sha256(new TextEncoder().encode(body));
    return {
      quote_id: `q-${bytesToHex(digest).slice(0, 24)}`,
      expires_ms: expires,
      preview: pv,
      total_upfront_fee: fee.toString(),
      admissible,
      reasons,
      suggested_leverage: suggested?.toString() ?? null,
      signature: bytesToHex(ed25519.sign(digest, this.secret)),
      quote_key: this.publicKey,
    };
  }
}
