/**
 * TEE oracle wiring on a real nearcore sandbox.
 *
 * The real `oracle-tee` program (crates/oracle-tee, run here as a native binary with injected
 * books) produces the public key and signed marks. A labeled SANDBOX-ONLY mock of `outlayer.near`
 * stands in for the TDX worker network: it returns program output only for the pinned WASM hash.
 * What this proves: the contract registers a reporter as attested only via the OutLayer callback
 * for the pinned hash, rejects unattested marks once required, and trades on TEE-signed marks.
 * What it does not prove: TDX execution itself (that is OutLayer's attestation, docs/tee-oracle.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { TGAS, nowNs, type SignedReport } from "@basis/sdk";
import { REPO_ROOT, deployStack, specFixtureManifests, startSandbox, type Sandbox } from "@basis/stack";
import { Ctx, D, LEV, expectFailure, sleep } from "../src/ctx.js";

const SECRET = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const WASM_PATH = join(REPO_ROOT, "target/wasm32-wasip2/release/oracle-tee.wasm");
// Pin the hash of the actual release build when present (scripts/build-oracle-tee.sh).
const WASM_HASH = existsSync(WASM_PATH) ? createHash("sha256").update(readFileSync(WASM_PATH)).digest("hex") : "ab".repeat(32);
const BIN = join(REPO_ROOT, "target/debug/oracle-tee");
const BTC = "pm-btc-above-100k-daily";

function runTee(input: unknown): any {
  const out = execFileSync(BIN, { input: JSON.stringify(input), env: { ...process.env, PROTECTED_ORACLE_KEY: SECRET } }).toString();
  return JSON.parse(out);
}

function teeMark(contractId: string, yesBid: number, yesAsk: number): SignedReport {
  const book = (b: number, a: number) => ({ bids: [[b.toFixed(2), "100000"], [(b - 0.01).toFixed(2), "100000"]], asks: [[a.toFixed(2), "100000"], [(a + 0.01).toFixed(2), "100000"]] });
  const r = runTee({
    mode: "mark",
    contract_id: contractId,
    market_id: BTC,
    outcomes: [{ outcome_id: 0, token_id: "1" }, { outcome_id: 1, token_id: "2" }],
    books: [{ outcome_id: 0, ...book(yesBid, yesAsk) }, { outcome_id: 1, ...book(1 - yesAsk, 1 - yesBid) }],
    reference_prices: [((yesBid + yesAsk) / 2).toFixed(3), (1 - (yesBid + yesAsk) / 2).toFixed(3)],
    now_ns: Number(nowNs() / 1_000_000n) * 1_000_000,
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.signed;
}

let sb: Sandbox;
let x: Ctx;
let outlayerId: string;

beforeAll(async () => {
  sb = await startSandbox();
  const stack = await deployStack({
    network: "sandbox",
    rpcUrl: sb.rpcUrl,
    master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey },
    manifests: specFixtureManifests(),
  });
  x = new Ctx(stack);
  // Sandbox-only stand-in for outlayer.near.
  const provider = new JsonRpcProvider({ url: sb.rpcUrl });
  const root = new Account(sb.rootAccountId, provider, sb.rootSecretKey as any);
  const kp = KeyPair.fromRandom("ed25519");
  outlayerId = `outlayer.${sb.rootAccountId}`;
  await root.createAccount({ newAccountId: outlayerId, publicKey: kp.getPublicKey().toString(), nearToTransfer: 5n * 10n ** 24n } as any);
  const ol = new Account(outlayerId, provider, kp.toString() as any);
  await ol.deployContract(readFileSync(join(REPO_ROOT, "out/mock_outlayer.wasm")));
  await ol.callFunctionRaw({ contractId: outlayerId, methodName: "new", args: { owner: outlayerId }, gas: 30n * TGAS });
  const pubOut = runTee({ mode: "pubkey" });
  await ol.callFunctionRaw({ contractId: outlayerId, methodName: "set_output", args: { wasm_hash: WASM_HASH, mode: "pubkey", output: JSON.stringify(pubOut) }, gas: 30n * TGAS });
  x.venue.set(BTC, { mids: [495_000n, 505_000n] });
  await x.pushMarks([BTC]);
});

afterAll(async () => sb?.stop());

describe("TEE oracle (OutLayer) integration", () => {
  it("an admin cannot self-declare a reporter as attested", async () => {
    await x.c.admin.registerReporter({ public_key: "aa".repeat(32), label: "claims-tee", can_mark: true, can_resolve: false, attestation_measurement: "tdx:fake", active: true, tee_attested: true });
    const r = (await x.c.anon.getReporters()).find((r) => r.label === "claims-tee")!;
    expect(r.tee_attested).toBe(false);
  });

  it("timelocked config pins the oracle WASM hash and requires attested marks", async () => {
    const cfg = await x.c.anon.getConfig();
    await expectFailure(x.c.admin.proposeConfig({ ...cfg, require_attested_marks: true, tee: null }), "attested marks need a TEE config");
    await x.c.admin.proposeConfig({
      ...cfg,
      require_attested_marks: true,
      tee: {
        outlayer_contract: outlayerId,
        wasm_url: "https://github.com/numinousmuses/basis-amm/releases/download/v0.2.0/oracle-tee.wasm",
        wasm_hash: WASM_HASH,
        build_target: "wasm32-wasip2",
        secrets_profile: "basis-oracle",
        secrets_owner: x.id("admin"),
        max_execution_seconds: 30,
      },
    });
    await sleep(1500);
    await x.c.risk.applyConfig();
    expect((await x.c.anon.getConfig()).require_attested_marks).toBe(true);
    // The dev key is no longer accepted for marks.
    await expectFailure(x.c.keeper.pushMark(x.venue.mark(BTC)), "ORACLE_UNATTESTED");
  });

  it("OutLayer callback for the pinned hash registers the program's key as TEE-attested", async () => {
    const r = await x.c.admin.requestTeeReporter("oracle-tee-1", true, false, 10n ** 23n);
    x.record("tee. reporter registered via OutLayer callback", r);
    const pub = runTee({ mode: "pubkey" }).public_key;
    expect(String(r.value)).toBe(`TEE_REPORTER:${pub}`);
    const rep = (await x.c.anon.getReporters()).find((r) => r.public_key === pub)!;
    expect(rep.tee_attested).toBe(true);
    expect(rep.attestation_measurement).toBe(`outlayer-tdx:${outlayerId}:wasm_sha256=${WASM_HASH}`);
  });

  it("marks signed inside the TEE program are accepted and a trade executes on them", async () => {
    await x.c.keeper.pushMark(teeMark(x.stack.contractId, 0.49, 0.5));
    const { orderId } = await x.request("alice", { market: BTC, margin: 100n * D, lev: LEV(3), maxFee: 50n * D });
    await sleep(1100);
    const exec = await x.c.keeper.executeOpen(orderId, teeMark(x.stack.contractId, 0.49, 0.5));
    x.record("tee. order executed on a TEE-signed mark", exec);
    expect(String(exec.value)).toMatch(/^OPEN:/);
    const mark = await x.c.anon.getMark(BTC);
    expect(mark!.report.source_chain).toBe("polygon:137:polymarket-clob:offline-input");
  });

  it("a wrong WASM hash never yields an attested key", async () => {
    const cfg = await x.c.anon.getConfig();
    await x.c.admin.proposeConfig({ ...cfg, tee: { ...cfg.tee!, wasm_hash: "00".repeat(32) } });
    await sleep(1500);
    await x.c.risk.applyConfig();
    const before = (await x.c.anon.getReporters()).length;
    const r = await x.c.admin.call<string>("request_tee_reporter", { label: "wrong-hash", can_mark: true, can_resolve: false }, { deposit: 10n ** 23n, allowFailure: true });
    expect(r.failures.some((f) => f.includes("WASM hash mismatch"))).toBe(true);
    expect(String(r.value)).toBe("TEE_EXECUTION_FAILED");
    expect((await x.c.anon.getReporters()).length).toBe(before);
    await x.assertConservation("tee");
  });
});
