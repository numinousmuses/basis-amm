# Dashboard footage for the demo video

Captured by `apps/web/scripts/capture.ts` (Playwright, chromium, 1600x1000) driving the real
`apps/web` build against a real basis-node sandbox stack. Every step is a NEAR transaction or a
contract read; nothing in the UI is mocked. Prices and resolutions come from the labeled mock
venue (`mock-venue:*`), and the app shows that label on every screen that uses them.

The run used an isolated stack, because the demo resolves a market and that cannot be undone:

    cd services/basis-node && npx tsx src/main.ts --sandbox --data /tmp/basis-web-stack --rpc-port 3041 --port 8841
    BASIS_API=http://127.0.0.1:8841 DEMO_MARKET=pm-gold-above-3000 pnpm --filter @basis/web capture

| File | What it shows |
| --- | --- |
| `01-markets.png` | Markets page: every admitted market, executable mids from the latest signed mark, depth, offered leverage, access chip |
| `02-connect-dev-key.png` | Signer picker with the sandbox dev keys (labeled sandbox only) |
| `03-portfolio-faucet.png` | Portfolio after minting 1,000 test USDC from the token faucet |
| `04-trade-composer.png` | Trade page: mark history chart, order book depth, composer set to 5x YES with $100 margin |
| `05-composer-payout-and-warnings.png` | Composer preview from `preview_open`: max loss = margin, profit and total payout from entry, fees, +100% does not auto-close note, jump-risk warning, quote expiry |
| `06-confirm-with-market-rules.png` | Confirmation dialog with the market rules sheet (policy epoch and hash, windows, leverage cap and why it shrinks, fees, maintenance, resolution source) before signing |
| `07-order-requested.png` | Order tracker right after signing: Requested, waiting for keeper execution |
| `08-order-executed-position-open.png` | Order Executed; position OPEN with the contract's entry price, units and max payout |
| `09-positions-open.png` | Positions table: executable bid, uncapped unrealized P&L, max payout, liquidation price, fees |
| `10-admin-mock-venue-controls.png` | Admin console "MOCK VENUE CONTROLS (simulated prices)" panel, YES set to 66c |
| `11-trade-price-moved.png` | Trade page after the oracle relays the new simulated mark |
| `12-plus-100-percent-still-open.png` | Position above +100% on margin and still OPEN (no forced take-profit) |
| `13-vault.png` | Vault: bLP price, NAV components, free vs reserved liquidity, stress budgets, withdrawal queue |
| `14-protocol-stats.png` | Protocol statistics: NAV history, solvency, fee split, realized trader P&L, conservation check vs token balance |
| `15-risk-monitor.png` | Risk monitor: per-scenario trader and hedge P&L, payout reserve, stress loss vs event cap, oracle freshness, reconciliation |
| `16-admin-guardian-close-only.png` | Guardian dev key sets the market to close-only |
| `17-trade-close-only.png` | Trade page showing the market as Close only |
| `18-admin-mock-resolution.png` | Mock resolution submitted (YES wins) by the dev resolution reporters |
| `19-settlement-payout.png` | Position history: SETTLED with the payout and realized P&L |
| `20-activity-audit-log.png` | Activity: the contract's sequenced audit events, simulated fills labeled |
| `21-portfolio-after-settlement.png` | Portfolio after the settlement payout landed in the wallet |
| `demo-walkthrough.webm` | Screen recording of the whole run above, 1600x1000 |

## Live Polymarket, hedging, resolution and TEE (22 onward)

Captured with `CAPTURE=extras`, which leaves 01-21 alone. It admits a real Polymarket market
(read-only from polymarket.com, so it needs internet) and resolves a mock market, so it ran on its
own isolated stack:

    cd services/basis-node && npx tsx src/main.ts --sandbox --data /tmp/basis-web-stack2 --rpc-port 3042 --port 8842
    BASIS_API=http://127.0.0.1:8842 CAPTURE=extras pnpm --filter @basis/web capture

`LIVE_SLUG=<polymarket slug>` picks the live market; by default the script takes the first binary
market in the top 30 by 24h volume that trades between 12c and 88c and resolves more than 14 days
out. The hedge venue for live markets is PAPER: fills are priced against the live Polymarket book,
no order is placed, and every receipt is labeled `paper`. Mock fixture fills are labeled `sim`.

| File | What it shows |
| --- | --- |
| `22-admin-admit-live-form.png` | Admin console, Live Polymarket tab: top 30 live markets with prices and protocol version, one picked, family and HEDGE_REQUIRED strategy set |
| `23-admin-admit-live-result.png` | Admission done through the timelocked governance path: new market id, admin propose tx and risk-council approve tx |
| `24-trade-live-polymarket-market.png` | The admitted market's trade page: Live Polymarket chip, mark source `polygon:137:polymarket-clob`, link to the Polymarket event, live quote |
| `25-trade-live-polymarket-book.png` | The live Polymarket CLOB book from the signed mark |
| `26-hedging-after-hedged-trade.png` | Hedge executor page after two HEDGE_REQUIRED opens: PAPER mode banner, no executor key, custody equal to the contract's hedge_units, reconciliation matches |
| `27-hedging-fills-and-receipts.png` | Executor ledger fills (one `paper` fill on the live market, one `sim` fill on the ETH fixture) and the contract's hedge fill receipts |
| `28-resolution-panel-proposal.png` | Resolution panel on a mock market after a dev resolution: Pending, scenario, quorum time, finalize-after countdown, both reporters with report ids and source hashes |
| `29-resolution-panel-live-observations.png` | Resolution panel on the live market: no proposal yet, plus the resolver's two sources (Polymarket resolution API and the Conditional Tokens contract on Polygon) |
| `30-tee-panel.png` | Risk monitor TEE panel: require_attested_marks off on this sandbox, no pinned TEE programs, every reporter unattested, no TEE executor keys |
| `31-positions-maintenance-ramp.png` | Positions with effective maintenance and the pre-resolution ramp sentence for each position |
| `live-hedging-walkthrough.webm` | Screen recording of steps 22 to 31, 1600x1000 |
