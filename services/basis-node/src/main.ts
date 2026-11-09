#!/usr/bin/env tsx
/** basis-node: oracle worker + keeper + mock hedge executor + reconciler + indexer/API.
 *
 *   basis-node --sandbox            start (or resume) a local sandbox, deploy the stack once, run
 *   basis-node --stack <file.json>  run against an existing deployment (e.g. testnet)
 *
 * Flags: --port 8797  --rpc-port 3030  --data <dir>  --db <path>  --dev-controls  --volatility 0.004 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, deployStack, loadExampleManifests, startSandbox, type DeployedStack } from "@basis/stack";
import { startNode } from "./node.js";
import { MockFeed } from "./feeds.js";
import { log } from "./log.js";
import { OutlayerSigner, WasmtimeSigner, type MarkSigner } from "./tee.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

async function main() {
  const dataDir = opt("data", join(REPO_ROOT, "infra/local-dev/data"))!;
  let stack: DeployedStack;
  let stopSandbox: (() => Promise<void>) | undefined;
  if (flag("sandbox")) {
    mkdirSync(dataDir, { recursive: true });
    const stackFile = join(dataDir, "stack.json");
    const home = join(dataDir, "sandbox");
    const fresh = !existsSync(stackFile) || !existsSync(join(home, "data"));
    const sb = await startSandbox({ home, port: Number(opt("rpc-port", "3030")) });
    stopSandbox = sb.stop;
    if (fresh) {
      log("info", "main", "deploying fresh sandbox stack");
      stack = await deployStack({
        network: "sandbox",
        rpcUrl: sb.rpcUrl,
        master: { accountId: sb.rootAccountId, secretKey: sb.rootSecretKey },
        manifests: Object.values(loadExampleManifests()),
        log: (m) => log("info", "deploy", m),
      });
      writeFileSync(stackFile, JSON.stringify(stack, null, 2));
    } else {
      stack = JSON.parse(readFileSync(stackFile, "utf8"));
      stack.rpcUrl = sb.rpcUrl;
    }
  } else {
    const f = opt("stack");
    if (!f) throw new Error("pass --sandbox or --stack <deployment.json>");
    stack = JSON.parse(readFileSync(f, "utf8"));
  }
  // --tee-outlayer <owner/project> (needs OUTLAYER_PAYMENT_KEY) or, for development only,
  // --tee-wasmtime <oracle-tee.wasm> (needs PROTECTED_ORACLE_KEY; same program, no TEE).
  let teeSigner: MarkSigner | undefined;
  if (opt("tee-outlayer")) teeSigner = new OutlayerSigner(opt("tee-outlayer")!, process.env.OUTLAYER_PAYMENT_KEY ?? "");
  else if (opt("tee-wasmtime")) teeSigner = new WasmtimeSigner(opt("tee-wasmtime")!, process.env.PROTECTED_ORACLE_KEY ?? "");
  const node = await startNode(stack, {
    teeSigner,
    port: Number(opt("port", "8797")),
    dbPath: opt("db", join(dataDir, `${stack.network}.sqlite`)),
    feed: new MockFeed(Number(opt("seed", "42")), Number(opt("volatility", "0.004"))),
    devControls: flag("dev-controls") || flag("sandbox"),
    exposeDevKeys: stack.network === "sandbox",
    lean: flag("lean") || stack.network === "testnet",
  });
  log("info", "main", "basis-node running", { network: stack.network, contract: stack.contractId, rpc: stack.rpcUrl });
  const shutdown = async () => {
    await node.stop();
    await stopSandbox?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
