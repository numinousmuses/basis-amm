/** End-to-end against the running basis-node sandbox stack: every action is a real NEAR
 * transaction signed in the browser with a sandbox dev key and executed by the keeper. */
import { expect, test } from "@playwright/test";
import { centsOf, devPost, go, setLeverage, stack, useDevAccount, view, waitQuote } from "./helpers";

const TRADER = "bob.test.near";
const MARKET = "pm-eth-above-4k-weekly";
const MOCK_MARKET = "pm-sol-above-300-weekly";

test.describe.configure({ mode: "serial" });

test("connect a sandbox dev account and mint test USDC from the faucet", async ({ page }) => {
  const s = await stack();
  expect(s.network).toBe("sandbox");
  await go(page, "portfolio");
  await expect(page.getByText("No account connected")).toBeVisible();
  await page.getByTestId("wallet-button").click();
  await expect(page.getByText("Sandbox dev keys (local signing, sandbox only)")).toBeVisible();
  await page.getByTestId("connect-bob").click();
  await expect(page.getByTestId("wallet-button")).toContainText(TRADER);
  const before = BigInt(await view<string>("ft_balance_of", { account_id: TRADER }, s.tokenId));
  await expect(page.getByTestId("portfolio-usdc")).toBeVisible();
  await page.getByTestId("faucet").first().click();
  await expect(page.getByTestId("toast")).toContainText("Minted $1,000.00 test USDC");
  const after = BigInt(await view<string>("ft_balance_of", { account_id: TRADER }, s.tokenId));
  expect(after - before).toBe(1_000_000_000n);
  await expect(page.getByTestId("portfolio-usdc")).toContainText(
    `$${(Number(after / 1_000_000n)).toLocaleString("en-US")}`,
  );
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-network")).toHaveText("sandbox");
  await expect(page.getByTestId("settings-signer")).toContainText("Sandbox dev key: bob");
});

test("toggling partial fills off locks the minimum fill at 100%", async ({ page }) => {
  await useDevAccount(page, TRADER);
  await go(page, `trade/${MARKET}`);
  const toggle = page.getByTestId("partial-toggle");
  const slider = page.getByTestId("min-fill");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(slider).toBeEnabled();
  await slider.fill("60");
  await expect(page.getByTestId("min-fill-label")).toHaveText("60%");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("min-fill-label")).toHaveText("100%");
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveValue("100");
  await expect(page.getByTestId("partial-note")).toContainText("all-or-none");
  await toggle.click();
  await expect(page.getByTestId("min-fill-label")).toHaveText("60%");
  await expect(slider).toBeEnabled();
});

let positionId = "";

test("open a 3x position: order states, then OPEN at the contract's entry price", async ({ page }) => {
  await useDevAccount(page, TRADER);
  await go(page, `trade/${MARKET}`);
  await expect(page.getByTestId("market-title")).toContainText("ETH");
  await page.getByTestId("composer-margin").fill("20");
  await setLeverage(page, 3);
  await waitQuote(page);
  // Composer numbers come from the contract's preview_open: max loss = margin, payout from entry.
  await expect(page.getByTestId("preview-max-loss")).toHaveText("$20.00");
  await expect(page.getByTestId("preview-notional")).toHaveText("$60.00");
  await expect(page.getByTestId("no-autoclose-note")).toContainText("does not close this position");
  await expect(page.getByTestId("jump-warning")).toBeVisible();
  await page.getByTestId("review-order").click();
  // Rules sheet is shown before signing, with the market's current policy hash.
  const market = await view<any>("get_market", { market_id: MARKET });
  await expect(page.getByTestId("rules-policy-hash")).toHaveText(market.policy_hash);
  await expect(page.getByTestId("confirm-partial")).toContainText("On");
  await page.getByTestId("confirm-submit").click();
  const tracker = page.getByTestId("order-tracker");
  await expect(tracker).toBeVisible();
  await expect(tracker).toHaveAttribute("data-state", /Requested|Executed/, { timeout: 30_000 });
  await expect(tracker).toHaveAttribute("data-state", "Executed", { timeout: 30_000 });
  const result = page.getByTestId("open-result");
  await expect(result.getByTestId("position-state")).toHaveText("OPEN");
  positionId = (await result.getAttribute("data-position-id"))!;
  expect(positionId).toMatch(/^\d+$/);
  const pv = await view<any>("get_position", { position_id: positionId });
  expect(pv.position.state).toBe("Open");
  expect(pv.position.owner).toBe(TRADER);
  expect(pv.position.terms.leverage).toBe("30000");
  await expect(result.getByTestId("entry-price")).toHaveText(centsOf(pv.position.terms.entry_price));
  // The positions page shows the same contract values.
  await page.getByTestId("nav-positions").click();
  const row = page.getByTestId(`position-row-${positionId}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("position-state")).toHaveText("OPEN");
  await expect(row.getByTestId("position-entry")).toHaveText(centsOf(pv.position.terms.entry_price));
});

test("close the position and see the payout", async ({ page }) => {
  test.skip(!positionId, "needs the opened position");
  await useDevAccount(page, TRADER);
  await go(page, "positions");
  await page.getByTestId(`manage-${positionId}`).click();
  await expect(page.getByTestId("close-fraction-label")).toHaveText("100%");
  await page.getByTestId("close-submit").click();
  const tracker = page.getByTestId("order-tracker");
  await expect(tracker).toHaveAttribute("data-state", "Executed", { timeout: 30_000 });
  const pv = await view<any>("get_position", { position_id: positionId });
  expect(pv.position.state).toBe("Closed");
  const paid = BigInt(pv.position.paid_out);
  expect(paid).toBeGreaterThan(0n);
  const dollars = `$${(paid / 1_000_000n).toLocaleString("en-US")}.${((paid % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
  await expect(page.getByTestId("close-payout")).toHaveText(dollars);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("tab-History").click();
  await expect(page.getByTestId(`history-row-${positionId}`).getByTestId("history-paid")).toHaveText(dollars);
});

test("a fee cap below fair value is rejected by the contract with FAIR_VALUE", async ({ page }) => {
  await useDevAccount(page, TRADER);
  await go(page, `trade/${MARKET}`);
  await page.getByTestId("composer-margin").fill("20");
  await setLeverage(page, 4);
  await waitQuote(page);
  await page.getByText("Limits you sign").click();
  await page.getByTestId("max-fee").fill("0.01");
  await expect(page.getByTestId("fee-warning")).toContainText("FAIR_VALUE");
  await page.getByTestId("review-order").click();
  await page.getByTestId("confirm-submit").click();
  const tracker = page.getByTestId("order-tracker");
  await expect(tracker).toHaveAttribute("data-state", "Rejected", { timeout: 30_000 });
  const reason = page.getByTestId("order-reason");
  await expect(reason).toContainText("Fee cap too low for fair value");
  await expect(reason).toContainText("FAIR_VALUE: required risk premium");
  await expect(page.getByTestId("open-result")).toHaveCount(0);
});

test("LP deposit mints bLP, then a withdrawal request is queued", async ({ page }) => {
  await useDevAccount(page, TRADER);
  const blpBefore = BigInt(await view<string>("ft_balance_of", { account_id: TRADER }));
  await go(page, "vault");
  await expect(page.getByTestId("vault-share-price")).toBeVisible();
  await page.getByTestId("vault-amount").fill("50");
  await page.getByTestId("vault-submit").click();
  await expect(page.getByTestId("toast")).toContainText("Deposited $50.00");
  const blpAfter = BigInt(await view<string>("ft_balance_of", { account_id: TRADER }));
  expect(blpAfter).toBeGreaterThan(blpBefore);
  await page.getByTestId("vault-tab-withdraw").click();
  await page.getByTestId("vault-amount").fill("10");
  await page.getByTestId("vault-submit").click();
  await expect(page.getByTestId("toast")).toContainText(/Withdrawal #\d+ queued/);
  const ws = await view<any[]>("get_withdrawals_by_owner", { owner: TRADER });
  const last = ws[ws.length - 1];
  expect(last.shares).toBe("10000000");
  expect(["Queued", "Settled"]).toContain(last.status);
  await expect(page.getByTestId(`my-withdrawal-${last.withdrawal_id}`)).toBeVisible();
});

test("admin mock-venue price change shows up on the trade page", async ({ page }) => {
  const before = await view<any>("get_mark", { market_id: MOCK_MARKET });
  const yesMid = (BigInt(before.report.outcomes[0].bids[0].price) + BigInt(before.report.outcomes[0].asks[0].price)) / 2n;
  const target = yesMid >= 700_000n ? 30 : 70;
  try {
    await useDevAccount(page, TRADER);
    await go(page, "admin/mock");
    await expect(page.getByText("MOCK VENUE CONTROLS (simulated prices)")).toBeVisible();
    await page.getByTestId("mock-market").selectOption(MOCK_MARKET);
    await page.getByTestId("mock-mid-0").fill(String(target));
    await expect(page.getByTestId("mock-mid-1")).toHaveValue((100 - target).toFixed(1));
    await page.getByTestId("mock-apply").click();
    await expect(page.getByTestId("mock-last")).toContainText("MOCK VENUE CONTROL");
    await page.getByTestId("nav-trade").click();
    await page.getByTestId("market-select").selectOption(MOCK_MARKET);
    await expect(page.getByTestId("outcome-mid-0")).toHaveText(`${target}¢`, { timeout: 30_000 });
    await expect(page.getByTestId("outcome-mid-1")).toHaveText(`${100 - target}¢`);
    await expect(page.getByText(/Simulated: mock-venue/)).toBeVisible();
  } finally {
    await devPost("/api/dev/venue", { market_id: MOCK_MARKET, mids: [yesMid.toString(), (1_000_000n - yesMid).toString()] });
    await devPost("/api/dev/venue", { market_id: MOCK_MARKET, clear: true });
  }
});
