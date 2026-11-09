//! `basis-core`: Basis-AMM nonrecourse synthetic leverage protocol on NEAR.
//!
//! One deployable holds the registry, the counterparty vault with its NEP-141 `bLP` share token,
//! the margin engine, the oracle report verifier and the insurance ledger, so that payout-capacity
//! reservation and position opening are atomic in a single receipt (spec section 3 allows this).
//!
//! Money: 6-decimal collateral micro-units. Prices: `[0, 1_000_000]`. See `basis-math`.

use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::fungible_token::metadata::{FT_METADATA_SPEC, FungibleTokenMetadata};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near,
    require,
};

pub mod hedge;
pub mod margin;
pub mod oracle;
pub mod registry;
pub mod tee;
pub mod types;
pub mod vault;
pub mod views;

use types::*;

pub(crate) const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub(crate) const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
pub(crate) enum StorageKey {
    Blp,
    BlpMetadata,
    Adapters,
    Markets,
    Policies,
    PolicyHistory,
    Proposals,
    Books,
    MarketPositions,
    Positions,
    UserPositions,
    Orders,
    PendingOrders,
    UserOrders,
    Nonces,
    Reporters,
    Marks,
    Resolutions,
    HedgeFills,
    MarketHedgeFills,
    Withdrawals,
    QueuedWithdrawals,
    UserWithdrawals,
    Claimable,
    Events,
}

/// Single consistent balance sheet. Every collateral micro-unit held by this contract is in
/// exactly one of: `cash`, `order_escrow`, `claimable_total`, `in_flight`, `insurance`,
/// `treasury`. `hedge_custody_cash` is vault capital held by the hedge executor off-contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Ledger {
    pub cash: u128,
    pub order_escrow: u128,
    pub claimable_total: u128,
    pub in_flight: u128,
    pub insurance: u128,
    pub treasury: u128,
    pub hedge_custody_cash: u128,
    pub total_open_margin: u128,
    pub total_payout_reserve: u128,
    pub total_stress_loss: u128,
    pub pending_withdrawal_shares: u128,
    pub fees_assessed: u128,
    pub fees_to_lp: u128,
    pub fees_to_insurance: u128,
    pub fees_to_treasury: u128,
    pub fees_uncollected: u128,
    pub realized_trader_pnl: i128,
    pub hedge_realized_pnl: i128,
    pub insurance_paid_losses: u128,
    pub lp_impairment: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) roles: Roles,
    pub(crate) config: ProtocolConfig,
    pub(crate) pending_config: Option<(ProtocolConfig, u64)>,
    pub(crate) collateral_token: AccountId,
    pub(crate) blp: FungibleToken,
    pub(crate) blp_metadata: LazyOption<FungibleTokenMetadata>,
    pub(crate) adapters: IterableSet<String>,
    pub(crate) markets: IterableMap<MarketId, Market>,
    pub(crate) policies: LookupMap<String, MarketPolicy>,
    pub(crate) policy_history: LookupMap<MarketId, Vec<String>>,
    pub(crate) proposals: IterableMap<u64, PolicyProposal>,
    pub(crate) next_proposal_id: u64,
    pub(crate) books: LookupMap<MarketId, EventBook>,
    pub(crate) market_positions: LookupMap<MarketId, Vec<PositionId>>,
    pub(crate) positions: LookupMap<PositionId, Position>,
    pub(crate) next_position_id: u64,
    pub(crate) user_positions: LookupMap<AccountId, Vec<PositionId>>,
    pub(crate) orders: LookupMap<OrderId, Order>,
    pub(crate) pending_orders: IterableSet<OrderId>,
    pub(crate) next_order_id: u64,
    pub(crate) user_orders: LookupMap<AccountId, Vec<OrderId>>,
    pub(crate) nonces: LookupSet<String>,
    pub(crate) reporters: IterableMap<String, ReporterInfo>,
    pub(crate) marks: LookupMap<MarketId, StoredMark>,
    pub(crate) resolutions: LookupMap<MarketId, ResolutionProposal>,
    pub(crate) hedge_fills: LookupMap<String, HedgeFillReceipt>,
    pub(crate) market_hedge_fills: LookupMap<MarketId, Vec<String>>,
    pub(crate) withdrawals: LookupMap<u64, Withdrawal>,
    pub(crate) queued_withdrawals: IterableSet<u64>,
    pub(crate) user_withdrawals: LookupMap<AccountId, Vec<u64>>,
    pub(crate) next_withdrawal_id: u64,
    pub(crate) claimable: LookupMap<AccountId, u128>,
    pub(crate) ledger: Ledger,
    pub(crate) pause: PauseFlags,
    pub(crate) frozen_markets: Vec<MarketId>,
    pub(crate) events: LookupMap<u64, AuditEvent>,
    pub(crate) next_event_seq: u64,
    pub(crate) tee_executors: Vec<TeeExecutorKey>,
}

pub(crate) fn now() -> u64 {
    env::block_timestamp()
}

pub(crate) fn fail(code: &str, detail: impl AsRef<str>) -> ! {
    env::panic_str(&format!("{code}: {}", detail.as_ref()))
}

pub(crate) fn math<T>(r: basis_math::MathResult<T>) -> T {
    match r {
        Ok(v) => v,
        Err(e) => fail("MATH", e.to_string()),
    }
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

pub(crate) fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let nib = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    s.as_bytes().chunks(2).map(|p| Some((nib(p[0])? << 4) | nib(p[1])?)).collect()
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TransferAction {
    LpDeposit { min_shares: U128 },
    Open { intent: OrderIntent },
    InsuranceSeed,
    PostMargin { position_id: U64 },
    HedgeReturn { market_id: MarketId, note: String },
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        collateral_token: AccountId,
        roles: Roles,
        config: ProtocolConfig,
        blp_symbol: Option<String>,
    ) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Basis-AMM LP share (testnet)".to_string(),
            symbol: blp_symbol.unwrap_or_else(|| "bLP".to_string()),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        let mut c = Self {
            roles,
            config,
            pending_config: None,
            collateral_token,
            blp: FungibleToken::new(StorageKey::Blp),
            blp_metadata: LazyOption::new(StorageKey::BlpMetadata, Some(&metadata)),
            adapters: IterableSet::new(StorageKey::Adapters),
            markets: IterableMap::new(StorageKey::Markets),
            policies: LookupMap::new(StorageKey::Policies),
            policy_history: LookupMap::new(StorageKey::PolicyHistory),
            proposals: IterableMap::new(StorageKey::Proposals),
            next_proposal_id: 1,
            books: LookupMap::new(StorageKey::Books),
            market_positions: LookupMap::new(StorageKey::MarketPositions),
            positions: LookupMap::new(StorageKey::Positions),
            next_position_id: 1,
            user_positions: LookupMap::new(StorageKey::UserPositions),
            orders: LookupMap::new(StorageKey::Orders),
            pending_orders: IterableSet::new(StorageKey::PendingOrders),
            next_order_id: 1,
            user_orders: LookupMap::new(StorageKey::UserOrders),
            nonces: LookupSet::new(StorageKey::Nonces),
            reporters: IterableMap::new(StorageKey::Reporters),
            marks: LookupMap::new(StorageKey::Marks),
            resolutions: LookupMap::new(StorageKey::Resolutions),
            hedge_fills: LookupMap::new(StorageKey::HedgeFills),
            market_hedge_fills: LookupMap::new(StorageKey::MarketHedgeFills),
            withdrawals: LookupMap::new(StorageKey::Withdrawals),
            queued_withdrawals: IterableSet::new(StorageKey::QueuedWithdrawals),
            user_withdrawals: LookupMap::new(StorageKey::UserWithdrawals),
            next_withdrawal_id: 1,
            claimable: LookupMap::new(StorageKey::Claimable),
            ledger: Ledger::default(),
            pause: PauseFlags::default(),
            frozen_markets: vec![],
            events: LookupMap::new(StorageKey::Events),
            next_event_seq: 1,
            tee_executors: vec![],
        };
        c.validate_config(&c.config.clone());
        // The contract holds escrowed bLP for queued withdrawals.
        let me = env::current_account_id();
        c.blp.internal_register_account(&me);
        c.emit("init", json!({"collateral": c.collateral_token, "admin": c.roles.admin}));
        c
    }

    // ------------------------------------------------------------ collateral entry point

    /// NEP-141 receiver for the collateral token. The amount is verified by the token contract
    /// itself (predecessor), never taken from caller-provided numbers.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.collateral_token, "UNSUPPORTED_COLLATERAL");
        let action: TransferAction = serde_json::from_str(&msg).unwrap_or_else(|e| fail("BAD_MSG", e.to_string()));
        let amount = amount.0;
        let unused = match action {
            TransferAction::LpDeposit { min_shares } => self.internal_lp_deposit(&sender_id, amount, min_shares.0),
            TransferAction::Open { intent } => self.internal_request_open(&sender_id, amount, intent),
            TransferAction::InsuranceSeed => {
                self.ledger.insurance += amount;
                self.emit("insurance_seed", json!({"from": sender_id, "amount": U128(amount)}));
                0
            }
            TransferAction::PostMargin { position_id } => self.internal_post_margin(&sender_id, position_id.0, amount),
            TransferAction::HedgeReturn { market_id, note } => self.internal_hedge_return(&sender_id, amount, market_id, note),
        };
        PromiseOrValue::Value(U128(unused))
    }

    // ------------------------------------------------------------ claims / payouts

    /// Transfer the caller's claimable collateral (close proceeds, settlements, refunds, rewards).
    pub fn claim(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.claimable.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "NOTHING_TO_CLAIM");
        self.claimable.remove(&who);
        self.ledger.claimable_total -= amount;
        self.transfer_out(who, amount)
    }

    #[private]
    pub fn on_transfer_out(&mut self, receiver: AccountId, amount: U128) -> bool {
        self.ledger.in_flight -= amount.0;
        let ok = env::promise_results_count() == 1 && matches!(env::promise_result_checked(0, 64), Ok(_));
        if !ok {
            // Receiver not registered or token failure: keep the funds claimable, never lose them.
            *self.claimable.entry(receiver.clone()).or_insert(0) += amount.0;
            self.ledger.claimable_total += amount.0;
            self.emit("transfer_failed", json!({"receiver": receiver, "amount": amount}));
        }
        ok
    }

    // ------------------------------------------------------------ roles and config

    pub fn set_roles(&mut self, roles: Roles) {
        self.assert_admin();
        self.roles = roles;
        self.emit("roles_updated", json!({}));
    }

    /// Timelocked protocol config change.
    pub fn propose_config(&mut self, config: ProtocolConfig) {
        self.assert_admin();
        self.validate_config(&config);
        let eta = now() + self.config.policy_timelock_ns.0;
        self.pending_config = Some((config, eta));
        self.emit("config_proposed", json!({"eta_ns": U64(eta)}));
    }

    pub fn apply_config(&mut self) {
        self.assert_admin_or_risk();
        let (cfg, eta) = self.pending_config.clone().unwrap_or_else(|| fail("NO_PENDING_CONFIG", ""));
        require!(now() >= eta, "TIMELOCK_ACTIVE");
        self.config = cfg;
        self.pending_config = None;
        self.emit("config_applied", json!({}));
    }

    // ------------------------------------------------------------ guardian (restrict only)

    pub fn pause_opens(&mut self) {
        self.assert_guardian_or_risk();
        self.pause.opens = true;
        self.emit("guardian", json!({"action": "pause_opens"}));
    }

    pub fn pause_lp_mint_burn(&mut self) {
        self.assert_guardian_or_risk();
        self.pause.lp_mint_burn = true;
        self.emit("guardian", json!({"action": "pause_lp_mint_burn"}));
    }

    pub fn pause_withdrawals(&mut self) {
        self.assert_guardian_or_risk();
        self.pause.withdrawals = true;
        self.emit("guardian", json!({"action": "pause_withdrawals"}));
    }

    pub fn pause_market(&mut self, market_id: MarketId) {
        self.assert_guardian_or_risk();
        let mut m = self.market(&market_id);
        m.guardian_paused = true;
        self.markets.insert(market_id.clone(), m);
        self.emit("guardian", json!({"action": "pause_market", "market_id": market_id}));
    }

    pub fn set_close_only(&mut self, market_id: MarketId) {
        self.assert_guardian_or_risk();
        let mut m = self.market(&market_id);
        m.guardian_close_only = true;
        self.markets.insert(market_id.clone(), m);
        self.emit("guardian", json!({"action": "set_close_only", "market_id": market_id}));
    }

    /// Lifting restrictions is not a guardian power: admin or risk council only.
    pub fn lift_restrictions(&mut self, market_id: Option<MarketId>) {
        self.assert_admin_or_risk();
        match market_id {
            Some(id) => {
                let mut m = self.market(&id);
                m.guardian_close_only = false;
                m.guardian_paused = false;
                self.markets.insert(id.clone(), m);
                self.frozen_markets.retain(|x| x != &id);
                self.emit("restrictions_lifted", json!({"market_id": id}));
            }
            None => {
                self.pause = PauseFlags::default();
                self.emit("restrictions_lifted", json!({"global": true}));
            }
        }
    }
}

// ---------------------------------------------------------------- internal helpers

impl Contract {
    pub(crate) fn emit(&mut self, kind: &str, data: Value) {
        let seq = self.next_event_seq;
        self.next_event_seq += 1;
        let data_s = data.to_string();
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard": "basis-amm", "version": "1.0.0", "event": kind, "data": [{"seq": seq.to_string(), "detail": data}]})
        ));
        let cap = self.config.event_log_capacity.max(1) as u64;
        self.events.insert(
            seq % cap,
            AuditEvent { seq: U64(seq), ts_ns: U64(now()), block: U64(env::block_height()), kind: kind.to_string(), data: data_s },
        );
    }

    pub(crate) fn assert_admin(&self) {
        require!(env::predecessor_account_id() == self.roles.admin, "UNAUTHORIZED: admin");
    }

    pub(crate) fn assert_admin_or_risk(&self) {
        let p = env::predecessor_account_id();
        require!(p == self.roles.admin || p == self.roles.risk_council, "UNAUTHORIZED: admin or risk council");
    }

    pub(crate) fn assert_risk(&self) {
        require!(env::predecessor_account_id() == self.roles.risk_council, "UNAUTHORIZED: risk council");
    }

    pub(crate) fn assert_guardian_or_risk(&self) {
        let p = env::predecessor_account_id();
        require!(p == self.roles.guardian || p == self.roles.risk_council, "UNAUTHORIZED: guardian");
    }

    pub(crate) fn assert_executor(&self) {
        let p = env::predecessor_account_id();
        require!(self.roles.executors.contains(&p), "UNAUTHORIZED: executor");
    }

    pub(crate) fn assert_keeper(&self) {
        let p = env::predecessor_account_id();
        require!(self.roles.keepers.contains(&p) || self.roles.executors.contains(&p), "UNAUTHORIZED: keeper");
    }

    pub(crate) fn market(&self, id: &MarketId) -> Market {
        self.markets.get(id).cloned().unwrap_or_else(|| fail("UNKNOWN_MARKET", id))
    }

    pub(crate) fn policy(&self, hash: &str) -> MarketPolicy {
        self.policies.get(hash).cloned().unwrap_or_else(|| fail("UNKNOWN_POLICY", hash))
    }

    pub(crate) fn book(&self, id: &MarketId) -> EventBook {
        self.books.get(id).cloned().unwrap_or_else(|| fail("UNKNOWN_MARKET", id))
    }

    pub(crate) fn validate_config(&self, c: &ProtocolConfig) {
        require!(c.max_leverage_ceiling.0 >= basis_math::LEV_SCALE, "CONFIG: leverage ceiling");
        require!(c.global_stress_cap_bps as u128 <= basis_math::BPS, "CONFIG: global stress cap");
        require!(c.max_event_stress_cap_bps <= c.global_stress_cap_bps, "CONFIG: event cap above global");
        require!((c.max_hedge_budget_bps as u128) <= basis_math::BPS, "CONFIG: hedge budget");
        require!((c.max_fee_bps_bound as u128) <= basis_math::BPS, "CONFIG: fee bound");
        require!(c.event_log_capacity >= 16, "CONFIG: event log capacity");
        require!(!c.require_attested_marks || c.tee.is_some(), "CONFIG: attested marks need a TEE config");
        if let Some(t) = &c.tee_executor {
            require!(t.wasm_hash.len() == 64 && hex_decode(&t.wasm_hash).is_some(), "CONFIG: tee executor wasm hash");
            require!(t.wasm_url.starts_with("https://"), "CONFIG: tee executor wasm url");
        }
        if let Some(t) = &c.tee {
            require!(t.wasm_hash.len() == 64 && hex_decode(&t.wasm_hash).is_some(), "CONFIG: tee wasm hash");
            require!(t.wasm_url.starts_with("https://"), "CONFIG: tee wasm url");
        }
    }

    /// Credit collateral to `who` and attempt an immediate transfer; on failure it stays
    /// claimable. Caller must already have removed `amount` from its source bucket.
    pub(crate) fn pay(&mut self, who: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        self.transfer_out(who.clone(), amount).detach();
    }

    pub(crate) fn transfer_out(&mut self, receiver: AccountId, amount: u128) -> Promise {
        self.ledger.in_flight += amount;
        Promise::new(self.collateral_token.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({"receiver_id": receiver, "amount": U128(amount), "memo": "basis-amm"}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_transfer_out".to_string(),
                    json!({"receiver": receiver, "amount": U128(amount)}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_CALLBACK,
                ),
            )
    }
}

#[cfg(test)]
mod tests;
