import { describe, expect, it } from "vitest";
import type { MarketDescriptor } from "@basis/sdk";
import { admittedConditions, isLiveMarket, isLiveSource, liveRefs, nearTxUrl, pmPriceMicro, polymarketUrl, truthy, txLink, venueLabel } from "./live";
import { explainError, explainReason } from "./errors";

const COND = "0x5db999fad322cea2914535aae5517060c3f80ad6d8c0231cde2124a434d16846";
const TOK_YES = "55115078421062885512539156303747803058407616201213034911037320915726138659123";
const TOK_NO = "1910830010387565971650098373488592514702818137344973088263643820608151819241";

const desc = (ext: string, refs: string[], extra: Partial<MarketDescriptor> = {}) =>
  ({ market_id: "m", external_market_id: ext, outcomes: refs.map((r, i) => ({ outcome_id: i, label: `O${i}`, venue_token_ref: r })), resolution_source: "", ...extra }) as unknown as MarketDescriptor;

describe("live Polymarket ref detection (same patterns as basis-node refs.ts)", () => {
  it("detects v1 CTF token refs", () => {
    const d = desc(`polymarket:v1:condition:${COND}`, [`polygon:ctf:${TOK_YES}`, `polygon:ctf:${TOK_NO}`]);
    expect(liveRefs(d)).toEqual({ version: "v1", conditionId: COND, assetIds: [TOK_YES, TOK_NO] });
    expect(isLiveMarket(d)).toBe(true);
  });
  it("detects Protocol V2 position refs", () => {
    const d = desc(`polymarket:v2:condition:${COND}`, ["polygon:pmv2:798559951534518479645224261511384773234863312866932338530531601041078616064", "polygon:pmv2:7985599515345184796452242615113847732348633128669323385305316010410786160"]);
    expect(liveRefs(d)?.version).toBe("v2");
  });
  it("leaves the mock fixtures alone", () => {
    expect(isLiveMarket(desc("polymarket:condition:0xgold-demo", ["polygon:ctf:gold-yes", "polygon:ctf:gold-no"]))).toBe(false);
    // live external id but one fixture ref: not live (every outcome must be a real token)
    expect(isLiveMarket(desc(`polymarket:v1:condition:${COND}`, [`polygon:ctf:${TOK_YES}`, "polygon:ctf:gold-no"]))).toBe(false);
    // short numeric ids are not CLOB token ids
    expect(isLiveMarket(desc(`polymarket:v1:condition:${COND}`, ["polygon:ctf:123", "polygon:ctf:456"]))).toBe(false);
    expect(isLiveMarket(desc("polymarket:v3:condition:" + COND, [`polygon:ctf:${TOK_YES}`]))).toBe(false);
  });
  it("labels the mark source", () => {
    expect(isLiveSource("polygon:137:polymarket-clob")).toBe(true);
    expect(isLiveSource("mock-venue:polygon-sim")).toBe(false);
    expect(isLiveSource(undefined)).toBe(false);
  });
  it("lists admitted condition ids", () => {
    const m = admittedConditions([{ ...desc(`polymarket:v1:condition:${COND.toUpperCase().replace("0X", "0x")}`, [`polygon:ctf:${TOK_YES}`, `polygon:ctf:${TOK_NO}`]), market_id: "pm-live-665374" }, desc("polymarket:condition:0xgold-demo", ["polygon:ctf:gold-yes"])]);
    expect([...m.entries()]).toEqual([[COND, "pm-live-665374"]]);
  });
});

describe("polymarket.com event link", () => {
  it("parses the descriptor's resolution source", () => {
    const d = desc("", [], { resolution_source: `Polymarket UMA resolution for condition ${COND} (https://polymarket.com/event/will-the-us-invade-iran-before-2027)` });
    expect(polymarketUrl(d)).toBe("https://polymarket.com/event/will-the-us-invade-iran-before-2027");
  });
  it("falls back to the policy rules text and trims trailing punctuation", () => {
    expect(polymarketUrl({ resolution_source: "UMA" }, { human_readable_rules: "See https://polymarket.com/event/btc-up-or-down/btc-1h. Max 4x." })).toBe("https://polymarket.com/event/btc-up-or-down/btc-1h");
    expect(polymarketUrl({ resolution_source: "mock-venue:uma-ctf-sim" }, { human_readable_rules: "Fixture market" })).toBeNull();
    expect(polymarketUrl(null, null)).toBeNull();
    expect(polymarketUrl({ resolution_source: "https://evil.example/polymarket.com/event/x" })).toBeNull();
  });
});

describe("hedge transaction links", () => {
  const real = "0x" + "ab".repeat(32);
  it("links only real 0x Polygon hashes on non-simulated fills", () => {
    expect(txLink(real, false)).toEqual({ kind: "polygon", url: `https://polygonscan.com/tx/${real}`, hash: real });
    expect(txLink(real, 0).kind).toBe("polygon");
  });
  it("never links a simulated receipt, even with a 0x-looking hash", () => {
    expect(txLink(real, true).kind).toBe("sim");
    expect(txLink(real, 1).kind).toBe("sim");
  });
  it("labels paper and mock receipts", () => {
    expect(txLink("paper:665374-123", true).kind).toBe("paper");
    expect(txLink("paper:665374-123", false).kind).toBe("paper");
    expect(txLink("sim:0x6275792d312d31373632", true).kind).toBe("sim");
    expect(txLink("sim:redeem-1762", false).kind).toBe("sim");
  });
  it("does not link malformed hashes", () => {
    expect(txLink("0x1234", false).kind).toBe("none");
    expect(txLink("", false).kind).toBe("none");
    expect(txLink(null).kind).toBe("none");
  });
  it("reads sqlite 0/1 booleans", () => {
    expect(truthy(1)).toBe(true);
    expect(truthy(0)).toBe(false);
    expect(truthy(true)).toBe(true);
    expect(truthy(null)).toBe(false);
  });
});

describe("venue mode label", () => {
  it("is unmistakable for each mode", () => {
    expect(venueLabel("polymarket-live", false).mode).toBe("LIVE");
    expect(venueLabel("polymarket-live", false).title).toContain("real Polymarket orders");
    expect(venueLabel("polymarket-paper", true).mode).toBe("PAPER");
    expect(venueLabel("polymarket-paper", true).title).toContain("live Polymarket books");
    expect(venueLabel(null, true).mode).toBe("MOCK");
  });
  it("never calls a simulated venue LIVE", () => {
    expect(venueLabel("polymarket-live", true).mode).toBe("PAPER");
    expect(venueLabel("polymarket-live", undefined).mode).toBe("PAPER");
  });
});

describe("admin helpers", () => {
  it("links NEAR transactions only where a public explorer exists", () => {
    expect(nearTxUrl("testnet", "ABC")).toBe("https://testnet.nearblocks.io/txns/ABC");
    expect(nearTxUrl("mainnet", "ABC")).toBe("https://nearblocks.io/txns/ABC");
    expect(nearTxUrl("sandbox", "ABC")).toBeNull();
  });
  it("parses Polymarket decimal prices into 1e6", () => {
    expect(pmPriceMicro("0.095")).toBe(95_000n);
    expect(pmPriceMicro("1")).toBe(1_000_000n);
    expect(pmPriceMicro(".5")).toBe(500_000n);
    expect(pmPriceMicro(0.0005)).toBe(500n);
    expect(pmPriceMicro("1.2")).toBeNull();
    expect(pmPriceMicro("abc")).toBeNull();
    expect(pmPriceMicro(undefined)).toBeNull();
  });
});

describe("new contract error codes", () => {
  it("explains PRE_RESOLUTION_RAMP from the effective-actions reason", () => {
    const e = explainError("PRE_RESOLUTION_RAMP: no new positions while maintenance ramps toward resolution");
    expect(e.code).toBe("PRE_RESOLUTION_RAMP");
    expect(e.title).toBe("Opens closed before resolution");
    expect(explainReason("PRE_RESOLUTION_RAMP: no new positions")).toContain("no new positions until the market settles");
  });
  it("explains ORACLE_UNATTESTED and HEDGE_REJECTED panics", () => {
    expect(explainError("Smart contract panicked: ORACLE_UNATTESTED: marks must come from a TEE-attested reporter").title).toBe("Price signer not attested");
    const h = explainError("Smart contract panicked: HEDGE_REJECTED: wrong market or token");
    expect(h.code).toBe("HEDGE_REJECTED");
    expect(h.raw).toContain("wrong market or token");
  });
  it("surfaces the ramp inside a generic OPEN_NOT_ALLOWED", () => {
    expect(explainError("OPEN_NOT_ALLOWED: PRE_RESOLUTION_RAMP: no new positions").code).toBe("PRE_RESOLUTION_RAMP");
  });
});
