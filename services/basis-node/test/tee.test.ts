import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@basis/stack";
import type { Market } from "@basis/sdk";
import { OutlayerSigner, WasmtimeSigner, liveTokenIds, markRequest } from "../src/tee.js";

const market = (refs: string[]): Market =>
  ({
    descriptor: { market_id: "pm-live", outcomes: refs.map((r, i) => ({ outcome_id: i, label: String(i), venue_token_ref: r })) },
  }) as any;

describe("TEE mark signers", () => {
  it("only live CLOB token markets go to the TEE", () => {
    expect(liveTokenIds(market(["polygon:ctf:btc-daily-yes", "polygon:ctf:btc-daily-no"]))).toBeNull();
    const ids = liveTokenIds(market(["polygon:ctf:55115078421062885512", "polygon:ctf:19108300103875659716"]));
    expect(ids).toHaveLength(2);
    expect(markRequest(market(["polygon:ctf:55115078421062885512", "polygon:ctf:19108300103875659716"]), "core.x").outcomes[1].token_id).toBe("19108300103875659716");
  });

  it("OutlayerSigner posts the request, unwraps the signed report and keeps the attestation job id", async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ status: "success", job_id: "job-42", output: JSON.stringify({ ok: true, signed: { report: { report_id: "r1" }, public_key: "pk", signature: "sig" } }) }) };
    }) as any;
    const s = new OutlayerSigner("alice.near/basis-oracle", "alice.near:1:secret", "https://api.example", fake);
    const r = await s.signMark(market(["polygon:ctf:55115078421062885512", "polygon:ctf:19108300103875659716"]), "core.x");
    expect(seen.url).toBe("https://api.example/call/alice.near/basis-oracle");
    expect(seen.headers["X-Payment-Key"]).toBe("alice.near:1:secret");
    expect(seen.body.input.mode).toBe("mark");
    expect(r.public_key).toBe("pk");
    expect(s.attestations.get("r1")).toBe("job-42");
  });

  it("refusals from the program surface as errors (never an unsigned mark)", async () => {
    const fake = (async () => ({ ok: true, json: async () => ({ status: "success", output: { ok: false, error: "SECOND_SOURCE_DIVERGENCE outcome 0" } }) })) as any;
    const s = new OutlayerSigner("a/b", "k", "https://api.example", fake);
    await expect(s.signMark(market(["polygon:ctf:55115078421062885512", "polygon:ctf:19108300103875659716"]), "c")).rejects.toThrow("SECOND_SOURCE_DIVERGENCE");
  });

  const wasm = join(REPO_ROOT, "target/wasm32-wasip2/release/oracle-tee.wasm");
  it.skipIf(!process.env.BASIS_LIVE_TESTS || !existsSync(wasm))("WasmtimeSigner runs the real WASM against live Polymarket", async () => {
    const s = new WasmtimeSigner(wasm, "11".repeat(32));
    const r = await s.signMark(market(["polygon:ctf:55115078421062885512539156303747803058407616201213034911037320915726138659123", "polygon:ctf:1910830010387565971650098373488592514702818137344973088263643820608151819241"]), "core.x");
    expect(r.report.source_chain).toBe("polygon:137:polymarket-clob");
  });
});
