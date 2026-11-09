/** `@polymarket/client` Signer backed by the executor-tee program (crates/executor-tee).
 *
 * The private key never exists in this process. Every signature request goes to the WASM, which
 * signs only ClobAuth for itself and bounded Order payloads on allowlisted exchanges. Transport:
 * - `wasmtime`: local development, same binary, no TEE (never authorize that key on real funds);
 * - `outlayer`: production, the OutLayer HTTPS API running the pinned WASM on Intel TDX workers. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TeeSignerOptions {
  transport: "wasmtime" | "outlayer";
  wasmPath?: string;
  secretHex?: string; // wasmtime only (stands in for the PROTECTED secret)
  outlayerProject?: string;
  outlayerPaymentKey?: string;
  depositWallet?: string;
  limits?: { max_notional?: string; max_price_ppm?: string; min_price_ppm?: string; token_ids?: string[] };
  fetchImpl?: typeof fetch;
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class TeeExecutorSigner {
  private address?: string;
  readonly audit: Array<{ at: string; primaryType: string; ok: boolean; error?: string }> = [];
  constructor(readonly o: TeeSignerOptions) {}

  async call(input: Record<string, unknown>): Promise<any> {
    if (this.o.transport === "wasmtime") {
      const bin = process.env.WASMTIME_BIN ?? `${process.env.HOME}/.wasmtime/bin/wasmtime`;
      const child = run(bin, ["run", "--env", `PROTECTED_EXECUTOR_KEY=${this.o.secretHex}`, this.o.wasmPath!], { maxBuffer: 1 << 20 });
      child.child.stdin?.end(toJson(input));
      return JSON.parse((await child).stdout);
    }
    const f = this.o.fetchImpl ?? fetch;
    const r = await f(`https://api.outlayer.ai/call/${this.o.outlayerProject}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Payment-Key": this.o.outlayerPaymentKey ?? "" },
      body: toJson({ input }),
    });
    const j: any = await r.json();
    if (j.status !== "success") throw new Error(`outlayer ${j.status}: ${j.error ?? ""}`);
    return typeof j.output === "string" ? JSON.parse(j.output) : j.output;
  }

  async getAddress(): Promise<any> {
    if (!this.address) {
      const r = await this.call({ mode: "address" });
      if (!r.ok) throw new Error(r.error);
      this.address = r.address;
    }
    return this.address;
  }

  async signTypedData(payload: any): Promise<any> {
    const r = await this.call({ mode: "sign_typed_data", payload, deposit_wallet: this.o.depositWallet, limits: this.o.limits, now_ms: String(Date.now()) });
    this.audit.push({ at: new Date().toISOString(), primaryType: payload?.primaryType, ok: !!r.ok, error: r.error });
    if (!r.ok) throw new Error(`executor-tee refused: ${r.error}`);
    return r.signature;
  }

  async signMessage(): Promise<any> {
    throw new Error("executor-tee refused: message signing is not allowed");
  }

  async sendTransaction(): Promise<any> {
    throw new Error("executor-tee refused: the executor never sends transactions");
  }
}
