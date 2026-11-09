/** Footage capture for the Remotion demo. Drives the real dashboard against a running basis-node
 * stack (every step is a real NEAR transaction or contract read) and saves 1600x1000 PNGs at each
 * step plus a recorded .webm into video/footage/.
 *
 *   BASIS_API=http://127.0.0.1:8841 pnpm --filter @basis/web capture
 *
 * The demo resolves a market, which is permanent on that chain, so point BASIS_API at an isolated
 * stack (see video/footage/README.md), not a shared one. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const OUT = join(WEB, "../../video/footage");
const API = process.env.BASIS_API ?? "http://127.0.0.1:8841";
const PORT = Number(process.env.WEB_PORT ?? 5417);
const BASE = `http://127.0.0.1:${PORT}`;
const MARKET = process.env.DEMO_MARKET ?? "pm-btc-above-100k-daily";
const TRADER = "alice";
const SIZE = { width: 1600, height: 1000 };

let step = 0;
async function shot(page: Page, name: string, pause = 600) {
  await page.waitForTimeout(pause);
  step++;
  const file = `${String(step).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(OUT, file) });
  console.log(`saved ${file}`);
}

async function up(url: string) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function post(path: string, body: unknown) {
  const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  if (!(await up(`${API}/api/stack`))) throw new Error(`basis-node not reachable at ${API}`);
  const devs: Array<{ role: string; accountId: string }> = await (await fetch(`${API}/api/dev/accounts`)).json();
  const traderId = devs.find((d) => d.role === TRADER)!.accountId;
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith(".png") || f.endsWith(".webm")) rmSync(join(OUT, f));

  let preview: ChildProcess | null = null;
  if (!(await up(BASE))) {
    preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: WEB, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await up(BASE)); i++) await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE } });
  const page = await ctx.newPage();
  const go = (route: string) => page.goto(`${BASE}/?api=${encodeURIComponent(API)}#/${route}`);
  try {
    // 1. Markets
    await go("markets");
    await expect(page.getByTestId("markets-table")).toBeVisible({ timeout: 30_000 });
    await shot(page, "markets", 1500);

    // 2. Connect a sandbox dev key, mint test USDC
    await page.getByTestId("wallet-button").click();
    await shot(page, "connect-dev-key");
    await page.getByTestId(`connect-${TRADER}`).click();
    await page.getByTestId("nav-portfolio").click();
    await page.getByTestId("faucet").first().click();
    await expect(page.getByTestId("toast")).toContainText("Minted", { timeout: 30_000 });
    await shot(page, "portfolio-faucet");

    // 3. Trade composer: 5x YES
    await go(`trade/${MARKET}`);
    await expect(page.getByTestId("market-title")).toBeVisible();
    await page.getByTestId("outcome-0").click();
    await page.getByTestId("composer-margin").fill("100");
    await page.getByTestId("composer-leverage").fill("5");
    await expect(page.getByTestId("quote-expiry")).toContainText("expires in", { timeout: 20_000 });
    await shot(page, "trade-composer", 1200);
    await page.getByTestId("composer").scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 700);
    await shot(page, "composer-payout-and-warnings");

    // 4. Rules sheet before signing, then submit
    await page.getByTestId("review-order").click();
    await expect(page.getByTestId("rules-sheet")).toBeVisible();
    await shot(page, "confirm-with-market-rules");
    await page.getByTestId("confirm-submit").click();
    await expect(page.getByTestId("order-tracker")).toBeVisible();
    await page.getByTestId("order-tracker").scrollIntoViewIfNeeded();
    await shot(page, "order-requested", 300);
    await expect(page.getByTestId("order-tracker")).toHaveAttribute("data-state", "Executed", { timeout: 60_000 });
    await page.getByTestId("open-result").scrollIntoViewIfNeeded();
    await shot(page, "order-executed-position-open");
    const positionId = await page.getByTestId("open-result").getAttribute("data-position-id");

    // 5. Position OPEN on the positions page
    await page.getByTestId("nav-positions").click();
    await expect(page.getByTestId(`position-row-${positionId}`)).toBeVisible();
    await shot(page, "positions-open", 1200);

    // 6. Mock price move: YES to 66c, position above +100% and still open
    await go("admin/mock");
    await page.getByTestId("mock-market").selectOption(MARKET);
    await page.getByTestId("mock-mid-0").fill("66");
    await shot(page, "admin-mock-venue-controls");
    await page.getByTestId("mock-apply").click();
    await expect(page.getByTestId("mock-last")).toContainText("MOCK VENUE CONTROL");
    await go(`trade/${MARKET}`);
    await expect(page.getByTestId("outcome-mid-0")).toHaveText("66¢", { timeout: 60_000 });
    await shot(page, "trade-price-moved", 1500);
    await go("positions");
    const row = page.getByTestId(`position-row-${positionId}`);
    await expect(row.getByTestId("position-mark")).toHaveText("65.5¢", { timeout: 60_000 });
    await expect(row.getByTestId("position-state")).toHaveText("OPEN");
    await shot(page, "plus-100-percent-still-open", 1200);

    // 7. Vault and risk monitor
    await go("vault");
    await expect(page.getByTestId("vault-share-price")).toBeVisible();
    await shot(page, "vault", 2000);
    await go("stats");
    await expect(page.getByTestId("conservation-status")).toBeVisible();
    await shot(page, "protocol-stats", 2000);
    await go("risk");
    await expect(page.getByTestId("risk-table")).toBeVisible();
    await shot(page, "risk-monitor", 1500);

    // 8. Guardian CLOSE_ONLY, then mock resolution
    await go("admin");
    await page.getByTestId("switch-guardian").click();
    await expect(page.getByTestId("admin-role")).toContainText("guardian");
    await page.getByTestId(`close-only-${MARKET}`).click();
    await expect(page.getByTestId("toast")).toContainText("Set close-only: confirmed", { timeout: 30_000 });
    await expect(page.getByTestId(`admin-market-${MARKET}`).getByTestId("state-chip")).toHaveText("Close only", { timeout: 15_000 });
    await shot(page, "admin-guardian-close-only");
    await go(`trade/${MARKET}`);
    await expect(page.getByTestId("state-chip").first()).toHaveText("Close only", { timeout: 15_000 });
    await shot(page, "trade-close-only", 1200);
    await go("admin/mock");
    await page.getByTestId("mock-market").selectOption(MARKET);
    await page.getByTestId("mock-scenario").selectOption("0");
    await page.getByTestId("mock-resolve").click();
    await expect(page.getByTestId("mock-last")).toContainText("MOCK RESOLUTION", { timeout: 30_000 });
    await shot(page, "admin-mock-resolution");

    // 9. Settlement payout
    await go("admin");
    await page.getByTestId("wallet-button").click();
    await page.getByTestId(`connect-${TRADER}`).click();
    for (let i = 0; i < 60; i++) {
      const pv = await (await fetch(`${API}/api/accounts/${traderId}`)).json();
      if (pv.positions?.find((p: any) => p.position.position_id === positionId)?.position.state === "Settled") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await go("positions");
    await page.getByTestId("tab-History").click();
    await expect(page.getByTestId(`history-row-${positionId}`)).toContainText("SETTLED", { timeout: 30_000 });
    await shot(page, "settlement-payout", 1000);
    await page.getByTestId(`history-row-${positionId}`).click().catch(() => {});
    await go("activity");
    await expect(page.getByTestId("activity-table")).toBeVisible();
    await shot(page, "activity-audit-log", 1500);
    await go("portfolio");
    await shot(page, "portfolio-after-settlement", 2000);
  } finally {
    const video = page.video();
    await ctx.close();
    await browser.close();
    if (video) {
      const p = await video.path();
      renameSync(p, join(OUT, "demo-walkthrough.webm"));
      console.log(`saved demo-walkthrough.webm (${Math.round(statSync(join(OUT, "demo-walkthrough.webm")).size / 1024)} KB)`);
    }
    preview?.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
