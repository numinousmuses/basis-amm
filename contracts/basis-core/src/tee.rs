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
