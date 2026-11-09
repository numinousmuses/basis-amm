/** Mark signers backed by the TEE oracle program (crates/oracle-tee).
 *
 * - `OutlayerSigner`: production path. Calls the OutLayer HTTPS API, which runs the pinned WASM on
 *   an attested Intel TDX worker; the program signs with its PROTECTED key. The returned `job_id`
 *   links to the TDX attestation (`https://app.outlayer.ai/attestation/<job_id>`).
 * - `WasmtimeSigner`: development path. Runs the same WASM locally under wasmtime with real HTTP.
 *   Same code, no TEE: a key used this way must never be registered as attested.
 *
 * Both only apply to markets whose outcome refs are live Polymarket CLOB token ids
 * (`polygon:ctf:<decimal id>`); mock-venue markets keep the local dev signer. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Market, SignedReport } from "@basis/sdk";
import { log } from "./log.js";

const run = promisify(execFile);

export interface MarkSigner {
  name: string;
  signMark(m: Market, contractId: string): Promise<SignedReport>;
}

export function liveTokenIds(m: Market): string[] | null {
  const ids = m.descriptor.outcomes.map((o) => o.venue_token_ref.split(":").pop() ?? "");
  return ids.every((t) => /^\d{10,}$/.test(t)) ? ids : null;
}

export function markRequest(m: Market, contractId: string, opts: { maxDivergenceBps?: number; validForS?: number } = {}) {
  const ids = liveTokenIds(m);
  if (!ids) throw new Error(`${m.descriptor.market_id}: outcomes are not live CLOB token ids`);
  return {
    mode: "mark",
    contract_id: contractId,
    market_id: m.descriptor.market_id,
    outcomes: ids.map((token_id, outcome_id) => ({ outcome_id, token_id })),
    tick_size: "10000",
    valid_for_s: opts.validForS ?? 60,
    levels: 5,
    max_divergence_bps: opts.maxDivergenceBps ?? 300,
  };
}

function unwrap(out: any): SignedReport {
  const v = typeof out === "string" ? JSON.parse(out) : out;
  if (!v?.ok) throw new Error(`oracle-tee refused: ${v?.error ?? "no output"}`);
  return v.signed as SignedReport;
}

export class OutlayerSigner implements MarkSigner {
  name = "outlayer-tdx";
  /** job id per report id, for linking each mark to its TDX attestation. */
  attestations = new Map<string, string>();
  constructor(
    readonly project: string,
    readonly paymentKey: string,
    readonly base = "https://api.outlayer.ai",
    readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async signMark(m: Market, contractId: string): Promise<SignedReport> {
    const r = await this.fetchImpl(`${this.base}/call/${this.project}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Payment-Key": this.paymentKey },
      body: JSON.stringify({ input: markRequest(m, contractId) }),
    });
    if (!r.ok) throw new Error(`outlayer HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.status !== "success") throw new Error(`outlayer ${j.status}: ${j.error ?? ""}`);
    const signed = unwrap(j.output);
    if (j.job_id) this.attestations.set(signed.report.report_id, j.job_id);
    log("info", "tee", "outlayer mark", { market: m.descriptor.market_id, job: j.job_id });
    return signed;
  }
}

export class WasmtimeSigner implements MarkSigner {
  name = "wasmtime-dev (no TEE)";
  constructor(
    readonly wasmPath: string,
    readonly secretHex: string,
    readonly wasmtime = process.env.WASMTIME_BIN ?? `${process.env.HOME}/.wasmtime/bin/wasmtime`,
  ) {}
  async signMark(m: Market, contractId: string): Promise<SignedReport> {
    const child = run(this.wasmtime, ["run", "-S", "http", "--env", `PROTECTED_ORACLE_KEY=${this.secretHex}`, this.wasmPath], { maxBuffer: 1 << 20 });
    child.child.stdin?.end(JSON.stringify(markRequest(m, contractId)));
    const { stdout } = await child;
    return unwrap(stdout);
  }
}
