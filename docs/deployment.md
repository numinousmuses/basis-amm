# Deployment

## Local sandbox

```bash
infra/local-dev/install-sandbox.sh
scripts/build-contracts.sh
cd services/basis-node && npx tsx src/main.ts --sandbox
```

State lives in `infra/local-dev/data` (gitignored). Delete it for a fresh deploy. If the node is
killed hard, stop the orphaned `near-sandbox` process by its PID.

## NEAR testnet

1. Fund a master account. The faucet gives 10 NEAR per account; a stack needs about 27 NEAR
   (the 711 KB contract locks about 7.2 NEAR of storage, and every signer needs ~0.31 NEAR free
   because NEAR reserves prepaid gas at a pessimistic price). `scripts/faucet-master.sh basis 2`
   creates a master and pools two more faucet accounts into it. The faucet rate-limits per IP.
2. Deploy: `npx tsx scripts/deploy-testnet.ts <master>.testnet live`. Role keys go to
   `infra/testnet/live-stack.secret.json` (gitignored, written incrementally so a failed deploy
   never strands keys). Public ids and explorer links go to `docs/integration-proofs/`.
3. Run the services: `cd services/basis-node && npx tsx src/main.ts --stack ../../infra/testnet/live-stack.secret.json --port 8798`.
   On testnet the oracle runs lean: it signs every market each tick but only pushes marks onchain
   for markets with open exposure, and on demand before quotes and executions.
4. Point the dashboard at it: `VITE_API_URL=http://127.0.0.1:8798 pnpm --filter @basis/web dev`.
   Use MyNearWallet or Meteor on testnet; mint `tUSDC` from the faucet button.

## Running the dashboard against your testnet stack

`scripts/dev.sh testnet infra/testnet/<name>-stack.secret.json` starts basis-node in lean mode
with `--expose-dev-keys`, which serves that stack's role keys to the LOCAL dashboard so you can
trade as alice/bob/carol and act as admin, risk council or guardian. Never run that flag on a
publicly reachable host. To trade with your own wallet instead, use MyNearWallet or Meteor in
Settings and mint tUSDC from the faucet button.

Add a live Polymarket market to the stack from the Admin console ("Admit a live Polymarket
market") or with `services/basis-node/scripts/admit-polymarket.ts`; see `docs/hedging.md`.

## Before any real funds

Independent audit, legal review, a real collateral token and custody design, an attested oracle
with a second source, a validated Polygon execution path, and the section 14 decisions.
