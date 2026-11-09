//! Margin engine: order intents, commit-then-execute pool fills, nonrecourse positions, early
//! close and partial reduce at executable bids, user triggers, permissionless liquidation of
//! losing positions, event settlement. No internal matching, no order book: every fill is
//! against the vault, admitted only after per-event and global scenario capacity checks.

use crate::types::*;
use crate::vault::{from_terms, pending_hold_fee, to_terms};
use crate::*;
use basis_math::position::Terms;
use basis_math::{LEV_SCALE, PPM, PRICE_SCALE};

/// Outcome of trying to execute an order. Non-fatal rejections persist the order state and
/// refund the user instead of panicking (a panic would roll back the bookkeeping).
pub(crate) enum Exec {
    Done(String),
    Rejected(String),
}

pub(crate) struct OpenPlan {
    pub terms: Terms,
    pub fraction_ppm: u128,
    pub open_fee: u128,
    pub risk_premium: u128,
    pub report_id: String,
}

#[near]
impl Contract {
    /// Keeper/executor step 2 of an open: execute against a signed mark observed after commit.
    pub fn execute_open(&mut self, order_id: U64, signed: SignedReport) -> String {
        self.assert_keeper();
        let mut o = self.order(order_id.0);
        require!(o.state == OrderState::Requested, "ORDER_NOT_REQUESTED");
        let OrderKind::Open { intent } = o.kind.clone() else { fail("ORDER_KIND", "not an open") };
        if now() > intent.deadline_ns.0 {
            return self.finish_reject(&mut o, OrderState::Expired, "ORDER_EXPIRED");
        }
        match self.plan_open(&o, &intent, &signed) {
            Err(reason) => self.finish_reject(&mut o, OrderState::Rejected, &reason),
            Ok(plan) => {
                if o.mode == StrategyMode::HedgeRequired {
                    self.reserve_for_hedge(&mut o, &intent, plan)
                } else {
                    let pid = self.open_position(&o, &intent, &plan, vec![]);
                    o.state = OrderState::Executed;
                    o.position_id = Some(U64(pid));
                    let refund = o.escrow.0 - plan.terms.margin - plan.open_fee - plan.risk_premium;
                    self.ledger.order_escrow -= o.escrow.0;
                    self.ledger.cash += plan.terms.margin;
                    self.collect_fee_from_escrow(plan.open_fee + plan.risk_premium, &intent.policy_hash);
                    o.result = Some(format!("OPEN position {pid} fill_ppm {}", plan.fraction_ppm));
                    o.escrow = U128(0);
                    self.pending_orders.remove(&o.order_id.0);
                    self.orders.insert(o.order_id.0, o.clone());
                    self.pay(&o.owner, refund);
                    format!("OPEN:{pid}")
                }
            }
        }
    }

    /// User cancels before synthetic execution or before an irreversible hedge commitment.
    pub fn cancel_open(&mut self, order_id: U64) {
        let mut o = self.order(order_id.0);
        require!(o.owner == env::predecessor_account_id(), "UNAUTHORIZED: owner");
        require!(matches!(o.state, OrderState::Requested | OrderState::RiskReserved), "ORDER_NOT_CANCELLABLE");
        self.finish_reject(&mut o, OrderState::Cancelled, "USER_CANCELLED");
    }

    /// Anyone may expire an order past its deadline (refund is deterministic).
    pub fn expire_order(&mut self, order_id: U64) {
        let mut o = self.order(order_id.0);
        require!(matches!(o.state, OrderState::Requested | OrderState::RiskReserved), "ORDER_NOT_EXPIRABLE");
        let deadline = match &o.kind {
            OrderKind::Open { intent } => intent.deadline_ns.0,
            OrderKind::Close { deadline_ns, .. } => deadline_ns.0,
        };
        require!(now() > deadline, "ORDER_NOT_EXPIRED");
        self.finish_reject(&mut o, OrderState::Expired, "ORDER_EXPIRED");
    }

    /// Owner requests a full or partial close (`fraction_ppm` of remaining exposure). Executed by a
    /// keeper at a mark observed after this commit, never at the user's pre-commit price.
    pub fn request_close(&mut self, position_id: U64, fraction_ppm: U128, min_exit_price: U128, deadline_ns: U64) -> U64 {
        let p = self.position(position_id.0);
        require!(p.owner == env::predecessor_account_id(), "UNAUTHORIZED: owner");
        require!(p.state == PositionState::Open, "POSITION_NOT_OPEN");
        require!(fraction_ppm.0 > 0 && fraction_ppm.0 <= PPM, "INVALID_FRACTION");
        require!(min_exit_price.0 <= PRICE_SCALE, "INVALID_PRICE");
        require!(deadline_ns.0 > now(), "DEADLINE_PASSED");
        let id = self.new_order(
            p.owner.clone(),
            OrderKind::Close { position_id, fraction_ppm, min_exit_price, deadline_ns },
            0,
            p.mode,
            p.policy_hash.clone(),
        );
        U64(id)
    }

    pub fn execute_close(&mut self, order_id: U64, signed: SignedReport) -> String {
        self.assert_keeper();
        let mut o = self.order(order_id.0);
        require!(o.state == OrderState::Requested, "ORDER_NOT_REQUESTED");
        let OrderKind::Close { position_id, fraction_ppm, min_exit_price, deadline_ns } = o.kind.clone() else {
            fail("ORDER_KIND", "not a close")
        };
        if now() > deadline_ns.0 {
            return self.finish_reject(&mut o, OrderState::Expired, "ORDER_EXPIRED");
        }
        let pos = self.position(position_id.0);
        if pos.state != PositionState::Open {
            return self.finish_reject(&mut o, OrderState::Rejected, "POSITION_NOT_OPEN");
        }
        let m = self.market(&pos.market_id);
        let eff = self.effective_actions(&m, now());
        let allowed = if fraction_ppm.0 == PPM { eff.close } else { eff.reduce };
        if !allowed {
            return self.finish_reject(&mut o, OrderState::Rejected, &format!("CLOSE_NOT_ALLOWED: {:?}", eff.reasons));
        }
        let policy = self.policy(&m.policy_hash);
        let report = self.verify_mark(&signed, &policy, o.commit_ns.0);
        require!(report.market_id == pos.market_id, "ORACLE_FIELDS: market mismatch");
        if report.market_status != VenueStatus::Open {
            return self.finish_reject(&mut o, OrderState::Rejected, "PRICE_STALE: venue not open");
        }
        match self.internal_close(position_id.0, fraction_ppm.0, min_exit_price.0, &report, "close") {
            Exec::Done(s) => {
                o.state = OrderState::Executed;
                o.result = Some(s.clone());
                o.position_id = Some(position_id);
                self.pending_orders.remove(&o.order_id.0);
                self.orders.insert(o.order_id.0, o);
                s
            }
            Exec::Rejected(r) => self.finish_reject(&mut o, OrderState::Rejected, &r),
        }
    }

    /// Owner sets or clears best-effort take-profit / stop-loss triggers (never guaranteed fills).
    pub fn set_triggers(&mut self, position_id: U64, take_profit_price: Option<U128>, stop_loss_price: Option<U128>) {
        let mut p = self.position(position_id.0);
        require!(p.owner == env::predecessor_account_id(), "UNAUTHORIZED: owner");
        require!(p.state == PositionState::Open, "POSITION_NOT_OPEN");
        for x in [take_profit_price, stop_loss_price].into_iter().flatten() {
            require!(x.0 <= PRICE_SCALE, "INVALID_PRICE");
        }
        p.take_profit_price = take_profit_price;
        p.stop_loss_price = stop_loss_price;
        self.positions.insert(position_id.0, p);
        self.emit("triggers_set", json!({"position_id": position_id, "tp": take_profit_price, "sl": stop_loss_price}));
    }

    /// Keeper executes a user-configured trigger when the executable bid crosses it.
    pub fn execute_trigger(&mut self, position_id: U64, signed: SignedReport) -> String {
        self.assert_keeper();
        let pos = self.position(position_id.0);
        require!(pos.state == PositionState::Open, "POSITION_NOT_OPEN");
        let m = self.market(&pos.market_id);
        let eff = self.effective_actions(&m, now());
        require!(eff.close, "CLOSE_NOT_ALLOWED");
        let policy = self.policy(&m.policy_hash);
        let report = self.verify_mark(&signed, &policy, pos.opened_ns.0);
        require!(report.market_status == VenueStatus::Open, "PRICE_STALE: venue not open");
        let bid = oracle::best_bid(oracle::outcome_book(&report, pos.outcome_id));
        let tp_hit = pos.take_profit_price.map(|x| bid >= x.0).unwrap_or(false);
        let sl_hit = pos.stop_loss_price.map(|x| bid <= x.0).unwrap_or(false);
        require!(tp_hit || sl_hit, "TRIGGER_NOT_REACHED");
        let why = if tp_hit { "take_profit" } else { "stop_loss" };
        match self.internal_close(position_id.0, PPM, 0, &report, why) {
            Exec::Done(s) => s,
            Exec::Rejected(r) => fail("TRIGGER_FAILED", r),
        }
    }

    /// Permissionless liquidation of a losing position whose executable equity is at or below
    /// maintenance. Profitable positions are never force-closed (no ADL, no +100% cap).
    pub fn liquidate(&mut self, position_id: U64, signed: SignedReport) -> String {
        let mut pos = self.position(position_id.0);
        require!(pos.state == PositionState::Open, "POSITION_NOT_OPEN");
        let m = self.market(&pos.market_id);
        let eff = self.effective_actions(&m, now());
        require!(eff.liquidate, "LIQUIDATION_NOT_ALLOWED");
        let policy = self.policy(&m.policy_hash);
        let report = self.verify_mark(&signed, &policy, pos.opened_ns.0);
        require!(report.market_status == VenueStatus::Open, "PRICE_STALE: venue not open");
        self.accrue(&mut pos);
        let terms = to_terms(&pos.terms);
        let ob = oracle::outcome_book(&report, pos.outcome_id);
        let sale = math(basis_math::book::sell_units(&oracle::levels(&ob.bids), terms.units));
        // Units that cannot be sold at the book are valued at zero (conservative).
        let fees = pos.accrued_hold_fees.0;
        let equity_signed = terms.margin as i128 + sale.notional as i128 - terms.notional as i128 - fees as i128;
        let req = math(basis_math::mul_div_ceil(sale.notional, pos.maintenance_bps as u128, basis_math::BPS)) + pos.maintenance_fixed.0;
        require!(equity_signed <= req as i128, "NOT_LIQUIDATABLE");
        let before_fees = basis_math::pos(terms.margin as i128 + sale.notional as i128 - terms.notional as i128);
        let hold_collected = fees.min(before_fees);
        let residual = before_fees - hold_collected;
        let reward = math(basis_math::fees::liquidation_reward(residual, pos.liquidation_reward_bps as u128, pos.liquidation_reward_cap.0));
        let to_user = residual - reward;
        self.book_apply(&pos.market_id, pos.outcome_id, &terms, false);
        self.ledger.total_open_margin -= terms.margin;
        self.ledger.cash -= reward + to_user;
        self.ledger.fees_uncollected += fees - hold_collected;
        self.collect_fee_from_cash(hold_collected, &pos.policy_hash);
        let pnl = to_user as i128 - terms.margin as i128;
        self.ledger.realized_trader_pnl += pnl;
        pos.state = PositionState::Liquidated;
        pos.paid_out = U128(to_user);
        pos.realized_pnl = pnl.to_string();
        let owner = pos.owner.clone();
        self.positions.insert(position_id.0, pos);
        self.remove_market_position(&m.descriptor.market_id, position_id.0);
        let keeper = env::predecessor_account_id();
        self.emit(
            "liquidated",
            json!({"position_id": position_id, "keeper": keeper, "proceeds": U128(sale.notional), "reward": U128(reward), "to_user": U128(to_user), "report_id": report.report_id}),
        );
        self.pay(&keeper, reward);
        self.pay(&owner, to_user);
        format!("LIQUIDATED:{}", position_id.0)
    }

    /// Settle open positions of a finalized market against the exact resolved payout vector.
    /// Anyone may call; pays the full nonnegative synthetic equity less owed holding fees.
    pub fn settle_positions(&mut self, market_id: MarketId, limit: u32) -> u32 {
        let m = self.market(&market_id);
        require!(m.state == MarketState::Settled, "SETTLEMENT_PENDING");
        let s = m.resolved_scenario.unwrap_or_else(|| fail("SETTLEMENT_PENDING", "no scenario")) as usize;
        let stop_ns = self.resolutions.get(&market_id).map(|r| r.quorum_ns.0).unwrap_or(now());
        let ids = self.market_positions.get(&market_id).cloned().unwrap_or_default();
        let mut n = 0;
        for pid in ids.into_iter().take(limit as usize) {
            let mut pos = self.position(pid);
            if pos.state != PositionState::Open {
                continue;
            }
            let t = stop_ns.max(pos.fee_accrued_ns.0);
            pos.accrued_hold_fees = U128(pos.accrued_hold_fees.0 + pending_hold_fee(&pos, t));
            pos.fee_accrued_ns = U64(t);
            let terms = to_terms(&pos.terms);
            let payout_px = m.descriptor.scenarios[s].payouts[pos.outcome_id as usize].0;
            let before_fees = math(terms.equity(payout_px, 0));
            let fees = pos.accrued_hold_fees.0;
            let hold_collected = fees.min(before_fees);
            let payout = before_fees - hold_collected;
            self.book_apply(&market_id, pos.outcome_id, &terms, false);
            self.ledger.total_open_margin -= terms.margin;
            self.ledger.cash -= payout;
            self.ledger.fees_uncollected += fees - hold_collected;
            self.collect_fee_from_cash(hold_collected, &pos.policy_hash);
            let pnl = payout as i128 - terms.margin as i128;
            self.ledger.realized_trader_pnl += pnl;
            pos.state = PositionState::Settled;
            pos.paid_out = U128(payout);
            pos.realized_pnl = pnl.to_string();
            let owner = pos.owner.clone();
            self.positions.insert(pid, pos);
            self.remove_market_position(&market_id, pid);
            self.emit("settled", json!({"position_id": pid, "scenario": s, "payout": U128(payout), "pnl": pnl.to_string()}));
            self.pay(&owner, payout);
            n += 1;
        }
        n
    }
}

impl Contract {
    // ------------------------------------------------------------ request

    pub(crate) fn internal_request_open(&mut self, owner: &AccountId, amount: u128, intent: OrderIntent) -> u128 {
        let key = format!("{owner}:{}", intent.nonce.0);
        require!(!self.nonces.contains(&key), "NONCE_REUSED");
        let m = self.market(&intent.market_id);
        require!(intent.policy_hash == m.policy_hash, "POLICY_MISMATCH: sign the current policy hash");
        let p = self.policy(&m.policy_hash);
        let eff = self.effective_actions(&m, now());
        if !eff.open {
            let code = if eff.reasons.iter().any(|r| r.contains("CLOSE_ONLY")) { "MARKET_CLOSE_ONLY" } else { "OPEN_NOT_ALLOWED" };
            fail(code, format!("{:?}", eff.reasons));
        }
        require!((intent.outcome_id as usize) < m.descriptor.outcomes.len(), "UNKNOWN_OUTCOME");
        let margin = intent.margin_amount.0;
        require!(margin >= p.min_margin.0 && margin <= p.max_margin.0, "RISK_LIMIT: margin outside policy bounds");
        require!(amount == margin + intent.max_fee.0, "DEPOSIT_MISMATCH: send margin + max_fee");
        let lev = intent.requested_leverage.0;
        require!(lev >= LEV_SCALE && lev <= p.max_leverage.0 && lev <= self.config.max_leverage_ceiling.0, "RISK_LIMIT: leverage");
        require!(intent.max_entry_price.0 > 0 && intent.max_entry_price.0 < PRICE_SCALE, "INVALID_PRICE");
        require!(intent.max_hedge_slippage_bps <= p.max_hedge_slippage_bps, "RISK_LIMIT: hedge slippage");
        let t = now();
        require!(intent.deadline_ns.0 > t && intent.deadline_ns.0 <= t + p.max_order_lifetime_ns.0, "DEADLINE: outside policy lifetime");
        let min_fill = intent.minimum_acceptable_fill_ppm.0;
        if intent.allow_partial_fill {
            require!(min_fill >= p.min_fill_floor_ppm.0.max(1) && min_fill <= PPM, "PARTIAL_FILL: minimum fill outside policy");
        } else {
            require!(min_fill == PPM, "PARTIAL_FILL: all-or-none requires minimum_acceptable_fill_ppm = 1000000");
        }
        for x in [intent.take_profit_price, intent.stop_loss_price].into_iter().flatten() {
            require!(x.0 <= PRICE_SCALE, "INVALID_PRICE");
        }
        self.nonces.insert(key);
        self.ledger.order_escrow += amount;
        let id = self.new_order(owner.clone(), OrderKind::Open { intent: intent.clone() }, amount, p.strategy, m.policy_hash.clone());
        self.emit(
            "order_requested",
            json!({"order_id": id, "owner": owner, "market_id": intent.market_id, "outcome": intent.outcome_id, "margin": intent.margin_amount, "leverage": intent.requested_leverage, "allow_partial_fill": intent.allow_partial_fill, "mode": p.strategy}),
        );
        0
    }

    pub(crate) fn new_order(&mut self, owner: AccountId, kind: OrderKind, escrow: u128, mode: StrategyMode, policy_hash: String) -> u64 {
        let id = self.next_order_id;
        self.next_order_id += 1;
        let o = Order {
            order_id: U64(id),
            owner: owner.clone(),
            kind,
            state: OrderState::Requested,
            commit_ns: U64(now()),
            escrow: U128(escrow),
            mode,
            policy_hash,
            reserved_terms: None,
            reserved_fees: U128(0),
            reserved_hedge_budget: U128(0),
            hedge_fill_ids: vec![],
            hedge_units: U128(0),
            hedge_cost: U128(0),
            result: None,
            position_id: None,
        };
        self.orders.insert(id, o);
        self.pending_orders.insert(id);
        let mut list = self.user_orders.get(&owner).cloned().unwrap_or_default();
        list.push(id);
        self.user_orders.insert(owner, list);
        id
    }

    // ------------------------------------------------------------ open planning

    /// Price, size and admit an open. Returns a reason string on rejection.
    pub(crate) fn plan_open(&mut self, o: &Order, intent: &OrderIntent, signed: &SignedReport) -> Result<OpenPlan, String> {
        let m = self.market(&intent.market_id);
        if m.policy_hash != o.policy_hash {
            return Err("POLICY_CHANGED: policy hash changed while the order was in flight".into());
        }
        let p = self.policy(&m.policy_hash);
        let eff = self.effective_actions(&m, now());
        if !eff.open {
            return Err(format!("OPEN_NOT_ALLOWED: {:?}", eff.reasons));
        }
        let report = self.verify_mark(signed, &p, o.commit_ns.0);
        if report.market_id != intent.market_id {
            return Err("ORACLE_FIELDS: market mismatch".into());
        }
        if report.market_status != VenueStatus::Open {
            return Err("PRICE_STALE: venue not open".into());
        }
        let nav = self.compute_nav();
        if !nav.fresh {
            return Err("PRICE_STALE: NAV marks stale".into());
        }
        let nav_pos = basis_math::pos(nav.nav);
        let book = self.book(&intent.market_id);
        let ob = oracle::outcome_book(&report, intent.outcome_id).clone();
        let asks = oracle::levels(&ob.asks);
        let bids = oracle::levels(&ob.bids);
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        let outcome = intent.outcome_id as usize;
        let payouts_i: Vec<u128> = matrix.iter().map(|r| r[outcome]).collect();
        let max_pay = math(basis_math::stress::max_outcome_payout(&matrix, outcome));
        let margin = intent.margin_amount.0;
        let lev = intent.requested_leverage.0;

        // Full-size depth walk.
        let full_notional = math(basis_math::mul_div_floor(margin, lev, LEV_SCALE));
        let fill = math(basis_math::book::buy_notional(&asks, full_notional));
        if fill.units == 0 {
            return Err("SLIPPAGE: no ask depth".into());
        }
        let mut f = if fill.complete { PPM } else { math(basis_math::mul_div_floor(fill.notional, PPM, full_notional)) };
        let est = match Terms::from_fill(margin, full_notional, math(basis_math::mul_div_floor(fill.units, full_notional, fill.notional.max(1))), lev) {
            Ok(t) => t,
            Err(e) => return Err(format!("INVALID_PRICE: {e}")),
        };

        // Size caps that scale linearly with the fill fraction.
        let exit_need = math(basis_math::mul_div_ceil(est.units, p.exit_depth_bps as u128, basis_math::BPS));
        let exit_have = math(basis_math::book::depth_units(&bids));
        if exit_need > 0 && exit_have < exit_need {
            f = f.min(math(basis_math::mul_div_floor(exit_have, PPM, exit_need)));
        }
        let oi_room = p.max_open_units_per_outcome.0.saturating_sub(book.open_units[outcome]);
        if est.units > oi_room {
            f = f.min(math(basis_math::mul_div_floor(oi_room, PPM, est.units)));
        }
        let liab_full = math(est.max_payout(max_pay));
        let liab_room = p.max_payout_liability.0.saturating_sub(book.max_payout_liability);
        if liab_full > liab_room {
            f = f.min(math(basis_math::mul_div_floor(liab_room, PPM, liab_full)));
        }
        if book.open_positions >= self.config.max_positions_per_market {
            return Err("RISK_LIMIT: max positions per market".into());
        }

        // Scenario capacity: stress budgets (with hedge P&L) and liquidity (no hedge credit).
        let cand_full: Vec<i128> = payouts_i.iter().map(|x| math(est.scenario_pnl(*x))).collect();
        let hedge = math(basis_math::stress::hedge_scenario_pnl(&matrix, &book.hedge_units, &book.hedge_cost));
        let zeros = vec![0i128; matrix.len()];
        let event_cap = math(basis_math::mul_div_floor(nav_pos, p.event_stress_cap_bps as u128, basis_math::BPS));
        let global_cap = math(basis_math::mul_div_floor(nav_pos, self.config.global_stress_cap_bps as u128, basis_math::BPS));
        let stress_cap = basis_math::stress::Capacity {
            event_cap,
            global_cap,
            other_events_reserve: self.ledger.total_stress_loss.saturating_sub(book.stress_loss),
            free_liquidity: u128::MAX / 4,
        };
        let liq_cap = basis_math::stress::Capacity {
            event_cap: u128::MAX / 4,
            global_cap: u128::MAX / 4,
            other_events_reserve: 0,
            free_liquidity: self.free_liquidity(),
        };
        let a1 = math(basis_math::stress::max_fill_fraction(&book.trader_pnl, &hedge, &cand_full, 0, &stress_cap));
        let a2 = math(basis_math::stress::max_fill_fraction(&book.trader_pnl, &zeros, &cand_full, 0, &liq_cap));
        f = f.min(a1.fraction_ppm).min(a2.fraction_ppm);

        let min_fill = intent.minimum_acceptable_fill_ppm.0;
        if f == 0 {
            return Err("RISK_LIMIT: no vault capacity for this order".into());
        }
        if f < PPM && (!intent.allow_partial_fill || f < min_fill) {
            return Err(format!("PARTIAL_FILL: only {f} ppm admissible, user minimum {min_fill}"));
        }

        // Exact terms at the admitted fraction, then verify every constraint on them. Rounding can
        // push a boundary fill over by a micro-unit, so step down slightly and retry.
        for attempt in 0..4u128 {
            let frac = if attempt == 0 { f } else { f.saturating_sub(attempt * 1_000) };
            if frac == 0 || (frac < PPM && (!intent.allow_partial_fill || frac < min_fill)) {
                break;
            }
            let margin_f = math(basis_math::mul_div_floor(margin, frac, PPM));
            if margin_f == 0 {
                break;
            }
            let notional_f = math(basis_math::mul_div_floor(margin_f, lev, LEV_SCALE));
            let fill_f = math(basis_math::book::buy_notional(&asks, notional_f));
            if !fill_f.complete {
                continue;
            }
            let terms = match Terms::from_fill(margin_f, notional_f, fill_f.units, lev) {
                Ok(t) => t,
                Err(e) => return Err(format!("INVALID_PRICE: {e}")),
            };
            if terms.entry_price > intent.max_entry_price.0 {
                return Err(format!("SLIPPAGE: entry {} above max {}", terms.entry_price, intent.max_entry_price.0));
            }
            let tick_cap = math(basis_math::position::tick_leverage_ceiling(terms.entry_price, p.tick_size.0, p.min_adverse_ticks as u128));
            if lev > tick_cap {
                return Err(format!("RISK_LIMIT: leverage above tick-sensitivity ceiling {tick_cap}"));
            }
            let cand: Vec<i128> = payouts_i.iter().map(|x| math(terms.scenario_pnl(*x))).collect();
            let after = math(basis_math::stress::add_vec(&book.trader_pnl, &cand));
            let stress_after = math(basis_math::stress::lp_loss(&after, &hedge, 0));
            let payout_after = math(basis_math::stress::lp_loss(&after, &zeros, 0));
            let stress_level = basis_math::stress::reserve_level(book.stress_loss, &stress_cap);
            let liq_level = basis_math::stress::reserve_level(book.payout_reserve, &liq_cap);
            if stress_after > stress_level || payout_after > liq_level {
                continue;
            }
            if terms.units > oi_room || math(terms.max_payout(max_pay)) > liab_room {
                continue;
            }
            // Fair-price gate on the actual terms.
            let probs = match self.scenario_probabilities(&report, &matrix) {
                Ok(v) => v,
                Err(e) => return Err(e),
            };
            let ev = math(basis_math::fair::hold_to_resolution_ev(&terms, &payouts_i, &probs));
            let premium = math(basis_math::fair::required_risk_premium(ev, p.fees.floor_coverage_bps as u128));
            let open_fee = math(basis_math::fees::open_fee(terms.notional, p.fees.open_bps as u128));
            if premium + open_fee > intent.max_fee.0 {
                return Err(format!(
                    "FAIR_VALUE: required risk premium {premium} + open fee {open_fee} exceeds signed max_fee {} (hold-to-resolution trader EV {ev})",
                    intent.max_fee.0
                ));
            }
            return Ok(OpenPlan { terms, fraction_ppm: frac, open_fee, risk_premium: premium, report_id: report.report_id.clone() });
        }
        Err("RISK_LIMIT: capacity changed during sizing".into())
    }

    /// Mark-implied scenario probabilities: a scenario's weight is the mid of the outcome that
    /// pays in full in it; scenarios with no full-paying outcome (e.g. invalid) get zero weight.
    pub(crate) fn scenario_probabilities(&self, r: &OracleReport, matrix: &[Vec<u128>]) -> Result<Vec<u128>, String> {
        let mut w = vec![];
        for row in matrix {
            let mut weight = 0u128;
            if let Some(i) = row.iter().position(|x| *x == PRICE_SCALE) {
                let ob = oracle::outcome_book(r, i as u8);
                weight = (oracle::best_bid(ob) + oracle::best_ask(ob)) / 2;
            }
            w.push(weight);
        }
        basis_math::fair::implied_probabilities(&w).map_err(|e| format!("PRICE_STALE: {e}"))
    }

    pub(crate) fn open_position(&mut self, o: &Order, intent: &OrderIntent, plan: &OpenPlan, hedge_fill_ids: Vec<String>) -> u64 {
        let m = self.market(&intent.market_id);
        let p = self.policy(&o.policy_hash);
        let pid = self.next_position_id;
        self.next_position_id += 1;
        let t = now();
        let pos = Position {
            position_id: U64(pid),
            owner: o.owner.clone(),
            market_id: intent.market_id.clone(),
            outcome_id: intent.outcome_id,
            terms: from_terms(&plan.terms),
            mode: o.mode,
            state: PositionState::Open,
            opened_ns: U64(t),
            fee_accrued_ns: U64(t),
            accrued_hold_fees: U128(0),
            open_fee_paid: U128(plan.open_fee),
            risk_premium_paid: U128(plan.risk_premium),
            hold_apr_bps: p.fees.hold_apr_bps,
            close_bps: p.fees.close_bps,
            maintenance_bps: p.maintenance_bps,
            maintenance_fixed: p.maintenance_fixed,
            liquidation_reward_bps: p.fees.liquidation_reward_bps,
            liquidation_reward_cap: p.fees.liquidation_reward_cap,
            policy_hash: o.policy_hash.clone(),
            policy_epoch: m.policy_epoch,
            order_id: o.order_id,
            fill_fraction_ppm: U128(plan.fraction_ppm),
            take_profit_price: intent.take_profit_price,
            stop_loss_price: intent.stop_loss_price,
            realized_pnl: "0".into(),
            paid_out: U128(0),
            quote_id: intent.quote_id.clone(),
            entry_report_id: plan.report_id.clone(),
            hedge_fill_ids,
        };
        if o.mode != StrategyMode::HedgeRequired {
            self.book_apply(&intent.market_id, intent.outcome_id, &plan.terms, true);
        }
        self.ledger.total_open_margin += plan.terms.margin;
        let mut b = self.book(&intent.market_id);
        b.open_margin += plan.terms.margin;
        b.open_positions += 1;
        self.books.insert(intent.market_id.clone(), b);
        self.positions.insert(pid, pos);
        let mut mp = self.market_positions.get(&intent.market_id).cloned().unwrap_or_default();
        mp.push(pid);
        self.market_positions.insert(intent.market_id.clone(), mp);
        let mut up = self.user_positions.get(&o.owner).cloned().unwrap_or_default();
        up.push(pid);
        self.user_positions.insert(o.owner.clone(), up);
        let max_pay = {
            let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
            math(basis_math::stress::max_outcome_payout(&matrix, intent.outcome_id as usize))
        };
        self.emit(
            "position_opened",
            json!({
                "position_id": pid, "owner": o.owner, "market_id": intent.market_id, "outcome": intent.outcome_id,
                "margin": U128(plan.terms.margin), "notional": U128(plan.terms.notional), "units": U128(plan.terms.units),
                "entry_price": U128(plan.terms.entry_price), "leverage": U128(plan.terms.leverage),
                "fill_ppm": U128(plan.fraction_ppm), "open_fee": U128(plan.open_fee), "risk_premium": U128(plan.risk_premium),
                "max_profit": U128(math(plan.terms.max_profit(max_pay))), "mode": o.mode, "policy_hash": o.policy_hash,
                "report_id": plan.report_id, "hedge_required": o.mode == StrategyMode::HedgeRequired,
            }),
        );
        pid
    }

    // ------------------------------------------------------------ close

    pub(crate) fn internal_close(&mut self, pid: u64, fraction_ppm: u128, min_exit_price: u128, report: &OracleReport, why: &str) -> Exec {
        let mut pos = self.position(pid);
        self.accrue(&mut pos);
        let terms = to_terms(&pos.terms);
        let (closed, remaining) = math(terms.split(fraction_ppm));
        if closed.units == 0 {
            return Exec::Rejected("INVALID_FRACTION: rounds to zero".into());
        }
        let ob = oracle::outcome_book(report, pos.outcome_id);
        let sale = math(basis_math::book::sell_units(&oracle::levels(&ob.bids), closed.units));
        if !sale.complete {
            return Exec::Rejected("SLIPPAGE: insufficient executable bid depth".into());
        }
        let avg_bid = math(basis_math::mul_div_floor(sale.notional, PRICE_SCALE, closed.units));
        if avg_bid < min_exit_price {
            return Exec::Rejected(format!("SLIPPAGE: exit {avg_bid} below min {min_exit_price}"));
        }
        let fees_total = pos.accrued_hold_fees.0;
        let fees_c = if remaining.units == 0 { fees_total } else { math(basis_math::mul_div_ceil(fees_total, fraction_ppm, PPM)).min(fees_total) };
        let before_fees = basis_math::pos(closed.margin as i128 + sale.notional as i128 - closed.notional as i128);
        let hold_collected = fees_c.min(before_fees);
        let after_hold = before_fees - hold_collected;
        let close_fee = math(basis_math::fees::close_fee(sale.notional, pos.close_bps as u128)).min(after_hold);
        let payout = after_hold - close_fee;

        self.book_apply(&pos.market_id, pos.outcome_id, &terms, false);
        if remaining.units > 0 {
            self.book_apply(&pos.market_id, pos.outcome_id, &remaining, true);
        }
        self.ledger.total_open_margin -= closed.margin;
        let mut b = self.book(&pos.market_id);
        b.open_margin -= closed.margin;
        if remaining.units == 0 {
            b.open_positions -= 1;
        }
        self.books.insert(pos.market_id.clone(), b);
        self.ledger.cash -= payout;
        self.ledger.fees_uncollected += fees_c - hold_collected;
        self.collect_fee_from_cash(hold_collected + close_fee, &pos.policy_hash);
        let pnl = payout as i128 - closed.margin as i128;
        self.ledger.realized_trader_pnl += pnl;
        let prev_realized: i128 = pos.realized_pnl.parse().unwrap_or(0);
        pos.realized_pnl = (prev_realized + pnl).to_string();
        pos.paid_out = U128(pos.paid_out.0 + payout);
        pos.accrued_hold_fees = U128(fees_total - fees_c);
        let market_id = pos.market_id.clone();
        if remaining.units == 0 {
            pos.state = PositionState::Closed;
        } else {
            pos.terms = from_terms(&remaining);
        }
        let owner = pos.owner.clone();
        let full = remaining.units == 0;
        self.positions.insert(pid, pos);
        if full {
            self.remove_market_position_only(&market_id, pid);
        }
        self.emit(
            "position_closed",
            json!({"position_id": pid, "reason": why, "fraction_ppm": U128(fraction_ppm), "exit_price": U128(avg_bid), "proceeds": U128(sale.notional), "payout": U128(payout), "pnl": pnl.to_string(), "close_fee": U128(close_fee), "hold_fee": U128(hold_collected), "remaining_units": U128(remaining.units), "report_id": report.report_id}),
        );
        self.pay(&owner, payout);
        Exec::Done(format!("CLOSED:{pid}:{}", if full { "full" } else { "partial" }))
    }

    pub(crate) fn internal_post_margin(&mut self, sender: &AccountId, pid: u64, amount: u128) -> u128 {
        let mut pos = self.position(pid);
        require!(pos.owner == *sender, "UNAUTHORIZED: owner");
        require!(pos.state == PositionState::Open, "POSITION_NOT_OPEN");
        let old = to_terms(&pos.terms);
        let mut new = old;
        new.margin += amount;
        new.leverage = math(basis_math::mul_div_floor(new.notional, LEV_SCALE, new.margin)).max(LEV_SCALE);
        self.book_apply(&pos.market_id, pos.outcome_id, &old, false);
        self.book_apply(&pos.market_id, pos.outcome_id, &new, true);
        self.ledger.cash += amount;
        self.ledger.total_open_margin += amount;
        let mut b = self.book(&pos.market_id);
        b.open_margin += amount;
        self.books.insert(pos.market_id.clone(), b);
        pos.terms = from_terms(&new);
        self.positions.insert(pid, pos);
        self.emit("margin_posted", json!({"position_id": pid, "amount": U128(amount)}));
        0
    }

    // ------------------------------------------------------------ book and fees

    /// Add (`add=true`) or remove a position's exact per-scenario contribution, then recompute the
    /// event's payout reserve and stress loss and propagate deltas to the global totals.
    pub(crate) fn book_apply(&mut self, market_id: &MarketId, outcome: u8, t: &Terms, add: bool) {
        let m = self.market(market_id);
        let mut b = self.book(market_id);
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        let max_pay = math(basis_math::stress::max_outcome_payout(&matrix, outcome as usize));
        let liab = math(t.max_payout(max_pay));
        for (s, row) in matrix.iter().enumerate() {
            let v = math(t.scenario_pnl(row[outcome as usize]));
            b.trader_pnl[s] = if add { b.trader_pnl[s] + v } else { b.trader_pnl[s] - v };
        }
        if add {
            b.open_units[outcome as usize] += t.units;
            b.max_payout_liability += liab;
        } else {
            b.open_units[outcome as usize] -= t.units;
            b.max_payout_liability -= liab;
        }
        self.refresh_book(market_id, &matrix, b);
    }

    pub(crate) fn refresh_book(&mut self, market_id: &MarketId, matrix: &[Vec<u128>], mut b: EventBook) {
        let hedge = math(basis_math::stress::hedge_scenario_pnl(matrix, &b.hedge_units, &b.hedge_cost));
        let zeros = vec![0i128; matrix.len()];
        let payout = math(basis_math::stress::lp_loss(&b.trader_pnl, &zeros, 0));
        let stress = math(basis_math::stress::lp_loss(&b.trader_pnl, &hedge, 0));
        self.ledger.total_payout_reserve = self.ledger.total_payout_reserve - b.payout_reserve + payout;
        self.ledger.total_stress_loss = self.ledger.total_stress_loss - b.stress_loss + stress;
        b.payout_reserve = payout;
        b.stress_loss = stress;
        self.books.insert(market_id.clone(), b);
    }

    pub(crate) fn accrue(&self, pos: &mut Position) {
        let t = now();
        pos.accrued_hold_fees = U128(pos.accrued_hold_fees.0 + pending_hold_fee(pos, t));
        pos.fee_accrued_ns = U64(t);
    }

    fn fee_split(&self, policy_hash: &str) -> (u128, u128) {
        let p = self.policy(policy_hash);
        (p.fees.insurance_share_bps as u128, p.fees.treasury_share_bps as u128)
    }

    /// Fees paid out of an order escrow (already moved from escrow into cash by the caller's
    /// bookkeeping: here we move `amount` into cash and then split).
    pub(crate) fn collect_fee_from_escrow(&mut self, amount: u128, policy_hash: &str) {
        self.ledger.cash += amount;
        self.collect_fee_from_cash(amount, policy_hash);
    }

    /// Split a fee held in vault cash into LP (stays in cash), insurance and treasury.
    pub(crate) fn collect_fee_from_cash(&mut self, amount: u128, policy_hash: &str) {
        if amount == 0 {
            return;
        }
        let (ins_bps, tre_bps) = self.fee_split(policy_hash);
        let (lp, ins, tre) = math(basis_math::fees::split_fee(amount, ins_bps, tre_bps));
        self.ledger.cash -= ins + tre;
        self.ledger.insurance += ins;
        self.ledger.treasury += tre;
        self.ledger.fees_assessed += amount;
        self.ledger.fees_to_lp += lp;
        self.ledger.fees_to_insurance += ins;
        self.ledger.fees_to_treasury += tre;
    }

    // ------------------------------------------------------------ order bookkeeping

    pub(crate) fn finish_reject(&mut self, o: &mut Order, state: OrderState, reason: &str) -> String {
        if o.reserved_terms.is_some() {
            self.release_reservation(o);
        }
        let refund = o.escrow.0;
        if refund > 0 {
            self.ledger.order_escrow -= refund;
        }
        o.state = state;
        o.result = Some(reason.to_string());
        o.escrow = U128(0);
        self.pending_orders.remove(&o.order_id.0);
        self.orders.insert(o.order_id.0, o.clone());
        self.emit("order_rejected", json!({"order_id": o.order_id, "state": state, "reason": reason, "refund": U128(refund)}));
        let owner = o.owner.clone();
        self.pay(&owner, refund);
        format!("{state:?}:{reason}").to_uppercase()
    }

    pub(crate) fn order(&self, id: u64) -> Order {
        self.orders.get(&id).cloned().unwrap_or_else(|| fail("UNKNOWN_ORDER", id.to_string()))
    }

    pub(crate) fn position(&self, id: u64) -> Position {
        self.positions.get(&id).cloned().unwrap_or_else(|| fail("UNKNOWN_POSITION", id.to_string()))
    }

    /// Remove a fully closed/liquidated/settled position from its market's open list and counts.
    pub(crate) fn remove_market_position(&mut self, market_id: &MarketId, pid: u64) {
        let pos = self.position(pid);
        let mut b = self.book(market_id);
        b.open_positions -= 1;
        b.open_margin -= to_terms(&pos.terms).margin;
        self.books.insert(market_id.clone(), b);
        self.remove_market_position_only(market_id, pid);
    }

    pub(crate) fn remove_market_position_only(&mut self, market_id: &MarketId, pid: u64) {
        let mut mp = self.market_positions.get(market_id).cloned().unwrap_or_default();
        mp.retain(|x| *x != pid);
        self.market_positions.insert(market_id.clone(), mp);
    }
}
