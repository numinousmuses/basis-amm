import { describe, expect, it } from "vitest";
import { manifestToChain } from "@basis/sdk";
import { loadExampleManifests } from "../src/manifests.js";

describe("example manifests", () => {
  const all = Object.values(loadExampleManifests());
  it("all convert to contract structs", () => {
    for (const m of all) expect(() => manifestToChain(m)).not.toThrow();
  });
  it("leave at least an hour of trading before the pre-resolution ramp starts", () => {
    const now = Date.now();
    for (const m of all) {
      const { descriptor, policy } = manifestToChain(m, now);
      const rampStart = BigInt(descriptor.expected_resolution_ns) - BigInt(policy.maintenance_ramp_ns);
      expect(rampStart - BigInt(now) * 1_000_000n, descriptor.market_id).toBeGreaterThan(3_600_000_000_000n);
    }
  });
  it("cap leverage at or below the 5x protocol ceiling with calibrated coverage", () => {
    for (const m of all) {
      expect(Number(m.policy.max_leverage)).toBeLessThanOrEqual(5);
      expect(m.policy.fees.floor_coverage_bps).toBeGreaterThanOrEqual(1000);
    }
  });
});
