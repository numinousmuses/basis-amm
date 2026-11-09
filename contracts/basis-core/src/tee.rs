//! TEE-attested reporter registration through OutLayer.
//!
//! The admin asks OutLayer to run the oracle WASM (pinned URL + SHA-256) in `pubkey` mode. OutLayer
//! only lets workers whose Intel TDX measurements match an approved build resolve executions, and
//! refuses binaries whose hash differs from the request. The WASM derives its key from a
//! `PROTECTED_` secret that is generated inside the TEE and bound to that WASM hash. So the public
//! key arriving in `on_tee_reporter` belongs to a private key that only the pinned program, inside
//! an attested enclave, can use. Reports are then verified by signature at use time (the same
//! model OutLayer itself uses), and the full TDX attestation stays auditable offchain.

use crate::types::*;
use crate::*;

pub(crate) const GAS_OUTLAYER: Gas = Gas::from_tgas(100);
pub(crate) const GAS_TEE_CALLBACK: Gas = Gas::from_tgas(20);

#[near]
impl Contract {
    /// Attach NEAR to pay OutLayer; unused funds are refunded by OutLayer to the caller.
    #[payable]
    pub fn request_tee_reporter(&mut self, label: String, can_mark: bool, can_resolve: bool) -> Promise {
        self.assert_admin();
        let tee = self.config.tee.clone().unwrap_or_else(|| fail("TEE_NOT_CONFIGURED", ""));
        require!(env::attached_deposit() > NearToken::from_yoctonear(0), "TEE_PAYMENT_REQUIRED");
        let args = json!({
            "source": {"WasmUrl": {"url": tee.wasm_url, "hash": tee.wasm_hash, "build_target": tee.build_target}},
            "input_data": json!({"mode": "pubkey"}).to_string(),
            "resource_limits": {"max_execution_seconds": tee.max_execution_seconds},
            "secrets_ref": {"profile": tee.secrets_profile, "account_id": tee.secrets_owner},
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        self.emit("tee_registration_requested", json!({"label": label, "wasm_hash": tee.wasm_hash, "outlayer": tee.outlayer_contract}));
        Promise::new(tee.outlayer_contract.clone())
            .function_call("request_execution".to_string(), args.to_string().into_bytes(), env::attached_deposit(), GAS_OUTLAYER)
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_tee_reporter".to_string(),
                    json!({"label": label, "can_mark": can_mark, "can_resolve": can_resolve, "wasm_hash": tee.wasm_hash, "outlayer": tee.outlayer_contract}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_TEE_CALLBACK,
                ),
            )
    }

    #[private]
    pub fn on_tee_reporter(&mut self, label: String, can_mark: bool, can_resolve: bool, wasm_hash: String, outlayer: AccountId) -> String {
        // The pinned build may have rotated while the request was in flight.
        let tee = self.config.tee.clone().unwrap_or_else(|| fail("TEE_NOT_CONFIGURED", ""));
        require!(tee.wasm_hash == wasm_hash && tee.outlayer_contract == outlayer, "TEE_CONFIG_CHANGED");
        let bytes = match env::promise_result_checked(0, 4096) {
            Ok(b) => b,
            Err(_) => {
                self.emit("tee_registration_failed", json!({"label": label, "reason": "outlayer execution failed"}));
                return "TEE_EXECUTION_FAILED".into();
            }
        };
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        // OutLayer may wrap the program's JSON output; accept either shape.
        let out = if v.get("public_key").is_some() { v.clone() } else { v.get("output").cloned().unwrap_or(Value::Null) };
        let pk = out.get("public_key").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let ok = out.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
        let valid = ok && hex_decode(&pk).map(|b| b.len() == 32).unwrap_or(false);
        if !valid {
            self.emit("tee_registration_failed", json!({"label": label, "reason": "bad program output"}));
            return "TEE_BAD_OUTPUT".into();
        }
        let info = ReporterInfo {
            public_key: pk.clone(),
            label: label.clone(),
            can_mark,
            can_resolve,
            attestation_measurement: format!("outlayer-tdx:{outlayer}:wasm_sha256={wasm_hash}"),
            active: true,
            tee_attested: true,
        };
        self.reporters.insert(pk.clone(), info);
        self.emit("tee_reporter_registered", json!({"label": label, "public_key": pk, "wasm_hash": wasm_hash}));
        format!("TEE_REPORTER:{pk}")
    }
}

#[near]
impl Contract {
    /// Register the hedge executor's Polymarket session key: OutLayer runs the pinned executor-tee
    /// build in `address` mode and the callback records the address it derived inside the TEE.
    /// The Deposit Wallet Owner then authorizes exactly this address as a CLOB-scoped Session Key.
    #[payable]
    pub fn request_tee_executor(&mut self, label: String) -> Promise {
        self.assert_admin();
        let tee = self.config.tee_executor.clone().unwrap_or_else(|| fail("TEE_NOT_CONFIGURED", "tee_executor"));
        require!(env::attached_deposit() > NearToken::from_yoctonear(0), "TEE_PAYMENT_REQUIRED");
        let args = json!({
            "source": {"WasmUrl": {"url": tee.wasm_url, "hash": tee.wasm_hash, "build_target": tee.build_target}},
            "input_data": json!({"mode": "address"}).to_string(),
            "resource_limits": {"max_execution_seconds": tee.max_execution_seconds},
            "secrets_ref": {"profile": tee.secrets_profile, "account_id": tee.secrets_owner},
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        Promise::new(tee.outlayer_contract.clone())
            .function_call("request_execution".to_string(), args.to_string().into_bytes(), env::attached_deposit(), GAS_OUTLAYER)
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_tee_executor".to_string(),
                    json!({"label": label, "wasm_hash": tee.wasm_hash, "outlayer": tee.outlayer_contract}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_TEE_CALLBACK,
                ),
            )
    }

    #[private]
    pub fn on_tee_executor(&mut self, label: String, wasm_hash: String, outlayer: AccountId) -> String {
        let tee = self.config.tee_executor.clone().unwrap_or_else(|| fail("TEE_NOT_CONFIGURED", ""));
        require!(tee.wasm_hash == wasm_hash && tee.outlayer_contract == outlayer, "TEE_CONFIG_CHANGED");
        let Ok(bytes) = env::promise_result_checked(0, 4096) else {
            self.emit("tee_executor_failed", json!({"label": label, "reason": "outlayer execution failed"}));
            return "TEE_EXECUTION_FAILED".into();
        };
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let out = if v.get("address").is_some() { v.clone() } else { v.get("output").cloned().unwrap_or(Value::Null) };
        let addr = out.get("address").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let valid = out.get("ok").and_then(|x| x.as_bool()).unwrap_or(false)
            && addr.len() == 42
            && addr.starts_with("0x")
            && hex_decode(&addr[2..].to_lowercase()).is_some();
        if !valid {
            self.emit("tee_executor_failed", json!({"label": label, "reason": "bad program output"}));
            return "TEE_BAD_OUTPUT".into();
        }
        self.tee_executors.push(TeeExecutorKey { evm_address: addr.clone(), label: label.clone(), wasm_hash: wasm_hash.clone(), registered_ns: U64(now()), active: true });
        self.emit("tee_executor_registered", json!({"label": label, "evm_address": addr, "wasm_hash": wasm_hash}));
        format!("TEE_EXECUTOR:{addr}")
    }

    /// Guardian or risk council retires an executor key (pair with revoking its Session Key).
    pub fn deactivate_tee_executor(&mut self, evm_address: String) {
        self.assert_guardian_or_risk();
        for k in self.tee_executors.iter_mut().filter(|k| k.evm_address.eq_ignore_ascii_case(&evm_address)) {
            k.active = false;
        }
        self.emit("tee_executor_deactivated", json!({"evm_address": evm_address}));
    }

    pub fn get_tee_executors(&self) -> Vec<TeeExecutorKey> {
        self.tee_executors.clone()
    }
}
