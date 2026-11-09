# basis-node API

Base URL defaults to `http://127.0.0.1:8797`. JSON, CORS open. Amounts are decimal strings in
micro-units (6 decimals); prices in 1e6; leverage in 1e4. The API never signs for users.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | uptime, keeper counters, last indexed event |
| GET | `/api/stack` | network, RPC, contract and token ids, roles, quote key, `simulatedVenue` |
| GET | `/api/markets` | every market with mark (`mark_source`: onchain or signed-offchain), actions, risk, policy |
| GET | `/api/markets/:id` | market detail, policy history, resolution, hedge fills |
| GET | `/api/markets/:id/marks?since&limit` | mark history (mids, best bid/ask, report id) |
| GET | `/api/markets/:id/positions` | open positions |
| GET | `/api/policies/:hash` | a policy version |
| GET | `/api/vault` | vault summary, conservation, config, pause flags, withdrawal queue |
| GET | `/api/vault/history?since` | NAV, share price, reserves over time |
| GET | `/api/events?from&limit&kind` | mirrored onchain audit events |
| GET | `/api/accounts/:id` | positions, orders, withdrawals, claimable, balances |
| POST | `/api/quote` | `{market_id, outcome_id, margin, leverage, max_fee?}` -> contract preview, admissibility, reprice suggestion, signed quote id |
| GET | `/api/reconciliation` | last reconciler result per market |
| GET | `/api/executor/fills` | mock executor fill ledger |
| GET | `/api/manifests` | example manifests and their contract form |
| GET | `/api/polymarket/discover?limit` | live Polymarket markets (read-only Gamma API) |
| GET | `/api/polymarket/status` | hedge venue (mock/paper/live), executor address, signer audit, spend and caps, custody, resolver observations |
| GET | `/api/polymarket/market/:slug` | live Polymarket market via the SDK |
| POST | `/api/dev/admit-polymarket` | dev controls: `{slug, family?, strategy?}` admits a live market through governance |
| GET | `/api/dev/accounts` | sandbox only: dev account keys |
| POST | `/api/dev/venue` | dev controls: `{market_id, mids}` or `{market_id, clear: true}` sets mock prices |
| POST | `/api/dev/resolve` | dev controls: `{market_id, scenario, status?}` submits mock resolution votes |

WebSocket `/ws` pushes `{type: "event" | "mark" | "vault", ...}`.
