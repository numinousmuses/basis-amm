/** Local nearcore sandbox node for dev and e2e. Install with infra/local-dev/install-sandbox.sh. */
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export interface Sandbox {
  rpcUrl: string;
  rootAccountId: string;
  rootSecretKey: string;
  home: string;
  stop(): Promise<void>;
}

const TOOLS = process.env.BASIS_TOOLS ?? join(homedir(), ".local/share/basis-amm");

export function sandboxBinary(): string {
  const p = process.env.NEAR_SANDBOX_BIN ?? join(TOOLS, "near-sandbox");
  if (!existsSync(p)) throw new Error(`near-sandbox not found at ${p}; run infra/local-dev/install-sandbox.sh`);
  return p;
}

function env() {
  const e = { ...process.env };
  const xz = join(TOOLS, "xz/lib");
  if (process.platform === "darwin" && existsSync(xz)) e.DYLD_LIBRARY_PATH = xz;
  return e;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? res(a.port) : rej(new Error("port"))));
    });
  });
}

export async function startSandbox(opts: { home?: string; port?: number; keep?: boolean } = {}): Promise<Sandbox> {
  const bin = sandboxBinary();
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "basis-sandbox-"));
  if (!existsSync(join(home, "config.json"))) execFileSync(bin, ["--home", home, "init"], { env: env(), stdio: "ignore" });
  const port = opts.port ?? (await freePort());
  const netPort = await freePort();
  const child: ChildProcess = spawn(bin, ["--home", home, "run", "--rpc-addr", `127.0.0.1:${port}`, "--network-addr", `127.0.0.1:${netPort}`], {
    env: env(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`sandbox exited: ${stderr}`);
    try {
      const r = await fetch(`${rpcUrl}/status`);
      if (r.ok) {
        const st: any = await r.json();
        if (Number(st?.sync_info?.latest_block_height ?? 0) > 1) break;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`sandbox did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const key = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8"));
  return {
    rpcUrl,
    rootAccountId: key.account_id,
    rootSecretKey: key.secret_key ?? key.private_key,
    home,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (child.exitCode === null) child.kill("SIGKILL");
      if (!opts.keep && !opts.home) rmSync(home, { recursive: true, force: true });
    },
  };
}
