//! SANDBOX ONLY stand-in for `outlayer.near`. It enforces the one property the contract relies on
//! from OutLayer (a request for WASM hash H only gets output produced by H) by checking the hash and
//! returning output the test obtained by running the real `oracle-tee` program natively. It does
//! not run WASM and provides no TEE guarantee.

use near_sdk::serde_json::Value;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, PanicOnDefault, env, near, require};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    /// wasm hash -> mode -> JSON output
    outputs: LookupMap<String, String>,
    requests: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, outputs: LookupMap::new(b"o".to_vec()), requests: 0 }
    }

    /// Owner records the output the pinned program produces for a mode.
    pub fn set_output(&mut self, wasm_hash: String, mode: String, output: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.outputs.insert(format!("{wasm_hash}:{mode}"), output);
    }

    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        input_data: Option<String>,
        resource_limits: Value,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
    ) -> Value {
        let _ = (resource_limits, secrets_ref, response_format, payer_account_id);
        self.requests += 1;
        let hash = source["WasmUrl"]["hash"].as_str().unwrap_or_default().to_string();
        let mode = input_data
            .as_deref()
            .and_then(|s| near_sdk::serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v["mode"].as_str().map(String::from))
            .unwrap_or_default();
        let out = self.outputs.get(&format!("{hash}:{mode}")).cloned();
        let out = out.unwrap_or_else(|| env::panic_str("WASM hash mismatch or unknown program"));
        near_sdk::serde_json::from_str(&out).unwrap()
    }

    pub fn requests(&self) -> u64 {
        self.requests
    }
}
