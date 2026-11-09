# TEE oracle

The mark oracle is a WASM program (`crates/oracle-tee`) that runs on OutLayer's Intel TDX
workers. Its signing key is generated inside the TEE and only that exact binary can use it. The
contract accepts MARK reports only from keys it registered through OutLayer for that binary.

## Trust chain

```text
 Intel TDX quote ──> worker.outlayer.near verifies measurements (MRTD, RTMR0-3) and registers the
                     worker key; only registered workers can resolve executions
 OutLayer request ─> pins WasmUrl + SHA-256 of oracle-tee.wasm; a different binary is refused
 PROTECTED secret ─> PROTECTED_ORACLE_KEY generated inside the TEE, bound to the WASM hash, never
                     seen by any person; the program derives its ed25519 key from it
 basis-core ───────> request_tee_reporter -> OutLayer runs {"mode":"pubkey"} -> on_tee_reporter
                     registers the returned key with tee_attested = true
 every mark ───────> the program fetches books, cross-checks a second source, signs; the contract
                     verifies the signature and, with require_attested_marks, rejects other keys
```

What each link proves:

- TDX attestation proves which binary ran and what it output. It does not prove the venue told the
  truth or that the data is fresh (OutLayer's own docs say the same).
- So the program refuses to sign when the CLOB book mid and the Gamma API price for any outcome
  differ by more than `max_divergence_bps` (300 by default), and the contract still enforces
  staleness, monotonic source time, commit ordering, spread and depth on every report.
- Resolution is not taken from the TEE. It still needs the venue's resolved status, a reporter
  quorum and the dispute window, because a TEE opinion is not onchain finality.

## Contract surface

| Item | What it does |
|---|---|
| `ProtocolConfig.tee` | OutLayer contract, WASM URL, WASM SHA-256, build target, secrets profile and owner. Changed only through the timelocked `propose_config` / `apply_config` |
| `ProtocolConfig.require_attested_marks` | When true, `verify_mark` rejects reports from keys without `tee_attested` (`ORACLE_UNATTESTED`) |
| `request_tee_reporter(label, can_mark, can_resolve)` | Admin, payable. Calls `request_execution` on OutLayer with the pinned source and `{"mode":"pubkey"}` |
| `on_tee_reporter` | Private callback. Rejects if the pinned config changed in flight, the execution failed, or the output is malformed; otherwise registers the key as attested with measurement `outlayer-tdx:<contract>:wasm_sha256=<hash>` |
| `register_reporter` | Still available for dev keys and resolution reporters, but always stores `tee_attested = false`: an admin cannot self-declare attestation |

Rotating the program (new release): build, publish the WASM, `propose_config` with the new hash,
wait out the timelock, `request_tee_reporter` again, then have the guardian deactivate the old key.

## Offchain path

Signing a mark per order through a NEAR callback would add a cross-contract round trip to every
execution. Instead, keepers fetch signed marks over OutLayer's HTTPS API (`POST
https://api.outlayer.ai/call/<owner>/<project>`, `X-Payment-Key`) and relay them as they do today.
The signature is checked at use time; each response's `job_id` links to its full TDX attestation at
`https://app.outlayer.ai/attestation/<job_id>`, which basis-node keeps per report id.

`services/basis-node` signers:

- `--tee-outlayer <owner/project>` with `OUTLAYER_PAYMENT_KEY`: the production path.
- `--tee-wasmtime <oracle-tee.wasm>` with `PROTECTED_ORACLE_KEY`: runs the same WASM locally under
  wasmtime with real HTTP. Development only: same code, no TEE, never register that key as attested.

Both apply to markets whose outcome refs are live CLOB token ids (`polygon:ctf:<decimal id>`). The
mock-venue fixture markets keep the dev signer.

## Program interface

stdin `{"mode":"pubkey"}` -> `{"ok":true,"public_key":"<hex>","scheme":"ed25519"}` (well under the
900-byte onchain output limit).

stdin `{"mode":"mark","contract_id","market_id","outcomes":[{"outcome_id","token_id"}],"max_divergence_bps"?,"levels"?,"valid_for_s"?}`
-> `{"ok":true,"signed":{report, public_key, signature}}` or `{"ok":false,"error":"SECOND_SOURCE_DIVERGENCE ..."}`.
The report digest is byte-identical to the contract's `report_digest` (tested against `basis-core`).
Callers may pass `books` and `reference_prices` for offline tests; such reports carry
`source_chain = polygon:137:polymarket-clob:offline-input` so they can never pass as live data.

## What is verified, and how

| Check | Where |
|---|---|
| Digest and signature identical to the contract's verifier | `cargo test -p oracle-tee` (`digest_and_signature_match_basis_core`) |
| Refuses to sign on second-source divergence; secret never in output | `cargo test -p oracle-tee` |
| The `wasm32-wasip2` build runs and fetches live Polymarket books and Gamma prices | `wasmtime run -S http` and `BASIS_LIVE_TESTS=1 pnpm --filter @basis/node test` |
| Contract registers attested keys only via the pinned OutLayer callback; wrong hash yields nothing; unattested marks rejected; trades execute on TEE-signed marks | `tests/e2e/test/tee.test.ts` on nearcore sandbox |

The sandbox test uses `contracts/mock-outlayer`, a sandbox-only stand-in that returns the real
program's output only for the pinned hash. It proves the contract wiring, not TDX execution.

## Not done yet

Going live needs an OutLayer account: publish `out/oracle-tee.wasm` (`scripts/build-oracle-tee.sh`
prints its hash), create `PROTECTED_ORACLE_KEY` as a PROTECTED hex32 secret bound to that hash in
the OutLayer dashboard, create a payment key, then call `request_tee_reporter` with a NEAR deposit
and set `require_attested_marks`. That account and key are Joshua's to create; nothing in this
repo has run on a real TDX worker yet.
