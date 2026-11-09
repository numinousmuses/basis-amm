//! Optional vault-owned hedges: `HEDGE_REQUIRED` handshake (reserve -> commit -> fills ->
//! provisional -> finalize), `POOL_PLUS_HEDGE` portfolio hedges, executor receipts with strict
//! validation, custody capital returns, reconciliation freezes and the loss waterfall
//! (insurance -> LP NAV impairment) for hedge write-offs.
//!
//! Trust model: receipts come from an allowlisted executor account. That is a trusted, bonded
//! operator assertion, not a trustless Polygon inclusion proof. Receipts carry `simulated` so a
//! mock fill can never be shown as a real venue fill.

use crate::margin::OpenPlan;
use crate::types::*;
use crate::vault::{from_terms, to_terms};
use crate::*;
use basis_math::position::Terms;
use basis_math::{BPS, LEV_SCALE, PPM, PRICE_SCALE};

#[near]
impl Contract {
    /// Executor moves the reserved hedge budget for a `HEDGE_REQUIRED` order into custody. After
    /// this the user can no longer cancel (the hedge is irreversible from NEAR's point of view).
    pub fn commit_hedge(&mut self, order_id: U64) {
        self.assert_executor();
        let mut o = self.order(order_id.0);
        require!(o.state == OrderState::RiskReserved, "ORDER_NOT_RESERVED");
        let budget = o.reserved_hedge_budget.0;
        require!(budget <= self.ledger.cash, "HEDGE_REJECTED: insufficient cash");
        self.ledger.cash -= budget;
        self.ledger.hedge_custody_cash += budget;
        o.state = OrderState::Hedging;
        self.orders.insert(order_id.0, o);
        let exec = env::predecessor_account_id();
        self.emit("hedge_committed", json!({"order_id": order_id, "executor": exec, "budget": U128(budget)}));
        self.pay(&exec, budget);
    }

    /// Executor requests hedge capital for a `POOL_PLUS_HEDGE` market, bounded by the policy hedge
    /// budget and by free liquidity, so a hedge can never consume capital reserved for payouts.
    pub fn request_hedge_capital(&mut self, market_id: MarketId, amount: U128) {
        self.assert_executor();
        let m = self.market(&market_id);
        let p = self.policy(&m.policy_hash);
        require!(p.strategy != StrategyMode::PoolOnly, "HEDGE_REJECTED: POOL_ONLY market");
        require!(amount.0 <= self.free_liquidity(), "RISK_LIMIT: hedge capital exceeds free liquidity");
        let nav = self.compute_nav();
        require!(nav.fresh, "PRICE_STALE: NAV");
        let cap = math(basis_math::mul_div_floor(basis_math::pos(nav.nav), p.hedge_budget_bps as u128, BPS));
        let b = self.book(&market_id);
        let used: u128 = b.hedge_cost.iter().sum();
        require!(used + amount.0 <= cap, "RISK_LIMIT: hedge budget");
        self.ledger.cash -= amount.0;
        self.ledger.hedge_custody_cash += amount.0;
        let exec = env::predecessor_account_id();
        self.emit("hedge_capital", json!({"market_id": market_id, "executor": exec, "amount": amount}));
        self.pay(&exec, amount.0);
    }

    /// Record a venue fill receipt for vault-owned inventory. Linked to an order for
    /// `HEDGE_REQUIRED`, or standalone for `POOL_PLUS_HEDGE` portfolio hedging.
    pub fn submit_hedge_fill(&mut self, receipt: HedgeFillReceipt) -> String {
        self.assert_executor();
        require!(!self.hedge_fills.contains_key(&receipt.fill_id), "HEDGE_REJECTED: duplicate receipt");
        require!(!receipt.fill_id.is_empty() && !receipt.tx_hash.is_empty(), "HEDGE_REJECTED: missing fill id or tx hash");
        let m = self.market(&receipt.market_id);
        let p = self.policy(&m.policy_hash);
        let o_idx = receipt.outcome_id as usize;
        require!(o_idx < m.descriptor.outcomes.len(), "HEDGE_REJECTED: unknown outcome");
        require!(receipt.venue_token_ref == m.descriptor.outcomes[o_idx].venue_token_ref, "HEDGE_REJECTED: wrong market or token");
        require!(receipt.chain == m.descriptor.chain, "HEDGE_REJECTED: wrong chain");
        require!(receipt.units.0 > 0 && receipt.price.0 > 0 && receipt.price.0 < PRICE_SCALE, "HEDGE_REJECTED: bad amounts");
        let mark = self.fresh_mark(&receipt.market_id, p.max_mark_staleness_ns.0).unwrap_or_else(|| fail("PRICE_STALE", "no fresh mark to validate hedge price"));
        let ob = oracle::outcome_book(&mark, receipt.outcome_id);
        let cost = math(basis_math::mul_div_ceil(receipt.units.0, receipt.price.0, PRICE_SCALE));
        let mut slip = p.max_hedge_slippage_bps as u128;

        if let Some(oid) = receipt.order_id {
            let mut o = self.order(oid.0);
            require!(matches!(o.state, OrderState::Hedging | OrderState::HedgedProvisional), "HEDGE_REJECTED: order not hedging");
            require!(receipt.side_buy, "HEDGE_REJECTED: order hedges are buys");
            let OrderKind::Open { intent } = o.kind.clone() else { fail("ORDER_KIND", "") };
            require!(intent.market_id == receipt.market_id && intent.outcome_id == receipt.outcome_id, "HEDGE_REJECTED: wrong market or outcome for order");
            require!(receipt.executed_ns.0 >= o.commit_ns.0, "HEDGE_REJECTED: fill precedes order commit");
            require!(receipt.executed_ns.0 <= intent.deadline_ns.0, "HEDGE_REJECTED: fill after order deadline");
            slip = slip.min(intent.max_hedge_slippage_bps as u128);
            let reserved = o.reserved_terms.unwrap_or_else(|| fail("ORDER_NOT_RESERVED", ""));
            // A real FAK fill can land slightly over the reserved size (share rounding, price
            // improvement). Up to 2% over is accepted: the order is credited only up to its reserved
            // size and the excess is booked as plain vault inventory. More than that is rejected.
            let room = reserved.units.0.saturating_sub(o.hedge_units.0);
            let tolerance = reserved.units.0 / 50;
            require!(receipt.units.0 <= room + tolerance, "HEDGE_REJECTED: overfill beyond reserved size");
            let max_px = math(basis_math::mul_div_floor(intent.max_entry_price.0, BPS + slip, BPS)).min(PRICE_SCALE - 1);
            require!(receipt.price.0 <= max_px, "HEDGE_REJECTED: price outside signed slippage");
            let credited = receipt.units.0.min(room);
            let credited_cost = math(basis_math::mul_div_ceil(cost + receipt.fee.0, credited, receipt.units.0));
            o.hedge_units = U128(o.hedge_units.0 + credited);
            o.hedge_cost = U128(o.hedge_cost.0 + credited_cost);
            o.hedge_fill_ids.push(receipt.fill_id.clone());
            o.state = OrderState::HedgedProvisional;
            self.orders.insert(oid.0, o);
        } else if receipt.side_buy {
            // Selling only ever reduces inventory (unwinds and orphans), so it is allowed on any
            // market; new standalone exposure needs a POOL_PLUS_HEDGE policy.
            require!(p.strategy == StrategyMode::PoolPlusHedge, "HEDGE_REJECTED: standalone hedges need POOL_PLUS_HEDGE");
        }

        let mut b = self.book(&receipt.market_id);
        if receipt.side_buy {
            let ask = oracle::best_ask(ob);
            let max_px = math(basis_math::mul_div_floor(ask, BPS + slip, BPS));
            require!(receipt.price.0 <= max_px, "HEDGE_REJECTED: price above executable ask + slippage");
            let spend = cost + receipt.fee.0;
            require!(spend <= self.ledger.hedge_custody_cash, "HEDGE_REJECTED: exceeds custody budget");
            self.ledger.hedge_custody_cash -= spend;
            b.hedge_units[o_idx] += receipt.units.0;
            b.hedge_cost[o_idx] += spend;
        } else {
            let bid = oracle::best_bid(ob);
            let min_px = math(basis_math::mul_div_ceil(bid, BPS - slip.min(BPS), BPS));
            require!(receipt.price.0 >= min_px, "HEDGE_REJECTED: price below executable bid - slippage");
            require!(receipt.units.0 <= b.hedge_units[o_idx], "HEDGE_REJECTED: selling more than inventory");
            let basis = math(basis_math::mul_div_ceil(b.hedge_cost[o_idx], receipt.units.0, b.hedge_units[o_idx]));
            let proceeds = math(basis_math::mul_div_floor(receipt.units.0, receipt.price.0, PRICE_SCALE)).saturating_sub(receipt.fee.0);
            b.hedge_units[o_idx] -= receipt.units.0;
            b.hedge_cost[o_idx] -= basis.min(b.hedge_cost[o_idx]);
            self.ledger.hedge_custody_cash += proceeds;
            self.ledger.hedge_realized_pnl += proceeds as i128 - basis as i128;
        }
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        self.refresh_book(&receipt.market_id, &matrix, b);
        let mut ids = self.market_hedge_fills.get(&receipt.market_id).cloned().unwrap_or_default();
        ids.push(receipt.fill_id.clone());
        self.market_hedge_fills.insert(receipt.market_id.clone(), ids);
        self.emit(
            "hedge_fill",
            json!({"fill_id": receipt.fill_id, "market_id": receipt.market_id, "outcome": receipt.outcome_id, "buy": receipt.side_buy, "units": receipt.units, "price": receipt.price, "tx_hash": receipt.tx_hash, "simulated": receipt.simulated, "order_id": receipt.order_id}),
        );
        let id = receipt.fill_id.clone();
        self.hedge_fills.insert(id.clone(), receipt);
        format!("HEDGE_FILL:{id}")
    }

    /// Finalize a hedged order exactly once into an OPEN nonrecourse position sized to the actual
    /// executed hedge. Below the user's minimum (or partial when partial fills are off): reject,
    /// refund the user in full and keep the inventory as vault-owned for unwinding.
    pub fn finalize_open_hedged(&mut self, order_id: U64) -> String {
        self.assert_keeper();
        let mut o = self.order(order_id.0);
        require!(o.state == OrderState::HedgedProvisional, "ORDER_NOT_PROVISIONAL");
        let OrderKind::Open { intent } = o.kind.clone() else { fail("ORDER_KIND", "") };
        let reserved = to_terms(&o.reserved_terms.unwrap_or_else(|| fail("ORDER_NOT_RESERVED", "")));
        let fraction = math(basis_math::mul_div_floor(o.hedge_units.0, PPM, reserved.units)).min(PPM);
        let min_fill = intent.minimum_acceptable_fill_ppm.0;
        if fraction < PPM && (!intent.allow_partial_fill || fraction < min_fill) {
            let reason = format!("PARTIAL_FILL: hedge filled {fraction} ppm below user minimum {min_fill}; vault keeps inventory for unwind");
            return self.finish_reject(&mut o, OrderState::Rejected, &reason);
        }
        // Synthetic terms at the executed size and execution-weighted hedge price.
        let margin_f = math(basis_math::mul_div_floor(reserved.margin, fraction, PPM));
        let notional_f = math(basis_math::mul_div_floor(margin_f, intent.requested_leverage.0, LEV_SCALE));
        let exec_cost_ex_fee = o.hedge_cost.0;
        let avg_px = math(basis_math::mul_div_ceil(exec_cost_ex_fee, PRICE_SCALE, o.hedge_units.0)).min(PRICE_SCALE - 1);
        let units_f = math(basis_math::mul_div_floor(notional_f, PRICE_SCALE, avg_px)).min(o.hedge_units.0);
        let terms = match Terms::from_fill(margin_f, notional_f, units_f, intent.requested_leverage.0) {
            Ok(t) => t,
            Err(e) => return self.finish_reject(&mut o, OrderState::Rejected, &format!("INVALID_PRICE: {e}")),
        };
        if terms.entry_price > math(basis_math::mul_div_floor(intent.max_entry_price.0, BPS + intent.max_hedge_slippage_bps as u128, BPS)) {
            return self.finish_reject(&mut o, OrderState::Rejected, "SLIPPAGE: hedge entry above signed bound");
        }
        // Swap the reservation for the actual terms.
        self.book_apply(&intent.market_id, intent.outcome_id, &reserved, false);
        self.book_apply(&intent.market_id, intent.outcome_id, &terms, true);
        let fees = math(basis_math::mul_div_ceil(o.reserved_fees.0, fraction, PPM)).min(intent.max_fee.0);
        let plan = OpenPlan { terms, fraction_ppm: fraction, open_fee: fees, risk_premium: 0, report_id: "hedge-required".into() };
        let pid = self.open_position(&o, &intent, &plan, o.hedge_fill_ids.clone());
        let refund = o.escrow.0 - terms.margin - fees;
        self.ledger.order_escrow -= o.escrow.0;
        self.ledger.cash += terms.margin;
        self.collect_fee_from_escrow(fees, &o.policy_hash);
        o.state = OrderState::Executed;
        o.escrow = U128(0);
        o.position_id = Some(U64(pid));
        o.result = Some(format!("OPEN position {pid} hedged fill_ppm {fraction}"));
        self.pending_orders.remove(&order_id.0);
        let owner = o.owner.clone();
        self.orders.insert(order_id.0, o);
        self.pay(&owner, refund);
        format!("OPEN:{pid}")
    }

    /// Executor gives up a committed hedge that never filled (venue rejected, deadline passed).
    /// The user is refunded in full; unspent custody cash is returned separately via HedgeReturn.
    pub fn abandon_hedge(&mut self, order_id: U64, reason: String) -> String {
        self.assert_executor();
        let mut o = self.order(order_id.0);
        require!(o.state == OrderState::Hedging, "ORDER_NOT_HEDGING");
        require!(o.hedge_units.0 == 0, "HEDGE_FILLED: finalize or reject instead");
        self.finish_reject(&mut o, OrderState::Rejected, &format!("HEDGE_REJECTED: {reason}"))
    }

    /// Reconciler result. A genuine mismatch freezes opens on the market until lifted.
    pub fn report_reconciliation(&mut self, market_id: MarketId, ok: bool, detail: String) {
        self.assert_keeper();
        let _ = self.market(&market_id);
        if !ok && !self.frozen_markets.contains(&market_id) {
            self.frozen_markets.push(market_id.clone());
        }
        self.emit("reconciliation", json!({"market_id": market_id, "ok": ok, "detail": detail}));
    }

    /// Risk council writes off lost hedge inventory or custody cash. Loss waterfall: eligible
    /// insurance balance first, then LP NAV impairment. Never inflates bLP to cover losses.
    pub fn write_off_hedge(&mut self, market_id: MarketId, outcome_id: u8, units: U128, custody_cash: U128, reason: String) {
        self.assert_risk();
        let m = self.market(&market_id);
        let mut b = self.book(&market_id);
        let i = outcome_id as usize;
        require!(i < b.hedge_units.len() && units.0 <= b.hedge_units[i], "WRITE_OFF: units");
        require!(custody_cash.0 <= self.ledger.hedge_custody_cash, "WRITE_OFF: custody");
        let basis = if units.0 == 0 { 0 } else { math(basis_math::mul_div_ceil(b.hedge_cost[i], units.0, b.hedge_units[i])).min(b.hedge_cost[i]) };
        b.hedge_units[i] -= units.0;
        b.hedge_cost[i] -= basis;
        self.ledger.hedge_custody_cash -= custody_cash.0;
        let loss = basis + custody_cash.0;
        let covered = loss.min(self.ledger.insurance);
        self.ledger.insurance -= covered;
        self.ledger.cash += covered;
        self.ledger.insurance_paid_losses += covered;
        self.ledger.lp_impairment += loss - covered;
        self.ledger.hedge_realized_pnl -= loss as i128;
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        self.refresh_book(&market_id, &matrix, b);
        self.emit("hedge_write_off", json!({"market_id": market_id, "loss": U128(loss), "insurance_paid": U128(covered), "lp_impairment": U128(loss - covered), "reason": reason}));
    }

    /// Settled-market hedge redemption recorded by the executor: inventory leaves the book at the
    /// resolved payout, proceeds stay in custody until returned.
    pub fn record_hedge_redemption(&mut self, market_id: MarketId, outcome_id: u8, units: U128, proceeds: U128, tx_hash: String) {
        self.assert_executor();
        let m = self.market(&market_id);
        require!(m.state == MarketState::Settled, "SETTLEMENT_PENDING: resolved is not redeemed");
        let s = m.resolved_scenario.unwrap_or(0) as usize;
        let i = outcome_id as usize;
        let mut b = self.book(&market_id);
        require!(units.0 <= b.hedge_units[i], "REDEEM: units");
        let expected = math(basis_math::mul_div_floor(units.0, m.descriptor.scenarios[s].payouts[i].0, PRICE_SCALE));
        require!(proceeds.0 == expected, "REDEEM: proceeds differ from resolved payout vector");
        let basis = math(basis_math::mul_div_ceil(b.hedge_cost[i], units.0, b.hedge_units[i].max(1))).min(b.hedge_cost[i]);
        b.hedge_units[i] -= units.0;
        b.hedge_cost[i] -= basis;
        self.ledger.hedge_custody_cash += proceeds.0;
        self.ledger.hedge_realized_pnl += proceeds.0 as i128 - basis as i128;
        let matrix: Vec<Vec<u128>> = m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|x| x.0).collect()).collect();
        self.refresh_book(&market_id, &matrix, b);
        self.emit("hedge_redeemed", json!({"market_id": market_id, "outcome": outcome_id, "units": units, "proceeds": proceeds, "tx_hash": tx_hash}));
    }
}

impl Contract {
    /// `HEDGE_REQUIRED`: reserve payout capacity and a bounded hedge budget; no position yet.
    pub(crate) fn reserve_for_hedge(&mut self, o: &mut Order, intent: &OrderIntent, plan: OpenPlan) -> String {
        let budget = math(basis_math::mul_div_ceil(plan.terms.notional, BPS + intent.max_hedge_slippage_bps as u128, BPS));
        let m = self.market(&intent.market_id);
        let p = self.policy(&m.policy_hash);
        let nav = self.compute_nav();
        let cap = math(basis_math::mul_div_floor(basis_math::pos(nav.nav), p.hedge_budget_bps as u128, BPS));
        let used: u128 = self.book(&intent.market_id).hedge_cost.iter().sum();
        self.book_apply(&intent.market_id, intent.outcome_id, &plan.terms, true);
        if budget > self.free_liquidity() || used + budget > cap {
            self.book_apply(&intent.market_id, intent.outcome_id, &plan.terms, false);
            return self.finish_reject(o, OrderState::Rejected, "RISK_LIMIT: hedge budget or liquidity");
        }
        o.state = OrderState::RiskReserved;
        o.reserved_terms = Some(from_terms(&plan.terms));
        o.reserved_fees = U128(plan.open_fee + plan.risk_premium);
        o.reserved_hedge_budget = U128(budget);
        self.orders.insert(o.order_id.0, o.clone());
        self.emit(
            "risk_reserved",
            json!({"order_id": o.order_id, "units": U128(plan.terms.units), "entry_price": U128(plan.terms.entry_price), "hedge_budget": U128(budget)}),
        );
        format!("RISK_RESERVED:{}", o.order_id.0)
    }

    pub(crate) fn release_reservation(&mut self, o: &mut Order) {
        if let (Some(t), OrderKind::Open { intent }) = (o.reserved_terms, &o.kind) {
            let terms = to_terms(&t);
            let (mid, out) = (intent.market_id.clone(), intent.outcome_id);
            self.book_apply(&mid, out, &terms, false);
            o.reserved_terms = None;
        }
    }

    pub(crate) fn internal_hedge_return(&mut self, sender: &AccountId, amount: u128, market_id: MarketId, note: String) -> u128 {
        require!(self.roles.executors.contains(sender), "UNAUTHORIZED: executor");
        let from_custody = amount.min(self.ledger.hedge_custody_cash);
        self.ledger.hedge_custody_cash -= from_custody;
        let excess = amount - from_custody;
        self.ledger.hedge_realized_pnl += excess as i128;
        self.ledger.cash += amount;
        self.emit("hedge_return", json!({"executor": sender, "amount": U128(amount), "market_id": market_id, "note": note}));
        0
    }
}
