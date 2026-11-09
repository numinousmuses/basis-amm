# Testnet proofs

The spec section 11 acceptance suite ran end to end on NEAR testnet on 2026-11-09: **16 of 16 tests passed**,
the same file that runs on the local sandbox (`BASIS_TARGET=testnet`). Venue marks and hedge fills come from the labeled mock venue;
every NEAR transaction below is real.

- Contract: [`core.basislive211107.testnet`](https://testnet.nearblocks.io/address/core.basislive211107.testnet)
- Collateral token (tUSDC, no value): [`usdc.basislive211107.testnet`](https://testnet.nearblocks.io/address/usdc.basislive211107.testnet)

| Step | Transaction |
|---|---|
| 8. all-or-none rejected + refunded | [7UMi2uTHoJ39...](https://testnet.nearblocks.io/txns/7UMi2uTHoJ39CnVivQpTSYwCQC9XfE4nwjNCMYe61N2R) |
| 8/12. partial fill (default ON) executed | [AkEciBGvA6bt...](https://testnet.nearblocks.io/txns/AkEciBGvA6btNxbgPrfFTYxBmPuSDAicN3Vsodk7STND) |
| 3. open 5x YES POOL_ONLY $100 @0.50 | [6ryjUoWB42jx...](https://testnet.nearblocks.io/txns/6ryjUoWB42jxTbeVPpnbTEwm4ffoud5bs3fAuY7gNQqC) |
| 4. partial close 50% at executable bid $0.60 | [FbBaWerq6cLn...](https://testnet.nearblocks.io/txns/FbBaWerq6cLnc9EwiZBAL7qJVk9otV6YEd7Mw5PSEmXH) |
| 4. take-profit trigger at $0.66 | [2mjuqXJfb8Kg...](https://testnet.nearblocks.io/txns/2mjuqXJfb8KgbtY6egwZBzdVMc4uq4CMgfo41agixZhF) |
| 4. stop-loss trigger at $0.44 | [DsZTzp5qtuR1...](https://testnet.nearblocks.io/txns/DsZTzp5qtuR1ZZTjNNrpoQBYhk5b91iVtEEyP1Cyv128) |
| 4. early full close | [CTA4MZJqvEJR...](https://testnet.nearblocks.io/txns/CTA4MZJqvEJR5XtQcCKX6X2VzcyPTabbhwkErZFdMBND) |
| 4b. permissionless liquidation (keeper reward transfer fails -> claimable) | [96W7DSg4QX6t...](https://testnet.nearblocks.io/txns/96W7DSg4QX6tTJsDpJwH6SRWbdQfJ9zvcCo6y2bcxb9j) |
| 10. failed callback recovered via claim() | [AZNt94frzBGj...](https://testnet.nearblocks.io/txns/AZNt94frzBGjQ5VfQeWZDqoxoBRCFZjDAtmstcGttHyC) |
| 4b. gap-to-zero liquidation | [7tMGZciXBf6p...](https://testnet.nearblocks.io/txns/7tMGZciXBf6ph3UJNngYT48mq2kWpQ7vuCgDbBEGmVvE) |
| 6. YES fill vs vault | [CTuVTC7CKKNP...](https://testnet.nearblocks.io/txns/CTuVTC7CKKNPKX3wuNQZtzM8XyZCPxrRcQ9gkobrtEbz) |
| 6. NO fill vs vault (separate) | [JAHCmKXpsvpS...](https://testnet.nearblocks.io/txns/JAHCmKXpsvpSby7zTR1hZDbMm4ihZ8eVPaiHy65Rbbwh) |
| 5. finalize BTC YES | [GXaWXjMvvLAB...](https://testnet.nearblocks.io/txns/GXaWXjMvvLABzDZijtHsc1JbMErNKbe63s4S7k1EmNXk) |
| 5. settle BTC positions | [2G2jvTT7cyUy...](https://testnet.nearblocks.io/txns/2G2jvTT7cyUyvzaXHADYUzyvafS3LhEoJhiqJZaCyAmE) |
| 5b. hedge capital to executor custody | [8RGyiRAo8DHs...](https://testnet.nearblocks.io/txns/8RGyiRAo8DHsxhUXe4VyTrJpPFfe5x2sWKWQaNo1q9sd) |
| 5b. simulated exact-share hedge fill | [GiwFDNzuaMZU...](https://testnet.nearblocks.io/txns/GiwFDNzuaMZU5ckL99Qx5KGjSxvn76J9ib4HvtMPf716) |
| 5b. hedge redemption at invalid 0.50 payout | [FjbneM5WSyQw...](https://testnet.nearblocks.io/txns/FjbneM5WSyQwXjAA64zRTafZbCmDXThEFrnsV6KvEYfG) |
| 5b. custody returned | [HBmZKhWiA7yn...](https://testnet.nearblocks.io/txns/HBmZKhWiA7ynyyDrMS3vjajtMCjLvd92e1Jze5EpmaCA) |
| 3b. hedge budget committed to executor | [J9tdwkWfxBcf...](https://testnet.nearblocks.io/txns/J9tdwkWfxBcfcuYq87DkjsM1iMgfSfWSvJKYo77JJKdC) |
| 3b. HEDGE_REQUIRED finalized OPEN | [CwjmAytszDec...](https://testnet.nearblocks.io/txns/CwjmAytszDecmQi7bU9BPkNt1C62JwVwo7ZJEe1xByKx) |
| 8. HEDGE_REQUIRED partial 60% finalized | [CWLJ4okumABA...](https://testnet.nearblocks.io/txns/CWLJ4okumABAS4q2sKvqmSmmknsrXBgKuSKSGAYLjrHH) |
| 8. all-or-none HEDGE_REQUIRED refunded | [6zwNgGwL1jAf...](https://testnet.nearblocks.io/txns/6zwNgGwL1jAfeXFAHMN5u1aMJRd7mQJ6KyAnXDLGAMgz) |
| 10. reconciliation mismatch freezes opens | [82m279dS72Ci...](https://testnet.nearblocks.io/txns/82m279dS72CiG7d2pDTh7kVxv9btwk8xcPxNSzgVqoov) |
| 10. orphan write-off: insurance first | [72WjbhcuMzf1...](https://testnet.nearblocks.io/txns/72WjbhcuMzf1TKc5k25nku78LtRrkGXMBVdqGtW4LHxF) |
| 7. propose new weather market (no redeploy) | [9HFECk31hxSL...](https://testnet.nearblocks.io/txns/9HFECk31hxSLJWRuQtMekDSNaf3UQKCri4J6rt5uCHPz) |
| 7. CLOSE_ONLY policy v2 activated during catalyst | [319vB9dZ1Di4...](https://testnet.nearblocks.io/txns/319vB9dZ1Di45y4We1tHCYUadAYn5NQe35g1Dw3ai7Pf) |
| 10. weather market finalized after dispute + reset | [94RzvdA2QQUs...](https://testnet.nearblocks.io/txns/94RzvdA2QQUsKbXmnqCSVbMmEtS6P8XEpPV9mZX2GGg2) |
| 11. naive $0.80 5x quote rejected FAIR_VALUE | [7YvBAwJLiaFL...](https://testnet.nearblocks.io/txns/7YvBAwJLiaFLQXN7WvxZ16UXFdcqmVGEWraDVFtuXVNh) |
| 11. repriced to 2.7x and opened | [A31oamLMU65j...](https://testnet.nearblocks.io/txns/A31oamLMU65j3RKLusGY3D5zXWNAPm8DA8kfsPMDeocE) |
| adv. small LP withdrawal settled | [CduAE3ntY3Zc...](https://testnet.nearblocks.io/txns/CduAE3ntY3ZcaYsJFmhfuXN2ZpCHPmhixSD1q3RAHwVQ) |

Deployment transactions:

| Action | Transaction |
|---|---|
| create:core | [NiMSHmJsZSrU...](https://testnet.nearblocks.io/txns/NiMSHmJsZSrUC1EL71fjSYHfZDRhdRSxekqKCBUDWEK) |
| create:usdc | [4YwDDMXq9QEy...](https://testnet.nearblocks.io/txns/4YwDDMXq9QEyVcedUWr8PFWzKzZwgAQznY8npSNjT5v1) |
| create:admin | [BHkJVjGP8Vo1...](https://testnet.nearblocks.io/txns/BHkJVjGP8Vo1jHu3ZZCtM5TDdTivsiTcgPJMqpnwKQzs) |
| create:risk | [HbG2GeeZsmSD...](https://testnet.nearblocks.io/txns/HbG2GeeZsmSDhhtLouQxJQLZdam6w2gccR3oh8CoXRJD) |
| create:guardian | [HcX4gR4ZLoTD...](https://testnet.nearblocks.io/txns/HcX4gR4ZLoTDsoinYdMBogabdqg8ACo8qvXiCyoEK3c3) |
| create:keeper | [HFBKDnVRcCpd...](https://testnet.nearblocks.io/txns/HFBKDnVRcCpdjaCESyFQ56nuMHrGDUfifgBswmM2EnjE) |
| create:executor | [FjibPE8fr7Jx...](https://testnet.nearblocks.io/txns/FjibPE8fr7JxgSRcbpEs7WaRbs2wqwU9MD647v2TQYh3) |
| create:lp | [CuzkNekWp5a7...](https://testnet.nearblocks.io/txns/CuzkNekWp5a7cT3WjeA9Cszy3DKapU3gBH2CqDQsLJWc) |
| create:alice | [FmH2q1DZ3H7X...](https://testnet.nearblocks.io/txns/FmH2q1DZ3H7X1RBJQnUwZrV7M6W6WKiUsnLnNU9WY5Yo) |
| create:bob | [EVrRv8Q3tyD6...](https://testnet.nearblocks.io/txns/EVrRv8Q3tyD61jsU9P18eCMHuuCUSKbicp2xZxesA6Cy) |
| create:carol | [Fwtr6jcT3Ffp...](https://testnet.nearblocks.io/txns/Fwtr6jcT3FfpXZ8XqoWUVUWbAr2tJ1KuAtMRDJe4WgFC) |
| create:dave | [AzzrCsDFeTki...](https://testnet.nearblocks.io/txns/AzzrCsDFeTkif8yXMmc6tgrUfVFubXaDgQmadXE9pkJ5) |
| deploy:usdc | [9TKKi9rZ1tqD...](https://testnet.nearblocks.io/txns/9TKKi9rZ1tqD1nCGp11d15JgjzChBkg1qDXuT8cBsuJj) |
| init:usdc | [ArrRLS8bR8c9...](https://testnet.nearblocks.io/txns/ArrRLS8bR8c9WGHArAaACUEDvEqXDWG7XDccKXubWPxM) |
| deploy:core | [8VcJNfpwCLEn...](https://testnet.nearblocks.io/txns/8VcJNfpwCLEncPgdyPZAM2mwVf4RPTGzzuSzk1N4D6jG) |
| init:core | [EN5ppciULxst...](https://testnet.nearblocks.io/txns/EN5ppciULxst889q73wfJYYQqYuPonXyLjakZan65koU) |
| propose:pm-gold-above-3000 | [vdxBuDYTurSV...](https://testnet.nearblocks.io/txns/vdxBuDYTurSVUD5STdpBJCxuTGMV1W2EXZMhNji9h34) |
| propose:pm-btc-above-100k-daily | [E6h7EeC71gbx...](https://testnet.nearblocks.io/txns/E6h7EeC71gbx4pFVLJr7Z13MLdcx5N2kUhsSz67JdfNC) |
| propose:pm-eth-above-4k-weekly | [CjuyuDmZWw4S...](https://testnet.nearblocks.io/txns/CjuyuDmZWw4Sz54GT86ZV5UjSNiVr7TCbLtKTENRRepw) |
| propose:pm-sol-above-300-weekly | [ELc2cqnd33at...](https://testnet.nearblocks.io/txns/ELc2cqnd33atYrFvqEyjBZSvoX1Bb2xWH6P5LLj7zrKE) |
| propose:pm-senate-control-2026 | [EEPNA2Vkfbde...](https://testnet.nearblocks.io/txns/EEPNA2VkfbdebAYKPh2j1AbWmD8Q5U9kwRRSKnV5dqkF) |
| propose:pm-fed-dec-decision | [CVNp2KavvweV...](https://testnet.nearblocks.io/txns/CVNp2KavvweViQQaBLk5sSG1d4vDuUmq3WcJGVWPGbfk) |
| propose:pm-nba-lakers-celtics | [7tbCxcuajY4x...](https://testnet.nearblocks.io/txns/7tbCxcuajY4xJmm6ZPvh3yye2s59pPZWQfGN1aiGb7aC) |
| approve:1 | [LQH9NxEgrbjc...](https://testnet.nearblocks.io/txns/LQH9NxEgrbjcAY1CqUFrDgDPdiYnUsnRc95cJvMEstN) |
| approve:2 | [Cppi7E8XNY9i...](https://testnet.nearblocks.io/txns/Cppi7E8XNY9igT3JzVQu8M5MEpBNfRKgVieV31Cp273E) |
| approve:3 | [Kfkqgm7MNgbi...](https://testnet.nearblocks.io/txns/Kfkqgm7MNgbinnhijZRczsDJ9SHZsrz3BQt27Ytbaj6) |
| approve:4 | [39yqw272MYe5...](https://testnet.nearblocks.io/txns/39yqw272MYe5eZp3zJjPvJTcrjnPeR1aGUTFEqsZRF5a) |
| approve:5 | [Et9bcNSLJUZd...](https://testnet.nearblocks.io/txns/Et9bcNSLJUZdD9shk7Zj7etJTb7jZuD3rerFSCWvbDDK) |
| approve:6 | [ABNiu68X688Q...](https://testnet.nearblocks.io/txns/ABNiu68X688QGcwUEgnrTs6kBNSsaU5LDFn6MnZKbJCH) |
| approve:7 | [4C85dxVAkr5F...](https://testnet.nearblocks.io/txns/4C85dxVAkr5FGfuemwxeVesjgHZAD5oQfXkWsqCN7Zbx) |
| insurance_seed | [9KdesVs195qo...](https://testnet.nearblocks.io/txns/9KdesVs195qouhLyJrDgcV23VLKSwJRUPMUwsZqsXKuG) |
| lp_deposit | [CfVNCTaqD1Sc...](https://testnet.nearblocks.io/txns/CfVNCTaqD1ScHax9D7rj5PF5L9Af5FGSwHUPRCmjgbrQ) |

## Live Polymarket on testnet (contract v3)

Contract [`core.basisv349012.testnet`](https://testnet.nearblocks.io/address/core.basisv349012.testnet). Live market: Polymarket `us-announces-end-of-iranian-blockade-by-november-30-2026`; resolved market: `will-joe-biden-get-coronavirus-before-the-election`. Hedge fills are PAPER fills computed against the live Polymarket order book; no Polymarket order was placed. NEAR transactions are real testnet transactions.

| Step | Transaction | Detail |
|---|---|---|
| admit live market us-announces-end-of-iranian-blockade-by-november-30-2026 (propose) | [85ZwRtQJqavr...](https://testnet.nearblocks.io/txns/85ZwRtQJqavr3cyN9jsKTGSit6U1qw2qdsq8dsxdNNdr) |  |
| admit live market us-announces-end-of-iranian-blockade-by-november-30-2026 (approve after timelock) | [2a4VKD1NosjY...](https://testnet.nearblocks.io/txns/2a4VKD1NosjYm5mMWRuCzq7tofWqJFtVspThCjwDMGwW) |  |
| admit resolved market will-joe-biden-get-coronavirus-before-the-election (approve) | [AWmU8Zfd3FcK...](https://testnet.nearblocks.io/txns/AWmU8Zfd3FcKE1bQr9bmNCvD2mWniLgLVYYQEW5gL3vr) |  |
| alice signs a 2x $25 YES order (ft_transfer_call) | [2LQ7zag9hM5K...](https://testnet.nearblocks.io/txns/2LQ7zag9hM5K3mq6RTQcZ7e2NUusUwcifjMRZpw92fWU) |  |
| vault hedged at the live Polymarket ask (paper fill) | `paper:0x6dc7975871f62a...` | 217.391304 shares @ 0.23 |
| position OPEN at the contract's entry price |  | entry 0.230002, units 217.390359 |
| alice requests close | [FKTqo7SDpV3A...](https://testnet.nearblocks.io/txns/FKTqo7SDpV3AzHUTdowqWm8Ssa4ezW3ChAL2QWkeWBau) |  |
| position CLOSED at the live bid |  | paid out $22.778051 |
| executor unwound the hedge at the live bid (paper fill) | `paper:0x76f16f4f80db18...` | 217.391304 shares @ 0.219999 |
| resolution votes from Polymarket API and CTF contract agree |  | scenario 1 (final-pm-live-resolved-demo-1794249558583000000, final-pm-live-resolved-demo-1794249560977000000) |
| resolved market finalized and Settled |  | resolved_scenario 1 |
