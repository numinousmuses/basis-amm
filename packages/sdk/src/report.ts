/** Oracle report encoding and signing, byte-identical to `oracle::report_digest` in the contract. */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { BorshWriter } from "./borsh.js";
import type { OracleReport, SignedReport } from "./types.js";

const KIND = { Mark: 0, Risk: 1, FinalResolution: 2 } as const;
const STATUS = { Open: 0, Paused: 1, Closed: 2, Resolved: 3, Invalid: 4 } as const;

export function encodeReport(r: OracleReport): Uint8Array {
  const w = new BorshWriter();
  w.u8(KIND[r.kind]);
  w.string(r.report_id).string(r.market_id).string(r.source_chain);
  w.u64(r.observed_block).u64(r.source_timestamp_ns).u64(r.fetch_timestamp_ns).u64(r.valid_until_ns);
  w.vec(r.outcomes, (w, o) => {
    w.u8(o.outcome_id);
    w.vec(o.bids, (w, l) => w.u128(l.price).u128(l.size));
    w.vec(o.asks, (w, l) => w.u128(l.price).u128(l.size));
  });
  w.u32(r.fee_schedule_version);
  w.u128(r.tick_size);
  w.u8(STATUS[r.market_status]);
  w.option(r.final_scenario, (w, s) => w.u8(s));
  w.string(r.source_hash).string(r.attestation_ref);
  return w.bytes();
}

export function reportDigest(contractId: string, r: OracleReport): Uint8Array {
  const prefix = new TextEncoder().encode("BASIS_AMM_ORACLE_V1");
  const acct = new TextEncoder().encode(contractId);
  const body = encodeReport(r);
  const msg = new Uint8Array(prefix.length + acct.length + body.length);
  msg.set(prefix, 0);
  msg.set(acct, prefix.length);
  msg.set(body, prefix.length + acct.length);
  return sha256(msg);
}

/** An oracle reporter key. In production this lives inside an attested worker (OutLayer/TEE). */
export class ReporterKey {
  readonly secret: Uint8Array;
  readonly publicKeyHex: string;
  constructor(secret: Uint8Array) {
    if (secret.length !== 32) throw new Error("reporter secret must be 32 bytes");
    this.secret = secret;
    this.publicKeyHex = bytesToHex(ed25519.getPublicKey(secret));
  }
  static fromHex(hex: string) {
    return new ReporterKey(hexToBytes(hex));
  }
  static random() {
    return new ReporterKey(ed25519.utils.randomPrivateKey());
  }
  /** Deterministic key from a label, for sandbox and tests only. */
  static fromSeed(seed: string) {
    return new ReporterKey(sha256(new TextEncoder().encode(`basis-amm-dev-reporter:${seed}`)));
  }
  sign(contractId: string, report: OracleReport): SignedReport {
    const sig = ed25519.sign(reportDigest(contractId, report), this.secret);
    return { report, public_key: this.publicKeyHex, signature: bytesToHex(sig) };
  }
}

export function verifySignedReport(contractId: string, s: SignedReport): boolean {
  return ed25519.verify(hexToBytes(s.signature), reportDigest(contractId, s.report), hexToBytes(s.public_key));
}

export function sourceHash(payload: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(payload))));
}
