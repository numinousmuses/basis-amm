# Hedging on Polymarket

The vault is the counterparty to every trader. Markets with a hedged strategy also hold exact
Polymarket outcome shares, owned by the vault and run by the hedge executor
(`services/basis-node/src/executor.ts`).

## What the executor does

| Step | Trigger | Venue action | NEAR action |
|---|---|---|---|
| Commit | `HEDGE_REQUIRED` order reaches `RiskReserved` | none | `commit_hedge` moves the reserved budget into executor custody |
| Fill | order is `Hedging` | FAK market BUY of the exact outcome for the reserved share count, capped at the user's signed slippage and the live ask plus policy slippage | `submit_hedge_fill` with the venue receipt (order id, settlement tx hash, block) |
| Finalize | order is `HedgedProvisional` | none | `finalize_open_hedged` opens the position sized to what actually filled |
| Unwind | a hedged position closes or is liquidated, or an order was rejected with fills (orphan) | FAK market SELL of those shares at the live bid less slippage | standalone SELL receipt (allowed on any market; it only reduces inventory) |
| Redeem | market `Settled` | redeem shares at the resolved payout (`redeemPositions`) | `record_hedge_redemption`, then idle custody returns with `hedge_return` |

Fills can land up to 2% over the reserved size (share rounding). The contract credits the order
only up to its reserved size and books the excess as plain vault inventory. More than 2% is
rejected.

The reconciler compares the executor's venue ledger with the contract's inventory per market. It
skips a market while a fill is between venue and NEAR, and freezes opens only when a mismatch
shows on two consecutive passes.

## Venues

| Venue | When | What it proves | What it does not |
|---|---|---|---|
| `mock-venue` | sandbox fixture markets | contract and executor wiring | anything about Polymarket |
| `polymarket-paper` (default) | live Polymarket markets | pricing, sizing, slippage bounds, FAK and 5-share minimum semantics against the live book; receipts `simulated: true`, hashes `paper:` | real execution and settlement |
| `polymarket-live` | `--polymarket live` and `BASIS_POLYMARKET_LIVE=1` | real orders, real Polygon settlement hashes and blocks | NEAR-side verification of Polygon inclusion (receipts remain operator assertions) |

## Signing: the TEE executor

`crates/executor-tee` is a WASM program for OutLayer's Intel TDX workers. Its key is derived from
a PROTECTED secret generated inside the TEE. It signs only:

- `ClobAuth` for its own address (CLOB API-key login);
- `Order` on the three Polymarket exchanges, signed by itself, for itself or its deposit wallet,
  at prices between $0.01 and $0.99 and at most $2,500 notional per order (requests can only
  tighten these limits), with a timestamp within 10 minutes of the worker clock.

It refuses message signing, transactions and wallet batches, so it cannot approve spenders or
move collateral. The Deposit Wallet Owner authorizes its address as a Polymarket Session Key with
CLOB scope only; Session Keys cannot withdraw. The contract records the address through
`request_tee_executor` / `on_tee_executor`, the same pinned-hash OutLayer callback as the oracle.

`TeeExecutorSigner` plugs into the official SDK as its `Signer`. Locally it runs the same WASM
under wasmtime (no TEE, development only).

## Resolution

`PolymarketResolver` reads each live market's resolution from two independent places and signs
each with a different reporter key:

1. Polymarket's resolution API (`fetchResolutions`: status, payout vector, resolving transaction);
2. the Conditional Tokens contract on Polygon (`payoutDenominator`, `payoutNumerators`) over a
   public RPC (v1 markets; v2 markets use the API only).

Both votes must agree for the proposal to stay `Pending`; a disagreement lands in `Disputed`. A
50/50 payout maps to the market's INVALID scenario.

## Running it

```bash
# Admit a live market on any stack (sandbox or testnet):
cd services/basis-node
npx tsx scripts/admit-polymarket.ts --discover 20
npx tsx scripts/admit-polymarket.ts --stack ../../infra/testnet/v3-stack.secret.json --slug <slug> --strategy HedgeRequired

# Paper hedging against live books (default):
npx tsx src/main.ts --stack ../../infra/testnet/v3-stack.secret.json --port 8798 --expose-dev-keys

# Whole flow on testnet with recorded transactions:
npx tsx ../../scripts/testnet-polymarket-demo.ts ../../infra/testnet/v3-stack.secret.json
```

### Live mode (real money, needs Joshua's go-ahead)

Requirements: a Polymarket Deposit Wallet funded with pUSD and trading approvals set
(`setupTradingApprovals`), a Builder or Relayer API key, and a session key: either the TEE
executor's address (production) or a local key (development). The Polymarket CLOB rejects order
POSTs from geoblocked regions (including the US); `POLYMARKET_CLOB_URL` points the SDK at a
compliant egress if needed.

```bash
export BASIS_POLYMARKET_LIVE=1
export POLYMARKET_SIGNER=tee-wasmtime            # or tee-outlayer (production) or env-key
export PROTECTED_EXECUTOR_KEY=<hex32>            # wasmtime only; on OutLayer this is a PROTECTED secret
export POLYMARKET_DEPOSIT_WALLET=0x...
export POLYMARKET_BUILDER_API_KEY=... POLYMARKET_BUILDER_SECRET=... POLYMARKET_BUILDER_PASSPHRASE=...
export BASIS_HEDGE_MAX_ORDER_USD=25 BASIS_HEDGE_MAX_DAILY_USD=100
npx tsx src/main.ts --stack <deployment.json> --polymarket live
```

`/api/polymarket/status` shows the venue, executor address, signer audit, daily spend and caps,
custody, and the resolver's observations. Nothing in this repository has placed a real Polymarket
order: every automated test uses the paper or mock venue.

## Custody across chains

Collateral on NEAR (`tUSDC` on testnet) and pUSD on Polygon are separate assets. The contract's
`hedge_custody_cash` and hedge inventory are the vault's accounting mirror of what the executor
holds on Polygon. There is no bridge in this repository; an operator funds the Polygon side and
settles the difference. A production design needs an audited bridge or a vault-held pUSD float,
plus independent reconciliation of Polygon balances (`listPositions`, ERC-1155 balances).
