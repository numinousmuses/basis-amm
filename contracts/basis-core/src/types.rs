//! Canonical typed structures (spec section 9). JSON uses string-encoded U64/U128 so JavaScript
//! clients never lose precision. There is no category enum and no binary-only side enum: markets
//! carry an ordered outcome list and a payout-scenario matrix as data.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

pub type MarketId = String;
pub type PositionId = u64;
pub type OrderId = u64;

// ---------------------------------------------------------------- registry / policy

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketState {
    Unlisted,
    PendingReview,
    Active,
    CloseOnly,
    Suspended,
    Resolving,
    Settled,
    Invalid,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrategyMode {
    /// Fully reserve bounded user profit; no external hedge order.
    PoolOnly,
    /// Open against LP reserves, then optionally hedge net exposure with vault-owned inventory.
    PoolPlusHedge,
    /// Do not open until a configured hedge fills.
    HedgeRequired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutcomeInstrument {
    pub outcome_id: u8,
    pub label: String,
    /// Venue token reference with explicit chain/domain, e.g. `polygon:ctf:<token id>`.
    pub venue_token_ref: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutScenario {
    pub label: String,
    /// Payout per unit of each outcome in this scenario, price scale (1_000_000 == $1).
    pub payouts: Vec<U128>,
}

/// Venue-neutral market descriptor. `category_label` is display-only metadata and is never
/// branched on by contract logic.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketDescriptor {
    pub market_id: MarketId,
    pub venue: String,
    pub chain: String,
    pub external_market_id: String,
    pub underlying_event: String,
    pub category_label: String,
    pub outcomes: Vec<OutcomeInstrument>,
    pub scenarios: Vec<PayoutScenario>,
    pub resolution_adapter_id: String,
    pub resolution_source: String,
    pub event_start_ns: U64,
    pub expected_resolution_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ActionSet {
    pub open: bool,
    pub increase: bool,
    pub reduce: bool,
    pub close: bool,
    pub liquidate: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowMode {
    CloseOnly,
    Suspend,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventWindow {
    pub label: String,
    pub start_ns: U64,
    pub end_ns: U64,
    pub mode: WindowMode,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeSchedule {
    pub open_bps: u16,
    pub close_bps: u16,
    pub hold_apr_bps: u16,
    pub liquidation_reward_bps: u16,
    pub liquidation_reward_cap: U128,
    /// Share of the hold-to-resolution floor value charged as risk premium (fair-price gate).
    pub floor_coverage_bps: u16,
    pub insurance_share_bps: u16,
    pub treasury_share_bps: u16,
}

/// Versioned, hash-pinned market policy. All numbers are data chosen by governance; contract code
/// only enforces protocol-wide bounds and invariants.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketPolicy {
    pub schema_version: u16,
    pub risk_model_id: String,
    pub executor_adapter_id: String,
    pub pricing_adapter_id: String,
    pub strategy: StrategyMode,
    pub allowed_actions: ActionSet,
    pub entry_start_ns: U64,
    pub entry_end_ns: U64,
    pub event_windows: Vec<EventWindow>,
    pub max_leverage: U128,
    pub min_adverse_ticks: u32,
    pub tick_size: U128,
    pub min_margin: U128,
    pub max_margin: U128,
    pub max_open_units_per_outcome: U128,
    pub max_payout_liability: U128,
    pub maintenance_bps: u16,
    pub maintenance_fixed: U128,
    pub max_spread_bps: u16,
    /// Exit depth required at execution, as bps of the position's units.
    pub exit_depth_bps: u16,
    pub max_mark_staleness_ns: U64,
    pub min_resolution_reporters: u8,
    pub dispute_window_ns: U64,
    pub fees: FeeSchedule,
    pub event_stress_cap_bps: u16,
    pub hedge_budget_bps: u16,
    pub max_hedge_slippage_bps: u16,
    pub min_fill_floor_ppm: U128,
    pub max_order_lifetime_ns: U64,
    /// Maintenance rises linearly from `maintenance_bps` to this value over the `maintenance_ramp_ns`
    /// before the descriptor's expected resolution. It only ever liquidates LOSING positions.
    pub pre_resolution_maintenance_bps: u16,
    pub maintenance_ramp_ns: U64,
    pub governance_approval: String,
    pub human_readable_rules: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PolicyProposal {
    pub market_id: MarketId,
    pub policy: MarketPolicy,
    pub policy_hash: String,
    pub proposed_by: AccountId,
    pub proposed_ns: U64,
    pub eta_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Market {
    pub descriptor: MarketDescriptor,
    pub state: MarketState,
    pub policy_hash: String,
    pub policy_epoch: u32,
    pub listed_ns: U64,
    /// Guardian/risk restrictions that only tighten (never widen) the policy.
    pub guardian_close_only: bool,
    pub guardian_paused: bool,
    pub resolved_scenario: Option<u8>,
}

// ---------------------------------------------------------------- oracle

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportKind {
    Mark,
    Risk,
    FinalResolution,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VenueStatus {
    Open,
    Paused,
    Closed,
    Resolved,
    Invalid,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookLevel {
    pub price: U128,
    pub size: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutcomeBook {
    pub outcome_id: u8,
    /// Descending prices.
    pub bids: Vec<BookLevel>,
    /// Ascending prices.
    pub asks: Vec<BookLevel>,
}

/// Attested observation. Signed by a registered reporter key over
/// `sha256("BASIS_AMM_ORACLE_V1" || contract_account_id || borsh(report))`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OracleReport {
    pub kind: ReportKind,
    pub report_id: String,
    pub market_id: MarketId,
    pub source_chain: String,
    pub observed_block: U64,
    pub source_timestamp_ns: U64,
    pub fetch_timestamp_ns: U64,
    pub valid_until_ns: U64,
    pub outcomes: Vec<OutcomeBook>,
    pub fee_schedule_version: u32,
    pub tick_size: U128,
    pub market_status: VenueStatus,
    pub final_scenario: Option<u8>,
    pub source_hash: String,
    pub attestation_ref: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignedReport {
    pub report: OracleReport,
    /// Hex-encoded 32-byte ed25519 public key.
    pub public_key: String,
    /// Hex-encoded 64-byte ed25519 signature.
    pub signature: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ReporterInfo {
    pub public_key: String,
    pub label: String,
    pub can_mark: bool,
    pub can_resolve: bool,
    /// OutLayer/TEE measurement or other attestation the reporter claims. Recorded for audit; it
    /// binds code to inputs/outputs, not the truth of the external source.
    pub attestation_measurement: String,
    pub active: bool,
    /// Set only by `on_tee_reporter`: the key was returned by OutLayer for the pinned WASM hash.
    pub tee_attested: bool,
}

/// OutLayer TEE execution settings for the oracle program (spec section 1: attested offchain WASM).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeeConfig {
    /// `outlayer.near` / `outlayer.testnet` (or a labeled mock on sandbox).
    pub outlayer_contract: AccountId,
    /// Public HTTPS URL of the oracle-tee WASM.
    pub wasm_url: String,
    /// SHA-256 of that WASM, hex. OutLayer refuses to run a binary with a different hash.
    pub wasm_hash: String,
    pub build_target: String,
    /// OutLayer secrets profile holding `PROTECTED_ORACLE_KEY` (bound to the WASM hash).
    pub secrets_profile: String,
    pub secrets_owner: AccountId,
    pub max_execution_seconds: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct StoredMark {
    pub report: OracleReport,
    pub reporter: String,
    pub stored_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolutionStatus {
    Collecting,
    Pending,
    Disputed,
    Finalized,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ResolutionProposal {
    pub market_id: MarketId,
    pub scenario: u8,
    pub reporters: Vec<String>,
    pub report_ids: Vec<String>,
    pub source_hashes: Vec<String>,
    pub status: ResolutionStatus,
    pub quorum_ns: U64,
    pub finalize_after_ns: U64,
    pub dispute_reason: Option<String>,
}

// ---------------------------------------------------------------- orders and positions

/// Immutable order intent frozen in the user's own signed NEAR transaction (the `msg` of
/// `ft_transfer_call` on the collateral token). `allow_partial_fill` has no serde default: a
/// legacy client that omits it fails to parse instead of being silently opted in.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderIntent {
    pub nonce: U64,
    pub market_id: MarketId,
    pub outcome_id: u8,
    pub margin_amount: U128,
    pub requested_leverage: U128,
    pub max_entry_price: U128,
    pub max_hedge_slippage_bps: u16,
    pub max_fee: U128,
    pub deadline_ns: U64,
    pub take_profit_price: Option<U128>,
    pub stop_loss_price: Option<U128>,
    pub allow_partial_fill: bool,
    pub minimum_acceptable_fill_ppm: U128,
    pub policy_hash: String,
    pub quote_id: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderState {
    Requested,
    RiskReserved,
    Hedging,
    HedgedProvisional,
    Executed,
    Cancelled,
    Expired,
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderKind {
    Open { intent: OrderIntent },
    Close { position_id: U64, fraction_ppm: U128, min_exit_price: U128, deadline_ns: U64 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Order {
    pub order_id: U64,
    pub owner: AccountId,
    pub kind: OrderKind,
    pub state: OrderState,
    pub commit_ns: U64,
    pub escrow: U128,
    pub mode: StrategyMode,
    pub policy_hash: String,
    /// Hedge-required reservation (terms at reserved size) while awaiting hedge fills.
    pub reserved_terms: Option<TermsView>,
    pub reserved_fees: U128,
    pub reserved_hedge_budget: U128,
    pub hedge_fill_ids: Vec<String>,
    pub hedge_units: U128,
    pub hedge_cost: U128,
    pub result: Option<String>,
    pub position_id: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TermsView {
    pub margin: U128,
    pub notional: U128,
    pub units: U128,
    pub entry_price: U128,
    pub leverage: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PositionState {
    Open,
    Closed,
    Liquidated,
    Settled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub position_id: U64,
    pub owner: AccountId,
    pub market_id: MarketId,
    pub outcome_id: u8,
    pub terms: TermsView,
    pub mode: StrategyMode,
    pub state: PositionState,
    pub opened_ns: U64,
    pub fee_accrued_ns: U64,
    pub accrued_hold_fees: U128,
    pub open_fee_paid: U128,
    pub risk_premium_paid: U128,
    pub hold_apr_bps: u16,
    pub close_bps: u16,
    pub maintenance_bps: u16,
    pub maintenance_fixed: U128,
    pub liquidation_reward_bps: u16,
    pub liquidation_reward_cap: U128,
    pub policy_hash: String,
    pub policy_epoch: u32,
    pub order_id: U64,
    pub fill_fraction_ppm: U128,
    pub take_profit_price: Option<U128>,
    pub stop_loss_price: Option<U128>,
    pub realized_pnl: String,
    pub paid_out: U128,
    pub quote_id: String,
    pub entry_report_id: String,
    pub hedge_fill_ids: Vec<String>,
    /// Pre-resolution maintenance ramp pinned at open (spec "maintenance curve").
    pub ramp_maintenance_bps: u16,
    pub ramp_start_ns: U64,
    pub ramp_end_ns: U64,
    pub closed_ns: Option<U64>,
}

// ---------------------------------------------------------------- vault, hedge, insurance

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct EventBook {
    /// Sum of open positions' terminal P&L per scenario (floored at -M each, no positive clamp).
    pub trader_pnl: Vec<i128>,
    /// Vault-owned hedge inventory units per outcome.
    pub hedge_units: Vec<u128>,
    /// Cost basis per outcome.
    pub hedge_cost: Vec<u128>,
    /// Open reference units per outcome.
    pub open_units: Vec<u128>,
    pub open_margin: u128,
    pub open_positions: u32,
    /// max_s max(0, trader_pnl[s]): liquidity reservation, no credit for offchain hedge proceeds.
    pub payout_reserve: u128,
    /// max_s max(0, trader_pnl[s] - hedge_pnl[s]): stress loss used for NAV risk budgets.
    pub stress_loss: u128,
    pub max_payout_liability: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct HedgeFillReceipt {
    pub fill_id: String,
    pub market_id: MarketId,
    pub outcome_id: u8,
    pub venue_token_ref: String,
    pub side_buy: bool,
    pub units: U128,
    pub price: U128,
    pub fee: U128,
    pub venue_order_id: String,
    pub tx_hash: String,
    pub chain: String,
    pub block_number: U64,
    pub order_id: Option<U64>,
    pub executed_ns: U64,
    /// Explicit label so a simulated fill can never be presented as a real venue fill.
    pub simulated: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Withdrawal {
    pub withdrawal_id: U64,
    pub owner: AccountId,
    pub shares: U128,
    pub min_out: U128,
    pub requested_ns: U64,
    pub status: WithdrawalStatus,
    pub paid: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WithdrawalStatus {
    Queued,
    Settled,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ProtocolConfig {
    /// Absolute protocol leverage ceiling (timelocked governance); markets may only be stricter.
    pub max_leverage_ceiling: U128,
    pub global_stress_cap_bps: u16,
    pub policy_timelock_ns: U64,
    pub min_lp_deposit: U128,
    pub nav_staleness_ns: U64,
    pub min_insurance_for_opens: U128,
    pub max_positions_per_market: u32,
    pub max_fee_bps_bound: u16,
    pub max_event_stress_cap_bps: u16,
    pub max_hedge_budget_bps: u16,
    pub blp_transferable: bool,
    pub event_log_capacity: u32,
    /// When true, MARK reports are accepted only from TEE-attested reporters.
    pub require_attested_marks: bool,
    pub tee: Option<TeeConfig>,
    /// Pinned executor-tee build for the hedge executor's Polymarket session key.
    pub tee_executor: Option<TeeConfig>,
}

/// A hedge-executor signing key registered through OutLayer for a pinned executor-tee build.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TeeExecutorKey {
    pub evm_address: String,
    pub label: String,
    pub wasm_hash: String,
    pub registered_ns: U64,
    pub active: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Roles {
    pub admin: AccountId,
    pub risk_council: AccountId,
    pub guardian: AccountId,
    pub executors: Vec<AccountId>,
    pub keepers: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default)]
pub struct PauseFlags {
    pub opens: bool,
    pub lp_mint_burn: bool,
    pub withdrawals: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AuditEvent {
    pub seq: U64,
    pub ts_ns: U64,
    pub block: U64,
    pub kind: String,
    pub data: String,
}

// ---------------------------------------------------------------- views

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultSummary {
    pub cash: U128,
    pub total_assets: U128,
    pub hedge_custody_cash: U128,
    pub hedge_inventory_value: U128,
    pub user_claim_liability: U128,
    pub nav: String,
    pub blp_supply: U128,
    pub share_price: U128,
    pub open_margin: U128,
    pub payout_reserve: U128,
    pub stress_loss: U128,
    pub free_liquidity: U128,
    pub insurance_balance: U128,
    pub treasury_balance: U128,
    pub order_escrow: U128,
    pub claimable_total: U128,
    pub pending_withdrawal_shares: U128,
    pub fees_assessed: U128,
    pub fees_to_lp: U128,
    pub fees_to_insurance: U128,
    pub fees_to_treasury: U128,
    pub realized_trader_pnl: String,
    pub hedge_realized_pnl: String,
    pub insurance_paid_losses: U128,
    pub lp_impairment: U128,
    pub nav_fresh: bool,
    pub tracked_collateral: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RiskSummary {
    pub market_id: MarketId,
    pub state: MarketState,
    pub open_positions: u32,
    pub open_margin: U128,
    pub open_units: Vec<U128>,
    pub trader_pnl_by_scenario: Vec<String>,
    pub hedge_pnl_by_scenario: Vec<String>,
    pub payout_reserve: U128,
    pub stress_loss: U128,
    pub event_stress_cap: U128,
    pub hedge_units: Vec<U128>,
    pub hedge_cost: Vec<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PositionView {
    pub position: Position,
    pub mark_bid: Option<U128>,
    pub equity_at_bid: Option<U128>,
    pub unrealized_pnl: Option<String>,
    pub pending_hold_fees: U128,
    pub max_profit: U128,
    pub max_payout: U128,
    pub liquidation_price: U128,
    pub effective_maintenance_bps: u16,
    pub liquidatable: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EffectiveActions {
    pub market_id: MarketId,
    pub state: MarketState,
    pub open: bool,
    pub reduce: bool,
    pub close: bool,
    pub liquidate: bool,
    pub reasons: Vec<String>,
}
