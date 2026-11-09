import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, deployStack, loadExampleManifests, clientFor, type Sandbox, type DeployedStack } from "@basis/stack";

let sb: Sandbox;
let stack: DeployedStack;
beforeAll(async () => {
  sb = await startSandbox();
  stack = await deployStack({
    network: "sandbox",
    rpcUrl: sb.rpcUrl,
    master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey },
    manifests: Object.values(loadExampleManifests()),
    log: (m) => console.log(m),
  });
});
afterAll(async () => sb?.stop());

describe("smoke", () => {
  it("deploys and reports vault state", async () => {
    const c = clientFor(stack);
    const v = await c.getVaultSummary();
    console.log(v);
    expect(v.blp_supply).toBe("100000000000");
    const markets = await c.getMarkets();
    expect(markets.length).toBe(5);
    expect(markets.every((m) => m.state === "Active")).toBe(true);
  });
});
