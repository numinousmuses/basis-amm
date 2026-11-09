import { expect, type Page } from "@playwright/test";

export const API = process.env.BASIS_API ?? "http://127.0.0.1:8797";

export interface Stack {
  network: string;
  rpcUrl: string;
  contractId: string;
  tokenId: string;
}

let stackCache: Stack | null = null;
export async function stack(): Promise<Stack> {
  if (!stackCache) stackCache = (await (await fetch(`${API}/api/stack`)).json()) as Stack;
  return stackCache;
}

/** Contract view over raw JSON-RPC, independent of the app, to check what the UI shows. */
export async function view<T>(method: string, args: Record<string, unknown> = {}, contract?: string): Promise<T> {
  const s = await stack();
  const r = await fetch(s.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "e2e",
      method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: contract ?? s.contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const j: any = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error));
  return JSON.parse(Buffer.from(j.result.result).toString("utf8")) as T;
}

export async function devPost(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

/** Pre-select a sandbox dev key so a test starts connected (the UI flow is covered separately). */
export async function useDevAccount(page: Page, accountId: string) {
  const s = await stack();
  await page.addInitScript(
    ([c, a]) => {
      localStorage.setItem(`basis.mode.${c}`, "dev");
      localStorage.setItem(`basis.dev.${c}`, a);
    },
    [s.contractId, accountId] as const,
  );
}

export async function go(page: Page, route: string) {
  await page.goto(`/?api=${encodeURIComponent(API)}#/${route}`);
}

/** cents string ("50.5¢") for a 1e6 price, matching the app's formatter. */
export function centsOf(p: string | bigint): string {
  const v = BigInt(p);
  const whole = v / 10_000n;
  const frac = (v % 10_000n) / 1_000n;
  return `${whole}${frac ? "." + frac : ""}¢`;
}

export async function setLeverage(page: Page, x: number) {
  const slider = page.getByTestId("composer-leverage");
  await slider.fill(String(x));
  await expect(page.getByTestId("leverage-label")).toHaveText(`${x.toFixed(1)}x`);
}

export async function waitQuote(page: Page) {
  await expect(page.getByTestId("quote-expiry")).toContainText("expires in", { timeout: 20_000 });
}
