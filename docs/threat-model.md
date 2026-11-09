# Threat model

Scope: `basis-core` on NEAR plus the off-chain services. Assets at risk: LP capital, trader
margin and claims, insurance. Trust assumptions are listed first because the protocol is only as
strong as them.

## Trusted parties and what each can do

| Party | Can | Cannot |
|---|---|---|
| Admin | propose markets and policies, register adapters and reporters, set roles | activate a policy before the timelock, move funds |
| Risk council | approve policies, change market state, reset disputes, write off hedges | withdraw funds, change open positions' terms |
| Guardian | pause opens, LP mint/burn, withdrawals; set close-only; pause a market; dispute | lift any restriction, move funds |
| Mark reporter | sign MARK reports | resolve markets, bypass freshness or spread guards |
| Resolution reporters | vote outcomes once the venue reports resolved | finalize before quorum and the dispute window |
| Keeper | execute committed orders, triggers, settlement | pick a mark older than the order commit |
| Executor | hold hedge budget, post fill receipts | exceed the reserved size, signed slippage, custody budget or policy hedge budget |

The executor and the reporters are trusted operators. A compromised mark key can push any price
inside the spread and freshness guards. With `require_attested_marks`, mark keys exist only inside
the TEE oracle program on OutLayer TDX workers, which also refuses to sign when a second source
disagrees (`docs/tee-oracle.md`); the residual trust is in OutLayer's worker attestation and in the
venue data itself. A compromised executor can lie about Polygon fills; the
reconciler and `write_off_hedge` limit the damage to the hedge budget, and synthetic claims never
depend on hedge proceeds because the payout reserve gives hedges no credit.

## Attacks considered and the control

| Attack | Control | Test |
|---|---|---|
| Forged or tampered mark | ed25519 over a domain-separated digest of the Borsh report | acceptance 9 |
| Mark key used outside the TEE | key derived from a TEE-generated PROTECTED secret bound to the WASM hash; only attested keys accepted when required; admin cannot self-declare attestation | tee.test.ts |
| Hedge executor key abuse | key lives in executor-tee (TEE, PROTECTED secret); signs only ClobAuth and bounded Orders on allowlisted exchanges; Session Key cannot withdraw; per-order and daily caps in basis-node | executor-tee tests, live suite |
| Venue settlement lies | real receipts carry settlement tx hash and block; reconciler double-checks inventory; Polygon inclusion is still not proven onchain | docs/hedging.md |
| Wrong resolution | API and Conditional Tokens contract read independently, signed by different reporters; mismatch disputes | live suite, testnet demo |
| Single-source price manipulation | TEE program cross-checks CLOB book mid against Gamma prices before signing | oracle-tee tests |
| Stale mark / replay of an older mark | policy staleness, `valid_until`, monotonic source time | acceptance 9, 10 |
| Last look (mark chosen after seeing the order) | execution needs a mark observed after the commit; execution is keeper-only | acceptance 9, adversarial |
| Thin-book or wide-spread manipulation | depth walk for the real size, exit-depth guard, absolute spread guard | acceptance 12 |
| Selling floor value for free | fair-price gate on hold-to-resolution trader EV | acceptance 11 |
| Over-commitment of LP capital | scenario reserve per event, global cap, free-liquidity gate | acceptance 8/12 |
| LP bank run on reserved capital | withdrawals only from free liquidity, FIFO queue, NAV freshness | adversarial |
| Policy switched under an in-flight order | intent pins the policy hash; execution rejects on change | acceptance 7/8 |
| Nonce replay / legacy intent without partial-fill field | per-account nonce set; field has no default | adversarial |
| Duplicate, wrong-token, out-of-slippage or unauthorized hedge receipts | receipt validation | acceptance 5b |
| Double finalization of a hedged order | state machine, exactly-once | acceptance 3b |
| Orphan hedge inventory | reconciler freezes opens on the market | acceptance 3b, node tests |
| Payout to an unregistered account | failed transfer callback restores the claim | acceptance 4b |
| Gap through the liquidation price | equity floored at zero, loss accounted to the vault, never charged to the user | acceptance 4b |
| Conflicting or premature resolutions | quorum, venue status check, dispute freeze | acceptance 9, 10 |
| bLP inflation by first-depositor donation | virtual share offset | `basis-math` vault tests |
| Rounding in the user's favour | units and payouts floor, fees and reserves ceil | `basis-math` property tests |

## Out of scope

Bridge and custody of real Polygon assets, legal eligibility, frontend supply chain, NEAR
validator failures, and key management beyond single keys per role.
