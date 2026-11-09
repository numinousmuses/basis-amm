//! Read-only views for the UI, indexer, keepers and auditors. `preview_open` runs the same math
//! the execution path uses against the latest stored mark, so the trade composer shows the
//! contract's own numbers (indicative: execution re-prices at a mark observed after commit).

use crate::types::*;
use crate::vault::{pending_hold_fee, to_terms};
use crate::*;
use basis_math::position::Terms;
use basis_math::{LEV_SCALE, PPM};

#[near(serializers = [json])]
pub struct OpenPreview {
    pub market_id: MarketId,
    pub outcome_id: u8,
    pub indicative: bool,
    pub entry_price: U128,
    pub notional: U128,
    pub units: U128,
    pub max_loss: U128,
    pub max_profit: U128,
    pub max_payout: U128,
    pub open_fee: U128,
    pub risk_premium: U128,
    pub trader_ev_hold_to_resolution: String,
    pub liquidation_price: U128,
    pub tick_leverage_ceiling: U128,
    pub policy_max_leverage: U128,
    pub protocol_max_leverage: U128,
    pub admissible_fill_ppm: U128,
    pub event_stress_before: U128,
    pub event_stress_after: U128,
    pub event_stress_cap: U128,
    pub payout_reserve_increment: U128,
    pub hold_apr_bps: u16,
    pub policy_hash: String,
    pub actions: EffectiveActions,
    pub reasons: Vec<String>,
    pub mark_source_timestamp_ns: U64,
}

#[near(serializers = [json])]
pub struct Conservation {
    pub tracked_on_contract: U128,
    pub cash: U128,
    pub order_escrow: U128,
    pub claimable_total: U128,
    pub in_flight: U128,
    pub insurance: U128,
    pub treasury: U128,
    pub hedge_custody_cash: U128,
}

#[near]
impl Contract {
    pub fn get_config(&self) -> ProtocolConfig {
        self.config.clone()
    }

    pub fn get_pending_config(&self) -> Option<(ProtocolConfig, U64)> {
        self.pending_config.clone().map(|(c, e)| (c, U64(e)))
    }

    pub fn get_roles(&self) -> Roles {
        self.roles.clone()
    }

    pub fn get_pause(&self) -> PauseFlags {
        self.pause
    }

    pub fn get_collateral_token(&self) -> AccountId {
        self.collateral_token.clone()
    }

    pub fn get_adapters(&self) -> Vec<String> {
        self.adapters.iter().cloned().collect()
    }

    pub fn get_markets(&self) -> Vec<Market> {
        self.markets.values().cloned().collect()
    }

    pub fn get_market(&self, market_id: MarketId) -> Option<Market> {
        self.markets.get(&market_id).cloned()
    }

    pub fn get_policy(&self, policy_hash: String) -> Option<MarketPolicy> {
        self.policies.get(&policy_hash).cloned()
    }

    pub fn get_policy_history(&self, market_id: MarketId) -> Vec<String> {
        self.policy_history.get(&market_id).cloned().unwrap_or_default()
    }

    pub fn get_proposals(&self) -> Vec<(u64, PolicyProposal)> {
        self.proposals.iter().map(|(k, v)| (*k, v.clone())).collect()
    }

    /// Hash a candidate policy exactly as the contract does (for clients to verify manifests).
    pub fn hash_policy(&self, policy: MarketPolicy) -> String {
        registry::policy_hash(&policy)
    }

    pub fn get_effective_actions(&self, market_id: MarketId) -> EffectiveActions {
        let m = self.market(&market_id);
        self.effective_actions(&m, now())
    }

    pub fn get_mark(&self, market_id: MarketId) -> Option<StoredMark> {
        self.marks.get(&market_id).cloned()
    }

    pub fn get_resolution(&self, market_id: MarketId) -> Option<ResolutionProposal> {
        self.resolutions.get(&market_id).cloned()
    }

    pub fn get_reporters(&self) -> Vec<ReporterInfo> {
        self.reporters.values().cloned().collect()
    }

    /// The digest a reporter must sign for `report` (hex). Lets clients cross-check encoders.
    pub fn report_digest(&self, report: OracleReport) -> String {
        hex_encode(&oracle::report_digest(&env::current_account_id(), &report))
    }

    pub fn get_vault_summary(&self) -> VaultSummary {
        let nav = self.compute_nav();
        let supply = self.blp.total_supply;
        let l = &self.ledger;
        VaultSummary {
            cash: U128(l.cash),
            total_assets: U128(nav.assets),
            hedge_custody_cash: U128(l.hedge_custody_cash),
            hedge_inventory_value: U128(nav.hedge_value),
            user_claim_liability: U128(nav.liabilities),
            nav: nav.nav.to_string(),
            blp_supply: U128(supply),
            share_price: U128(math(basis_math::vault::share_price(supply, basis_math::pos(nav.nav)))),
            open_margin: U128(l.total_open_margin),
            payout_reserve: U128(l.total_payout_reserve),
            stress_loss: U128(l.total_stress_loss),
            free_liquidity: U128(self.free_liquidity()),
            insurance_balance: U128(l.insurance),
            treasury_balance: U128(l.treasury),
            order_escrow: U128(l.order_escrow),
            claimable_total: U128(l.claimable_total),
            pending_withdrawal_shares: U128(l.pending_withdrawal_shares),
            fees_assessed: U128(l.fees_assessed),
            fees_to_lp: U128(l.fees_to_lp),
            fees_to_insurance: U128(l.fees_to_insurance),
            fees_to_treasury: U128(l.fees_to_treasury),
            realized_trader_pnl: l.realized_trader_pnl.to_string(),
            hedge_realized_pnl: l.hedge_realized_pnl.to_string(),
            insurance_paid_losses: U128(l.insurance_paid_losses),
            lp_impairment: U128(l.lp_impairment),
            nav_fresh: nav.fresh,
            tracked_collateral: U128(l.cash + l.order_escrow + l.claimable_total + l.in_flight + l.insurance + l.treasury),
        }
    }

    /// Every collateral micro-unit the contract believes it holds, by bucket. Must equal
    /// `ft_balance_of(this)` on the collateral token whenever no transfer is in flight.
    pub fn get_conservation(&self) -> Conservation {
        let l = &self.ledger;
        Conservation {
            tracked_on_contract: U128(l.cash + l.order_escrow + l.claimable_total + l.in_flight + l.insurance + l.treasury),
            cash: U128(l.cash),
            order_escrow: U128(l.order_escrow),
            claimable_total: U128(l.claimable_total),
            in_flight: U128(l.in_flight),
            insurance: U128(l.insurance),
            treasury: U128(l.treasury),
            hedge_custody_cash: U128(l.hedge_custody_cash),
        }
    }

    pub fn get_risk_summary(&self, market_id: MarketId) -> RiskSummary {
        let m = self.market(&market_id);
        let b = self.book(&market_id);
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        let hedge = math(basis_math::stress::hedge_scenario_pnl(&matrix, &b.hedge_units, &b.hedge_cost));
        let nav = self.compute_nav();
        let cap_bps = self.policies.get(&m.policy_hash).map(|p| p.event_stress_cap_bps).unwrap_or(0);
        RiskSummary {
            market_id,
            state: m.state,
            open_positions: b.open_positions,
            open_margin: U128(b.open_margin),
            open_units: b.open_units.iter().map(|x| U128(*x)).collect(),
            trader_pnl_by_scenario: b.trader_pnl.iter().map(|x| x.to_string()).collect(),
            hedge_pnl_by_scenario: hedge.iter().map(|x| x.to_string()).collect(),
            payout_reserve: U128(b.payout_reserve),
            stress_loss: U128(b.stress_loss),
            event_stress_cap: U128(math(basis_math::mul_div_floor(basis_math::pos(nav.nav), cap_bps as u128, basis_math::BPS))),
            hedge_units: b.hedge_units.iter().map(|x| U128(*x)).collect(),
            hedge_cost: b.hedge_cost.iter().map(|x| U128(*x)).collect(),
        }
    }

    pub fn get_position(&self, position_id: U64) -> Option<PositionView> {
        let p = self.positions.get(&position_id.0)?.clone();
        Some(self.position_view(p))
    }

    pub fn get_positions_by_owner(&self, owner: AccountId) -> Vec<PositionView> {
        self.user_positions
            .get(&owner)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.positions.get(&id).cloned())
            .map(|p| self.position_view(p))
            .collect()
    }

    pub fn get_open_positions(&self, market_id: MarketId) -> Vec<PositionView> {
        self.market_positions
            .get(&market_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.positions.get(&id).cloned())
            .map(|p| self.position_view(p))
            .collect()
    }

    pub fn get_order(&self, order_id: U64) -> Option<Order> {
        self.orders.get(&order_id.0).cloned()
    }

    pub fn get_orders_by_owner(&self, owner: AccountId) -> Vec<Order> {
        self.user_orders
            .get(&owner)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.orders.get(&id).cloned())
            .collect()
    }

    pub fn get_pending_orders(&self) -> Vec<Order> {
        self.pending_orders.iter().filter_map(|id| self.orders.get(id).cloned()).collect()
    }

    pub fn get_withdrawals_by_owner(&self, owner: AccountId) -> Vec<Withdrawal> {
        self.user_withdrawals
            .get(&owner)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.withdrawals.get(&id).cloned())
            .collect()
    }

    pub fn get_queued_withdrawals(&self) -> Vec<Withdrawal> {
        let mut v: Vec<Withdrawal> = self.queued_withdrawals.iter().filter_map(|id| self.withdrawals.get(id).cloned()).collect();
        v.sort_by_key(|w| w.withdrawal_id.0);
        v
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_hedge_fills(&self, market_id: MarketId) -> Vec<HedgeFillReceipt> {
        self.market_hedge_fills
            .get(&market_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.hedge_fills.get(&id).cloned())
            .collect()
    }

    pub fn is_nonce_used(&self, account_id: AccountId, nonce: U64) -> bool {
        self.nonces.contains(&format!("{account_id}:{}", nonce.0))
    }

    /// Audit events with `seq >= from_seq` still in the ring buffer.
    pub fn get_events(&self, from_seq: U64, limit: u32) -> Vec<AuditEvent> {
        let cap = self.config.event_log_capacity.max(1) as u64;
        let last = self.next_event_seq;
        let start = from_seq.0.max(last.saturating_sub(cap)).max(1);
        (start..last)
            .take(limit as usize)
            .filter_map(|s| self.events.get(&(s % cap)).cloned().filter(|e| e.seq.0 == s))
            .collect()
    }

    pub fn get_last_event_seq(&self) -> U64 {
        U64(self.next_event_seq - 1)
    }

    pub fn preview_open(&self, market_id: MarketId, outcome_id: u8, margin: U128, leverage: U128) -> OpenPreview {
        let m = self.market(&market_id);
        let actions = self.effective_actions(&m, now());
        let mut reasons = actions.reasons.clone();
        let p = self.policy(&m.policy_hash);
        let stored = self.marks.get(&market_id).cloned().unwrap_or_else(|| fail("PRICE_STALE", "no mark"));
        let r = stored.report;
        if now().saturating_sub(r.source_timestamp_ns.0) > p.max_mark_staleness_ns.0 {
            reasons.push("PRICE_STALE: indicative mark older than policy staleness".into());
        }
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        let outcome = outcome_id as usize;
        require!(outcome < m.descriptor.outcomes.len(), "UNKNOWN_OUTCOME");
        let payouts_i: Vec<u128> = matrix.iter().map(|row| row[outcome]).collect();
        let max_pay = math(basis_math::stress::max_outcome_payout(&matrix, outcome));
        let ob = oracle::outcome_book(&r, outcome_id);
        let notional = math(basis_math::mul_div_floor(margin.0, leverage.0, LEV_SCALE));
        let fill = math(basis_math::book::buy_notional(&oracle::levels(&ob.asks), notional));
        if !fill.complete {
            reasons.push("PARTIAL_FILL: ask depth below requested notional".into());
        }
        let terms = if fill.units > 0 {
            Terms::from_fill(margin.0, fill.notional, fill.units, leverage.0).ok()
        } else {
            None
        };
        let Some(terms) = terms else { fail("SLIPPAGE", "no executable depth") };
        let probs = self.scenario_probabilities(&r, &matrix).unwrap_or_else(|e| fail("PRICE_STALE", e));
        let ev = math(basis_math::fair::hold_to_resolution_ev(&terms, &payouts_i, &probs));
        let premium = math(basis_math::fair::required_risk_premium(ev, p.fees.floor_coverage_bps as u128));
        let open_fee = math(basis_math::fees::open_fee(terms.notional, p.fees.open_bps as u128));
        let tick_cap = math(basis_math::position::tick_leverage_ceiling(terms.entry_price, p.tick_size.0, p.min_adverse_ticks as u128));
        if leverage.0 > tick_cap {
            reasons.push(format!("RISK_LIMIT: leverage above tick-sensitivity ceiling {tick_cap}"));
        }
        if leverage.0 > p.max_leverage.0 || leverage.0 > self.config.max_leverage_ceiling.0 {
            reasons.push("RISK_LIMIT: leverage above policy or protocol maximum".into());
        }
        let book = self.book(&market_id);
        let hedge = math(basis_math::stress::hedge_scenario_pnl(&matrix, &book.hedge_units, &book.hedge_cost));
        let cand: Vec<i128> = payouts_i.iter().map(|x| math(terms.scenario_pnl(*x))).collect();
        let nav = self.compute_nav();
        let nav_pos = basis_math::pos(nav.nav);
        let event_cap = math(basis_math::mul_div_floor(nav_pos, p.event_stress_cap_bps as u128, basis_math::BPS));
        let global_cap = math(basis_math::mul_div_floor(nav_pos, self.config.global_stress_cap_bps as u128, basis_math::BPS));
        let cap = basis_math::stress::Capacity {
            event_cap,
            global_cap,
            other_events_reserve: self.ledger.total_stress_loss.saturating_sub(book.stress_loss),
            free_liquidity: u128::MAX / 4,
        };
        let a = math(basis_math::stress::max_fill_fraction(&book.trader_pnl, &hedge, &cand, 0, &cap));
        let zeros = vec![0i128; matrix.len()];
        let liq = basis_math::stress::Capacity { event_cap: u128::MAX / 4, global_cap: u128::MAX / 4, other_events_reserve: 0, free_liquidity: self.free_liquidity() };
        let a2 = math(basis_math::stress::max_fill_fraction(&book.trader_pnl, &zeros, &cand, 0, &liq));
        let after_full = math(basis_math::stress::lp_loss(&math(basis_math::stress::add_vec(&book.trader_pnl, &cand)), &hedge, 0));
        let payout_after = math(basis_math::stress::lp_loss(&math(basis_math::stress::add_vec(&book.trader_pnl, &cand)), &zeros, 0));
        let fill_ppm = a.fraction_ppm.min(a2.fraction_ppm);
        if fill_ppm < PPM {
            reasons.push(format!("RISK_LIMIT: vault capacity admits {fill_ppm} ppm of this size"));
        }
        if !nav.fresh {
            reasons.push("PRICE_STALE: NAV marks stale".into());
        }
        OpenPreview {
            market_id,
            outcome_id,
            indicative: true,
            entry_price: U128(terms.entry_price),
            notional: U128(terms.notional),
            units: U128(terms.units),
            max_loss: U128(terms.margin),
            max_profit: U128(math(terms.max_profit(max_pay))),
            max_payout: U128(math(terms.max_payout(max_pay))),
            open_fee: U128(open_fee),
            risk_premium: U128(premium),
            trader_ev_hold_to_resolution: ev.to_string(),
            liquidation_price: U128(math(terms.liquidation_price(0, p.maintenance_bps as u128, p.maintenance_fixed.0))),
            tick_leverage_ceiling: U128(tick_cap),
            policy_max_leverage: p.max_leverage,
            protocol_max_leverage: self.config.max_leverage_ceiling,
            admissible_fill_ppm: U128(fill_ppm),
            event_stress_before: U128(book.stress_loss),
            event_stress_after: U128(after_full),
            event_stress_cap: U128(event_cap),
            payout_reserve_increment: U128(payout_after.saturating_sub(book.payout_reserve)),
            hold_apr_bps: p.fees.hold_apr_bps,
            policy_hash: m.policy_hash.clone(),
            actions,
            reasons,
            mark_source_timestamp_ns: r.source_timestamp_ns,
        }
    }
}

impl Contract {
    pub(crate) fn position_view(&self, p: Position) -> PositionView {
        let terms = to_terms(&p.terms);
        let m = self.market(&p.market_id);
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        let max_pay = math(basis_math::stress::max_outcome_payout(&matrix, p.outcome_id as usize));
        let pending = if p.state == PositionState::Open { pending_hold_fee(&p, now()) } else { 0 };
        let fees = p.accrued_hold_fees.0 + pending;
        let bid = self.marks.get(&p.market_id).map(|s| oracle::best_bid(oracle::outcome_book(&s.report, p.outcome_id)));
        let equity = bid.map(|b| math(terms.equity(b, fees)));
        let pnl = equity.map(|e| (e as i128 - terms.margin as i128).to_string());
        let liquidatable = match bid {
            Some(b) if p.state == PositionState::Open => math(terms.is_liquidatable(b, fees, p.maintenance_bps as u128, p.maintenance_fixed.0)),
            _ => false,
        };
        PositionView {
            mark_bid: bid.map(U128),
            equity_at_bid: equity.map(U128),
            unrealized_pnl: pnl,
            pending_hold_fees: U128(pending),
            max_profit: U128(math(terms.max_profit(max_pay))),
            max_payout: U128(math(terms.max_payout(max_pay))),
            liquidation_price: U128(math(terms.liquidation_price(fees, p.maintenance_bps as u128, p.maintenance_fixed.0))),
            liquidatable,
            position: p,
        }
    }
}

