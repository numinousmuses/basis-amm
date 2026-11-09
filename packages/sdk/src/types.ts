/** JSON shapes of the `basis-core` contract. U64/U128 are decimal strings. */
export type U64 = string;
export type U128 = string;

export type MarketState =
  | "Unlisted"
  | "PendingReview"
  | "Active"
  | "CloseOnly"
  | "Suspended"
  | "Resolving"
  | "Settled"
  | "Invalid";
export type StrategyMode = "PoolOnly" | "PoolPlusHedge" | "HedgeRequired";
export type ReportKind = "Mark" | "Risk" | "FinalResolution";
export type VenueStatus = "Open" | "Paused" | "Closed" | "Resolved" | "Invalid";
export type OrderState =
  | "Requested"
  | "RiskReserved"
  | "Hedging"
  | "HedgedProvisional"
  | "Executed"
  | "Cancelled"
  | "Expired"
  | "Rejected";
export type PositionState = "Open" | "Closed" | "Liquidated" | "Settled";

export interface OutcomeInstrument {
  outcome_id: number;
  label: string;
  venue_token_ref: string;
}
export interface PayoutScenario {
  label: string;
  payouts: U128[];
}
export interface MarketDescriptor {
  market_id: string;
  venue: string;
  chain: string;
  external_market_id: string;
  underlying_event: string;
  category_label: string;
  outcomes: OutcomeInstrument[];
  scenarios: PayoutScenario[];
  resolution_adapter_id: string;
  resolution_source: string;
  event_start_ns: U64;
  expected_resolution_ns: U64;
}
export interface ActionSet {
  open: boolean;
  increase: boolean;
  reduce: boolean;
  close: boolean;
  liquidate: boolean;
}
export interface EventWindow {
  label: string;
  start_ns: U64;
  end_ns: U64;
  mode: "CloseOnly" | "Suspend";
}
export interface FeeSchedule {
  open_bps: number;
  close_bps: number;
  hold_apr_bps: number;
  liquidation_reward_bps: number;
  liquidation_reward_cap: U128;
  floor_coverage_bps: number;
  insurance_share_bps: number;
  treasury_share_bps: number;
}
export interface MarketPolicy {
  schema_version: number;
  risk_model_id: string;
  executor_adapter_id: string;
  pricing_adapter_id: string;
  strategy: StrategyMode;
  allowed_actions: ActionSet;
  entry_start_ns: U64;
  entry_end_ns: U64;
  event_windows: EventWindow[];
  max_leverage: U128;
  min_adverse_ticks: number;
  tick_size: U128;
  min_margin: U128;
  max_margin: U128;
  max_open_units_per_outcome: U128;
  max_payout_liability: U128;
  maintenance_bps: number;
  maintenance_fixed: U128;
  max_spread_bps: number;
  exit_depth_bps: number;
  max_mark_staleness_ns: U64;
  min_resolution_reporters: number;
  dispute_window_ns: U64;
  fees: FeeSchedule;
  event_stress_cap_bps: number;
  hedge_budget_bps: number;
  max_hedge_slippage_bps: number;
  min_fill_floor_ppm: U128;
  max_order_lifetime_ns: U64;
  governance_approval: string;
  human_readable_rules: string;
}
export interface Market {
  descriptor: MarketDescriptor;
  state: MarketState;
  policy_hash: string;
  policy_epoch: number;
  listed_ns: U64;
  guardian_close_only: boolean;
  guardian_paused: boolean;
  resolved_scenario: number | null;
}
export interface BookLevel {
  price: U128;
  size: U128;
}
export interface OutcomeBook {
  outcome_id: number;
  bids: BookLevel[];
  asks: BookLevel[];
}
export interface OracleReport {
  kind: ReportKind;
  report_id: string;
  market_id: string;
  source_chain: string;
  observed_block: U64;
  source_timestamp_ns: U64;
  fetch_timestamp_ns: U64;
  valid_until_ns: U64;
  outcomes: OutcomeBook[];
  fee_schedule_version: number;
  tick_size: U128;
  market_status: VenueStatus;
  final_scenario: number | null;
  source_hash: string;
  attestation_ref: string;
}
export interface SignedReport {
  report: OracleReport;
  public_key: string;
  signature: string;
}
export interface ReporterInfo {
  public_key: string;
  label: string;
  can_mark: boolean;
  can_resolve: boolean;
  attestation_measurement: string;
  active: boolean;
  tee_attested: boolean;
}
export interface TeeConfig {
  outlayer_contract: string;
  wasm_url: string;
  wasm_hash: string;
  build_target: string;
  secrets_profile: string;
  secrets_owner: string;
  max_execution_seconds: number;
}
export interface StoredMark {
  report: OracleReport;
  reporter: string;
  stored_ns: U64;
}
export interface ResolutionProposal {
  market_id: string;
  scenario: number;
  reporters: string[];
  report_ids: string[];
  source_hashes: string[];
  status: "Collecting" | "Pending" | "Disputed" | "Finalized";
  quorum_ns: U64;
  finalize_after_ns: U64;
  dispute_reason: string | null;
}
export interface OrderIntent {
  nonce: U64;
  market_id: string;
  outcome_id: number;
  margin_amount: U128;
  requested_leverage: U128;
  max_entry_price: U128;
  max_hedge_slippage_bps: number;
  max_fee: U128;
  deadline_ns: U64;
  take_profit_price: U128 | null;
  stop_loss_price: U128 | null;
  allow_partial_fill: boolean;
  minimum_acceptable_fill_ppm: U128;
  policy_hash: string;
  quote_id: string;
}
export interface TermsView {
  margin: U128;
  notional: U128;
  units: U128;
  entry_price: U128;
  leverage: U128;
}
export type OrderKind =
  | { Open: { intent: OrderIntent } }
  | { Close: { position_id: U64; fraction_ppm: U128; min_exit_price: U128; deadline_ns: U64 } };
export interface Order {
  order_id: U64;
  owner: string;
  kind: OrderKind;
  state: OrderState;
  commit_ns: U64;
  escrow: U128;
  mode: StrategyMode;
  policy_hash: string;
  reserved_terms: TermsView | null;
  reserved_fees: U128;
  reserved_hedge_budget: U128;
  hedge_fill_ids: string[];
  hedge_units: U128;
  hedge_cost: U128;
  result: string | null;
  position_id: U64 | null;
}
export interface Position {
  position_id: U64;
  owner: string;
  market_id: string;
  outcome_id: number;
  terms: TermsView;
  mode: StrategyMode;
  state: PositionState;
  opened_ns: U64;
  fee_accrued_ns: U64;
  accrued_hold_fees: U128;
  open_fee_paid: U128;
  risk_premium_paid: U128;
  hold_apr_bps: number;
  close_bps: number;
  maintenance_bps: number;
  maintenance_fixed: U128;
  liquidation_reward_bps: number;
  liquidation_reward_cap: U128;
  policy_hash: string;
  policy_epoch: number;
  order_id: U64;
  fill_fraction_ppm: U128;
  take_profit_price: U128 | null;
  stop_loss_price: U128 | null;
  realized_pnl: string;
  paid_out: U128;
  quote_id: string;
  entry_report_id: string;
  hedge_fill_ids: string[];
}
export interface PositionView {
  position: Position;
  mark_bid: U128 | null;
  equity_at_bid: U128 | null;
  unrealized_pnl: string | null;
  pending_hold_fees: U128;
  max_profit: U128;
  max_payout: U128;
  liquidation_price: U128;
  liquidatable: boolean;
}
export interface HedgeFillReceipt {
  fill_id: string;
  market_id: string;
  outcome_id: number;
  venue_token_ref: string;
  side_buy: boolean;
  units: U128;
  price: U128;
  fee: U128;
  venue_order_id: string;
  tx_hash: string;
  chain: string;
  block_number: U64;
  order_id: U64 | null;
  executed_ns: U64;
  simulated: boolean;
}
export interface Withdrawal {
  withdrawal_id: U64;
  owner: string;
  shares: U128;
  min_out: U128;
  requested_ns: U64;
  status: "Queued" | "Settled" | "Cancelled";
  paid: U128;
}
export interface ProtocolConfig {
  max_leverage_ceiling: U128;
  global_stress_cap_bps: number;
  policy_timelock_ns: U64;
  min_lp_deposit: U128;
  nav_staleness_ns: U64;
  min_insurance_for_opens: U128;
  max_positions_per_market: number;
  max_fee_bps_bound: number;
  max_event_stress_cap_bps: number;
  max_hedge_budget_bps: number;
  blp_transferable: boolean;
  event_log_capacity: number;
  require_attested_marks: boolean;
  tee: TeeConfig | null;
}
export interface Roles {
  admin: string;
  risk_council: string;
  guardian: string;
  executors: string[];
  keepers: string[];
}
export interface PauseFlags {
  opens: boolean;
  lp_mint_burn: boolean;
  withdrawals: boolean;
}
export interface AuditEvent {
  seq: U64;
  ts_ns: U64;
  block: U64;
  kind: string;
  data: string;
}
export interface VaultSummary {
  cash: U128;
  total_assets: U128;
  hedge_custody_cash: U128;
  hedge_inventory_value: U128;
  user_claim_liability: U128;
  nav: string;
  blp_supply: U128;
  share_price: U128;
  open_margin: U128;
  payout_reserve: U128;
  stress_loss: U128;
  free_liquidity: U128;
  insurance_balance: U128;
  treasury_balance: U128;
  order_escrow: U128;
  claimable_total: U128;
  pending_withdrawal_shares: U128;
  fees_assessed: U128;
  fees_to_lp: U128;
  fees_to_insurance: U128;
  fees_to_treasury: U128;
  realized_trader_pnl: string;
  hedge_realized_pnl: string;
  insurance_paid_losses: U128;
  lp_impairment: U128;
  nav_fresh: boolean;
  tracked_collateral: U128;
}
export interface RiskSummary {
  market_id: string;
  state: MarketState;
  open_positions: number;
  open_margin: U128;
  open_units: U128[];
  trader_pnl_by_scenario: string[];
  hedge_pnl_by_scenario: string[];
  payout_reserve: U128;
  stress_loss: U128;
  event_stress_cap: U128;
  hedge_units: U128[];
  hedge_cost: U128[];
}
export interface EffectiveActions {
  market_id: string;
  state: MarketState;
  open: boolean;
  reduce: boolean;
  close: boolean;
  liquidate: boolean;
  reasons: string[];
}
export interface OpenPreview {
  market_id: string;
  outcome_id: number;
  indicative: boolean;
  entry_price: U128;
  notional: U128;
  units: U128;
  max_loss: U128;
  max_profit: U128;
  max_payout: U128;
  open_fee: U128;
  risk_premium: U128;
  trader_ev_hold_to_resolution: string;
  liquidation_price: U128;
  tick_leverage_ceiling: U128;
  policy_max_leverage: U128;
  protocol_max_leverage: U128;
  admissible_fill_ppm: U128;
  event_stress_before: U128;
  event_stress_after: U128;
  event_stress_cap: U128;
  payout_reserve_increment: U128;
  hold_apr_bps: number;
  policy_hash: string;
  actions: EffectiveActions;
  reasons: string[];
  mark_source_timestamp_ns: U64;
}
export interface Conservation {
  tracked_on_contract: U128;
  cash: U128;
  order_escrow: U128;
  claimable_total: U128;
  in_flight: U128;
  insurance: U128;
  treasury: U128;
  hedge_custody_cash: U128;
}
export interface PolicyProposal {
  market_id: string;
  policy: MarketPolicy;
  policy_hash: string;
  proposed_by: string;
  proposed_ns: U64;
  eta_ns: U64;
}
