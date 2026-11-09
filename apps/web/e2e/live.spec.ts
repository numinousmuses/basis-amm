/** Hedging, ramp, resolution and TEE views against the running basis-node sandbox stack. The
 * hedged order is a real NEAR transaction; the mock executor fills it on the mock venue.
 *
 * The `@live` test reads live Polymarket markets through basis-node and needs internet. It is
 * skipped unless BASIS_LIVE_TESTS=1:  BASIS_LIVE_TESTS=1 pnpm --filter @basis/web e2e --grep @live */
import { expect, test, type Page } from "@playwright/test";
import { API, go, setLeverage, stack, useDevAccount, view, waitQuote } from "./helpers";

const TRADER = "carol.test.near";
const HEDGED = "pm-eth-above-4k-weekly";

test.describe.configure({ mode: "serial" });

async function fund(page: Page) {
  const s = await stack();
  const bal = BigInt(await view<string>("ft_balance_of", { account_id: TRADER }, s.tokenId).catch(() => "0"));
  if (bal >= 200_000_000n) return;
  await go(page, "portfolio");
  await page.getByTestId("faucet").first().click();
  await expect(page.getByTestId("toast")).toContainText("Minted", { timeout: 30_000 });
}

let orderId = "";
let positionId = "";

test("hedge executor page shows a mock fill after a HEDGE_REQUIRED order", async ({ page }) => {
  await useDevAccount(page, TRADER);
  await fund(page);
  await go(page, "hedging");
  await expect(page.getByTestId("venue-mode")).toBeVisible();
  const st = await (await fetch(`${API}/api/polymarket/status`)).json();
  await expect(page.getByTestId("venue-mode-tag")).toHaveText(st.simulated ? "PAPER" : "LIVE");
  await expect(page.getByTestId(`custody-row-${HEDGED}`)).toBeVisible();

  await go(page, `trade/${HEDGED}`);
  await page.getByTestId("composer-margin").fill("20");
  await setLeverage(page, 2);
  await waitQuote(page);
  await page.getByTestId("review-order").click();
  await page.getByTestId("confirm-submit").click();
  const tracker = page.getByTestId("order-tracker");
  await expect(tracker).toHaveAttribute("data-state", "Executed", { timeout: 60_000 });
  positionId = (await page.getByTestId("open-result").getAttribute("data-position-id"))!;
  const pv = await view<any>("get_position", { position_id: positionId });
  orderId = String(pv.position.order_id);
  expect(pv.position.mode).toBe("HedgeRequired");

  await page.getByTestId("nav-hedging").click();
  const row = page.getByTestId(`fill-row-buy-${orderId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("BUY");
  // A mock fill is labeled sim and never linked to Polygonscan.
  await expect(row.getByTestId("tx-sim")).toBeVisible();
  await expect(row.getByTestId("tx-polygonscan")).toHaveCount(0);
  // The contract's receipt for the same order, and inventory equal to custody.
  await expect(page.getByTestId("contract-fills-table")).toContainText(`#${orderId}`, { timeout: 30_000 });
  const recon = await (await fetch(`${API}/api/reconciliation`)).json();
  if (recon[HEDGED]) await expect(page.getByTestId(`custody-row-${HEDGED}`)).toContainText(recon[HEDGED].ok ? "Matches custody" : "POLYGON_RECONCILIATION_FAILED");
});

test("an open position shows its effective maintenance and ramp text", async ({ page }) => {
  test.skip(!positionId, "needs the hedged position");
  await useDevAccount(page, TRADER);
  await go(page, "positions");
  const row = page.getByTestId(`position-row-${positionId}`);
  await expect(row).toBeVisible();
  const pv = await view<any>("get_position", { position_id: positionId });
  const pct = (bps: number) => `${bps / 100}%`;
  await expect(row.getByTestId("position-ramp")).toContainText(`Maintenance for losing positions rises from ${pct(pv.position.maintenance_bps)} to ${pct(pv.position.ramp_maintenance_bps)} between`);
  await expect(row.getByTestId("position-maintenance")).toContainText(pct(pv.effective_maintenance_bps));
});

test("closing the hedged position unwinds the hedge with a sell fill", async ({ page }) => {
  test.skip(!positionId, "needs the hedged position");
  await useDevAccount(page, TRADER);
  await go(page, "positions");
  await page.getByTestId(`manage-${positionId}`).click();
  await expect(page.getByTestId("manage-ramp")).toContainText("Maintenance");
  await page.getByTestId("close-submit").click();
  await expect(page.getByTestId("order-tracker")).toHaveAttribute("data-state", "Executed", { timeout: 60_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("tab-History").click();
  await expect(page.getByTestId(`history-row-${positionId}`).getByTestId("history-closed")).not.toHaveText("n/a");
  await go(page, "hedging");
  await expect(page.getByTestId(`fill-row-sell-${orderId}`)).toBeVisible({ timeout: 60_000 });
  await go(page, "portfolio");
  await expect(page.getByTestId("pnl-chart")).toBeVisible();
});

test("the composer explains PRE_RESOLUTION_RAMP when opens are closed for it", async ({ page }) => {
  const markets = await (await fetch(`${API}/api/markets`)).json();
  const ramped = markets.find((r: any) => !r.actions.open && r.actions.reasons.some((x: string) => x.startsWith("PRE_RESOLUTION_RAMP")));
  test.skip(!ramped, "no market is inside its pre-resolution ramp on this stack");
  await useDevAccount(page, TRADER);
  await go(page, `trade/${ramped.market.descriptor.market_id}`);
  const box = page.getByTestId("ramp-closed");
  await expect(box).toContainText("Opens closed before resolution");
  await expect(box).toContainText(`rises from ${ramped.policy.maintenance_bps / 100}% to ${ramped.policy.pre_resolution_maintenance_bps / 100}%`);
  await expect(page.getByTestId("review-order")).toBeDisabled();
  await expect(page.getByTestId("review-order")).toHaveText("Opens closed before resolution");
});

test("the trade page shows the contract's resolution panel", async ({ page }) => {
  await go(page, `trade/${HEDGED}`);
  const panel = page.getByTestId("resolution-panel");
  await expect(panel).toBeVisible();
  const res = await view<any>("get_resolution", { market_id: HEDGED });
  if (res) await expect(panel.getByTestId("resolution-status")).toHaveText(res.status);
  else await expect(panel.getByTestId("resolution-none")).toBeVisible();
});

test("the TEE panel renders the contract's attestation state", async ({ page }) => {
  await go(page, "risk");
  const panel = page.getByTestId("tee-panel");
  await expect(panel).toBeVisible();
  const cfg = await view<any>("get_config");
  await expect(panel.getByTestId("tee-require")).toHaveText(`require_attested_marks: ${cfg.require_attested_marks ? "on" : "off"}`);
  const reporters = await view<any[]>("get_reporters");
  for (const r of reporters) await expect(panel.getByTestId(`tee-reporter-${r.label}`)).toContainText(r.tee_attested ? "TEE attested" : "Unattested");
  const execs = await view<any[]>("get_tee_executors");
  await expect(panel.getByTestId("tee-executor-row")).toHaveCount(execs.length);
  if (!cfg.require_attested_marks) await expect(panel.getByTestId("tee-demo-note")).toContainText("runs without it");
});

test("admin admit form lists live Polymarket markets @live", async ({ page }) => {
  test.skip(process.env.BASIS_LIVE_TESTS !== "1", "needs internet; set BASIS_LIVE_TESTS=1");
  await useDevAccount(page, "admin.test.near");
  await go(page, "admin/live");
  const table = page.getByTestId("discover-table");
  await expect(table).toBeVisible({ timeout: 60_000 });
  const rows = table.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(rows.first().getByTestId("discover-version")).toHaveText(/v1|v2/, { timeout: 60_000 });
  await expect(rows.first().getByTestId("discover-price")).toContainText("¢");
  await rows.first().click();
  await expect(page.getByTestId("admit-picked")).toBeVisible();
  await expect(page.getByTestId("admit-submit")).toBeEnabled();
});
