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
