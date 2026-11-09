/** Footage capture for the Remotion demo. Drives the real dashboard against a running basis-node
 * stack (every step is a real NEAR transaction or contract read) and saves 1600x1000 PNGs at each
 * step plus a recorded .webm into video/footage/.
 *
 *   BASIS_API=http://127.0.0.1:8841 pnpm --filter @basis/web capture
 *
 * The demo resolves a market, which is permanent on that chain, so point BASIS_API at an isolated
 * stack (see video/footage/README.md), not a shared one.
 *
 * CAPTURE=extras skips the base walkthrough (01-21 stay as they are) and records only the live
 * Polymarket, hedging, resolution and TEE steps as 22 onward, plus live-hedging-walkthrough.webm.
 * It admits a live Polymarket market (needs internet; LIVE_SLUG picks one) and resolves the mock
 * market RESOLVE_MARKET, so it also needs an isolated stack. */
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
const EXTRAS_ONLY = process.env.CAPTURE === "extras";
const BASE_STEPS = 21;
const RESOLVE_MARKET = process.env.RESOLVE_MARKET ?? "pm-sol-above-300-weekly";
const HEDGE_MARKET = "pm-eth-above-4k-weekly";

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
  if (EXTRAS_ONLY) {
    step = BASE_STEPS;
    for (const f of readdirSync(OUT)) if ((/^\d+-/.test(f) && Number(f.slice(0, 2)) > BASE_STEPS && f.endsWith(".png")) || f === "live-hedging-walkthrough.webm") rmSync(join(OUT, f));
  } else for (const f of readdirSync(OUT)) if (f.endsWith(".png") || f.endsWith(".webm")) rmSync(join(OUT, f));

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
    if (EXTRAS_ONLY) {
      await extras(page, go);
      return;
    }
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

    await extras(page, go);
  } finally {
    const video = page.video();
    await ctx.close();
    await browser.close();
    if (video) {
      const p = await video.path();
      const name = EXTRAS_ONLY ? "live-hedging-walkthrough.webm" : "demo-walkthrough.webm";
      renameSync(p, join(OUT, name));
      console.log(`saved ${name} (${Math.round(statSync(join(OUT, name)).size / 1024)} KB)`);
    }
    preview?.kill();
  }
}

/** Scroll so `testId` sits near the top of the viewport. */
async function scrollTo(page: Page, testId: string) {
  await page.getByTestId(testId).first().evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 90));
}

async function json(path: string) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** A binary live market that trades away from the extremes and resolves well after any
 * maintenance ramp, so a hedged open is allowed. */
async function pickLiveSlug(): Promise<string> {
  if (process.env.LIVE_SLUG) return process.env.LIVE_SLUG;
  const list: Array<{ slug: string; endDate: string }> = await json("/api/polymarket/discover?limit=30");
  for (const m of list) {
    if (!m.endDate || Date.parse(m.endDate) < Date.now() + 14 * 86400_000) continue;
    const d = await json(`/api/polymarket/market/${encodeURIComponent(m.slug)}`).catch(() => null);
    const p = Number(d?.outcomes?.yes?.price ?? 0);
    if (d?.state?.acceptingOrders && p >= 0.12 && p <= 0.88 && d.outcomes.no) return m.slug;
  }
  throw new Error("no suitable live Polymarket market in the top 30; set LIVE_SLUG");
}

async function openOrder(page: Page, go: (r: string) => Promise<unknown>, market: string, margin: string, lev: string, lowestMinFill = false) {
  await go(`trade/${market}`);
  await expect(page.getByTestId("market-title")).toBeVisible();
  await page.getByTestId("outcome-0").click();
  await page.getByTestId("composer-margin").fill(margin);
  await page.getByTestId("composer-leverage").fill(lev);
  // Accept down to the policy's minimum fill floor: a live book may hold less depth inside the
  // signed slippage bound than the full size.
  if (lowestMinFill) await page.getByTestId("min-fill").fill("0");
  await expect(page.getByTestId("quote-expiry")).toContainText("expires in", { timeout: 30_000 });
  await page.getByTestId("review-order").click();
  await page.getByTestId("confirm-submit").click();
  await expect(page.getByTestId("order-tracker")).toHaveAttribute("data-state", /Executed|Rejected|Expired/, { timeout: 120_000 });
  return page.getByTestId("order-tracker").getAttribute("data-state");
}

/** 22 onward: live Polymarket admission and book, hedging after a hedged trade, resolution, TEE. */
async function extras(page: Page, go: (r: string) => Promise<unknown>) {
  // a. Admit a live Polymarket market from the admin console
  const slug = await pickLiveSlug();
  console.log(`live market: ${slug}`);
  await go("admin/live");
  await expect(page.getByTestId("discover-table")).toBeVisible({ timeout: 60_000 });
  const row = page.getByTestId(`discover-row-${slug}`);
  if ((await row.count()) === 0) throw new Error(`${slug} is not in the discover list`);
  await expect(page.getByTestId("discover-version").first()).toHaveText(/v1|v2/, { timeout: 60_000 });
  await row.click();
  await page.getByTestId("admit-strategy").selectOption("HedgeRequired");
  await shot(page, "admin-admit-live-form", 1500);
  await page.getByTestId("admit-submit").click();
  await expect(page.getByTestId("admit-result")).toBeVisible({ timeout: 120_000 });
  const liveId = (await page.getByTestId("admit-market-id").innerText()).trim();
  await shot(page, "admin-admit-live-result");

  // b. Its trade page once the oracle has signed a mark from the live CLOB book
  for (let i = 0; i < 90; i++) {
    const d = await json(`/api/markets/${encodeURIComponent(liveId)}`).catch(() => null);
    if (d?.mark?.report.source_chain?.startsWith("polygon:137:polymarket-clob")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await page.getByTestId("admit-open-market").click();
  await expect(page.getByTestId("book-title")).toContainText("Live Polymarket book", { timeout: 30_000 });
  await expect(page.getByTestId("depth")).toBeVisible({ timeout: 60_000 });
  // The first quote needs the live mark stored onchain; wait for it instead of capturing PRICE_STALE.
  await expect(page.getByTestId("quote-expiry")).toContainText("expires in", { timeout: 90_000 });
  await page.waitForTimeout(6000);
  await shot(page, "trade-live-polymarket-market", 1500);
  await scrollTo(page, "book-title");
  await shot(page, "trade-live-polymarket-book");

  // c. Hedged trades: HEDGE_REQUIRED on the live market (paper fill against the live book) and on
  //    the mock fixture, then the hedge executor page.
  await go("portfolio");
  await page.getByTestId("wallet-button").click();
  await page.getByTestId(`connect-${TRADER}`).click();
  await page.getByTestId("faucet").first().click();
  await expect(page.getByTestId("toast")).toContainText("Minted", { timeout: 30_000 });
  console.log(`live hedged order: ${await openOrder(page, go, liveId, "10", "1.5", true)}`);
  console.log(`mock hedged order: ${await openOrder(page, go, HEDGE_MARKET, "20", "2")}`);
  await go("hedging");
  await expect(page.getByTestId("fills-table")).toBeVisible({ timeout: 30_000 });
  await shot(page, "hedging-after-hedged-trade", 2500);
  await scrollTo(page, "fills-table");
  await shot(page, "hedging-fills-and-receipts");

  // d. Resolution panel: a mock proposal waiting out its dispute window, and the live market's
  //    two-source resolver observations.
  await post("/api/dev/resolve", { market_id: RESOLVE_MARKET, scenario: 0 });
  await go(`trade/${RESOLVE_MARKET}`);
  await expect(page.getByTestId("resolution-proposal")).toBeVisible({ timeout: 30_000 });
  await scrollTo(page, "resolution-panel");
  await shot(page, "resolution-panel-proposal", 1000);
  for (let i = 0; i < 60; i++) {
    const s = await json("/api/polymarket/status");
    if (s.resolutions?.[liveId]) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await go(`trade/${liveId}`);
  await expect(page.getByTestId("resolver-observations")).toBeVisible({ timeout: 30_000 });
  await scrollTo(page, "resolution-panel");
  await shot(page, "resolution-panel-live-observations", 1000);

  // e. TEE panel and the positions ramp
  await go("risk");
  await expect(page.getByTestId("tee-panel")).toBeVisible();
  await scrollTo(page, "tee-panel");
  await shot(page, "tee-panel", 1500);
  await go("positions");
  await expect(page.getByTestId("position-ramp").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "positions-maintenance-ramp", 1200);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
