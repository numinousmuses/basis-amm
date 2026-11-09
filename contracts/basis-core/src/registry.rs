//! Registry: adapter allowlist, market descriptors, versioned hash-pinned policies with a timelock,
//! lifecycle state, and the effective action gates derived from policy, state, windows and
//! guardian restrictions. No market category is privileged anywhere in this module.

use crate::types::*;
use crate::*;
use basis_math::{BPS, LEV_SCALE, PPM, PRICE_SCALE};

pub(crate) fn policy_hash(p: &MarketPolicy) -> String {
    let bytes = near_sdk::borsh::to_vec(p).unwrap_or_else(|_| fail("POLICY_ENCODING", ""));
    hex_encode(&env::sha256_array(&bytes))
}

#[near]
impl Contract {
    /// Allowlist an adapter as `id@version` (execution, pricing or resolution adapter).
    pub fn register_adapter(&mut self, adapter: String) {
        self.assert_admin();
        require!(adapter.contains('@'), "ADAPTER_ID: expected id@version");
        self.adapters.insert(adapter.clone());
        self.emit("adapter_registered", json!({"adapter": adapter}));
    }

    pub fn revoke_adapter(&mut self, adapter: String) {
        self.assert_admin_or_risk();
        self.adapters.remove(&adapter);
        self.emit("adapter_revoked", json!({"adapter": adapter}));
    }

    /// Propose a new market with its initial policy. The market enters `PENDING_REVIEW` and only
    /// becomes `ACTIVE` when the risk council approves after the timelock. No redeploy needed.
    pub fn propose_market(&mut self, descriptor: MarketDescriptor, policy: MarketPolicy) -> u64 {
        self.assert_admin();
        require!(!self.markets.contains_key(&descriptor.market_id), "MARKET_EXISTS");
        self.validate_descriptor(&descriptor);
        self.validate_policy(&descriptor, &policy);
        let market_id = descriptor.market_id.clone();
        let n_out = descriptor.outcomes.len();
        let n_sc = descriptor.scenarios.len();
        self.markets.insert(
            market_id.clone(),
            Market {
                descriptor,
                state: MarketState::PendingReview,
                policy_hash: String::new(),
                policy_epoch: 0,
                listed_ns: U64(now()),
                guardian_close_only: false,
                guardian_paused: false,
                resolved_scenario: None,
            },
        );
        self.books.insert(
            market_id.clone(),
            EventBook {
                trader_pnl: vec![0; n_sc],
                hedge_units: vec![0; n_out],
                hedge_cost: vec![0; n_out],
                open_units: vec![0; n_out],
                ..Default::default()
            },
        );
        self.market_positions.insert(market_id.clone(), vec![]);
        self.emit("market_proposed", json!({"market_id": market_id}));
        self.internal_propose_policy(market_id, policy)
    }

    /// Propose a new policy version for an existing market (timelocked).
    pub fn propose_policy(&mut self, market_id: MarketId, policy: MarketPolicy) -> u64 {
        self.assert_admin();
        let m = self.market(&market_id);
        self.validate_policy(&m.descriptor, &policy);
        self.internal_propose_policy(market_id, policy)
    }

    /// Risk council approval after the timelock. Activates the policy version; a listing proposal
    /// also moves the market to `ACTIVE`. Positions keep the policy hash/epoch they opened with.
    pub fn approve_policy(&mut self, proposal_id: u64) {
        self.assert_risk();
        let p = self.proposals.remove(&proposal_id).unwrap_or_else(|| fail("UNKNOWN_PROPOSAL", proposal_id.to_string()));
        require!(now() >= p.eta_ns.0, "TIMELOCK_ACTIVE");
        let mut m = self.market(&p.market_id);
        // Re-validate against the current protocol config at approval time.
        self.validate_policy(&m.descriptor, &p.policy);
        self.policies.insert(p.policy_hash.clone(), p.policy.clone());
        let mut hist = self.policy_history.get(&p.market_id).cloned().unwrap_or_default();
        hist.push(p.policy_hash.clone());
        self.policy_history.insert(p.market_id.clone(), hist);
        m.policy_hash = p.policy_hash.clone();
        m.policy_epoch += 1;
        if m.state == MarketState::PendingReview {
            m.state = MarketState::Active;
        }
        let epoch = m.policy_epoch;
        self.markets.insert(p.market_id.clone(), m);
        self.emit(
            "policy_activated",
            json!({"market_id": p.market_id, "policy_hash": p.policy_hash, "epoch": epoch, "approved_by": env::predecessor_account_id()}),
        );
    }

    pub fn reject_proposal(&mut self, proposal_id: u64) {
        self.assert_admin_or_risk();
        self.proposals.remove(&proposal_id);
        self.emit("proposal_rejected", json!({"proposal_id": proposal_id}));
    }

    /// Lifecycle transition recorded as the result of approved policy evaluation or venue events
    /// (for example `CLOSE_ONLY` around a catalyst). Resolution states are driven by the oracle.
    pub fn set_market_state(&mut self, market_id: MarketId, state: MarketState, reason: String) {
        self.assert_risk();
        let mut m = self.market(&market_id);
        let allowed_from = matches!(m.state, MarketState::Active | MarketState::CloseOnly | MarketState::Suspended);
        let allowed_to = matches!(state, MarketState::Active | MarketState::CloseOnly | MarketState::Suspended);
        require!(allowed_from && allowed_to, "INVALID_TRANSITION");
        let from = m.state;
        m.state = state;
        self.markets.insert(market_id.clone(), m);
        self.emit("market_state", json!({"market_id": market_id, "from": from, "to": state, "reason": reason}));
    }

    /// Delist a market with no open exposure.
    pub fn delist_market(&mut self, market_id: MarketId) {
        self.assert_admin_or_risk();
        let b = self.book(&market_id);
        require!(b.open_positions == 0, "OPEN_POSITIONS_EXIST");
        let mut m = self.market(&market_id);
        m.state = MarketState::Unlisted;
        self.markets.insert(market_id.clone(), m);
        self.emit("market_state", json!({"market_id": market_id, "to": "Unlisted"}));
    }
}

impl Contract {
    fn internal_propose_policy(&mut self, market_id: MarketId, policy: MarketPolicy) -> u64 {
        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let hash = policy_hash(&policy);
        let t = now();
        self.proposals.insert(
            id,
            PolicyProposal {
                market_id: market_id.clone(),
                policy,
                policy_hash: hash.clone(),
                proposed_by: env::predecessor_account_id(),
                proposed_ns: U64(t),
                eta_ns: U64(t + self.config.policy_timelock_ns.0),
            },
        );
        self.emit("policy_proposed", json!({"proposal_id": id, "market_id": market_id, "policy_hash": hash}));
        id
    }

    pub(crate) fn validate_descriptor(&self, d: &MarketDescriptor) {
        require!(!d.market_id.is_empty() && d.market_id.len() <= 64, "DESCRIPTOR: market_id");
        require!(!d.venue.is_empty() && !d.chain.is_empty(), "DESCRIPTOR: venue/chain domain required");
        require!(d.outcomes.len() >= 2 && d.outcomes.len() <= 16, "DESCRIPTOR: outcomes");
        for (i, o) in d.outcomes.iter().enumerate() {
            require!(o.outcome_id as usize == i, "DESCRIPTOR: outcome ids must be 0..n in order");
            require!(o.venue_token_ref.contains(':'), "DESCRIPTOR: venue token ref needs chain domain");
        }
        require!(!d.scenarios.is_empty() && d.scenarios.len() <= 16, "DESCRIPTOR: scenarios");
        let matrix: Vec<Vec<u128>> = d.scenarios.iter().map(|s| s.payouts.iter().map(|p| p.0).collect()).collect();
        if basis_math::stress::validate_payout_matrix(&matrix, d.outcomes.len()).is_err() {
            fail("PAYOUT_VECTOR_UNPROVEN", "scenario payout matrix invalid");
        }
        // Every outcome must be able to pay something in some scenario, and every scenario must
        // be a proven, fully specified payout vector (no implicit binary assumption).
        for i in 0..d.outcomes.len() {
            let mx = math(basis_math::stress::max_outcome_payout(&matrix, i));
            require!(mx > 0 && mx <= PRICE_SCALE, "PAYOUT_VECTOR_UNPROVEN: outcome never pays");
        }
        require!(self.adapters.contains(&d.resolution_adapter_id), "ADAPTER_NOT_ALLOWLISTED: resolution");
    }

    pub(crate) fn validate_policy(&self, d: &MarketDescriptor, p: &MarketPolicy) {
        require!(p.schema_version == 1, "POLICY_SCHEMA_UNSUPPORTED");
        require!(self.adapters.contains(&p.executor_adapter_id), "ADAPTER_NOT_ALLOWLISTED: executor");
        require!(self.adapters.contains(&p.pricing_adapter_id), "ADAPTER_NOT_ALLOWLISTED: pricing");
        require!(self.adapters.contains(&p.risk_model_id), "ADAPTER_NOT_ALLOWLISTED: risk model");
        require!(
            p.max_leverage.0 >= LEV_SCALE && p.max_leverage.0 <= self.config.max_leverage_ceiling.0,
            "POLICY: leverage outside protocol ceiling"
        );
        require!(p.tick_size.0 > 0 && p.tick_size.0 < PRICE_SCALE, "POLICY: tick size");
        require!(p.min_adverse_ticks >= 1, "POLICY: min adverse ticks");
        require!(p.min_margin.0 > 0 && p.min_margin.0 <= p.max_margin.0, "POLICY: margin bounds");
        require!((p.maintenance_bps as u128) < BPS, "POLICY: maintenance");
        require!((p.max_spread_bps as u128) <= BPS && (p.exit_depth_bps as u128) <= BPS * 10, "POLICY: liquidity guards");
        require!(p.max_mark_staleness_ns.0 > 0, "POLICY: oracle staleness");
        require!(p.min_resolution_reporters >= 1, "POLICY: resolution quorum");
        let f = &p.fees;
        let bound = self.config.max_fee_bps_bound;
        require!(
            f.open_bps <= bound && f.close_bps <= bound && f.liquidation_reward_bps <= bound,
            "POLICY: fee above protocol bound"
        );
        require!((f.hold_apr_bps as u128) <= BPS, "POLICY: hold apr");
        require!((f.floor_coverage_bps as u128) <= BPS, "POLICY: floor coverage");
        require!((f.insurance_share_bps as u128 + f.treasury_share_bps as u128) <= BPS, "POLICY: fee split");
        require!(p.event_stress_cap_bps <= self.config.max_event_stress_cap_bps, "POLICY: event stress cap");
        require!(p.hedge_budget_bps <= self.config.max_hedge_budget_bps, "POLICY: hedge budget");
        require!(p.min_fill_floor_ppm.0 <= PPM, "POLICY: min fill floor");
        require!(p.entry_start_ns.0 <= p.entry_end_ns.0, "POLICY: entry window");
        for w in &p.event_windows {
            require!(w.start_ns.0 <= w.end_ns.0, "POLICY: event window");
        }
        require!(p.max_order_lifetime_ns.0 > 0, "POLICY: order lifetime");
        require!(
            p.pre_resolution_maintenance_bps == 0 || (p.pre_resolution_maintenance_bps >= p.maintenance_bps && (p.pre_resolution_maintenance_bps as u128) < BPS),
            "POLICY: pre-resolution maintenance"
        );
        if p.strategy != StrategyMode::PoolOnly {
            require!(p.hedge_budget_bps > 0, "POLICY: hedge strategy needs a hedge budget");
        }
        let _ = d;
    }

    /// Actions currently permitted on a market, with plain reasons for each restriction.
    pub(crate) fn effective_actions(&self, m: &Market, t: u64) -> EffectiveActions {
        let mut e = EffectiveActions {
            market_id: m.descriptor.market_id.clone(),
            state: m.state,
            open: false,
            reduce: false,
            close: false,
            liquidate: false,
            reasons: vec![],
        };
        let Some(p) = self.policies.get(&m.policy_hash) else {
            e.reasons.push("NO_ACTIVE_POLICY".into());
            return e;
        };
        let a = p.allowed_actions;
        match m.state {
            MarketState::Active => {
                e.open = a.open;
                e.reduce = a.reduce;
                e.close = a.close;
                e.liquidate = a.liquidate;
            }
            MarketState::CloseOnly => {
                e.reduce = a.reduce;
                e.close = a.close;
                e.liquidate = a.liquidate;
                e.reasons.push("MARKET_CLOSE_ONLY".into());
            }
            MarketState::Suspended => e.reasons.push("MARKET_SUSPENDED".into()),
            MarketState::Resolving => e.reasons.push("SETTLEMENT_PENDING".into()),
            s => e.reasons.push(format!("MARKET_STATE_{s:?}").to_uppercase()),
        }
        if !a.open {
            e.reasons.push("POLICY_DISABLES_OPEN".into());
        }
        if t < p.entry_start_ns.0 || t > p.entry_end_ns.0 {
            if e.open {
                e.reasons.push("ENTRY_WINDOW_CLOSED".into());
            }
            e.open = false;
        }
        for w in &p.event_windows {
            if t >= w.start_ns.0 && t <= w.end_ns.0 {
                match w.mode {
                    WindowMode::CloseOnly => {
                        e.open = false;
                        e.reasons.push(format!("EVENT_WINDOW_CLOSE_ONLY: {}", w.label));
                    }
                    WindowMode::Suspend => {
                        e.open = false;
                        e.reduce = false;
                        e.close = false;
                        e.reasons.push(format!("EVENT_WINDOW_SUSPENDED: {}", w.label));
                    }
                }
            }
        }
        // No new exposure once the pre-resolution maintenance ramp has started: a fresh position is
        // underwater by the spread and the ramp would liquidate it immediately.
        if p.pre_resolution_maintenance_bps > p.maintenance_bps
            && t >= m.descriptor.expected_resolution_ns.0.saturating_sub(p.maintenance_ramp_ns.0)
        {
            if e.open {
                e.reasons.push("PRE_RESOLUTION_RAMP: no new positions while maintenance ramps toward resolution".into());
            }
            e.open = false;
        }
        if m.guardian_close_only {
            e.open = false;
            e.reasons.push("GUARDIAN_CLOSE_ONLY".into());
        }
        if m.guardian_paused {
            e.open = false;
            e.reduce = false;
            e.close = false;
            e.liquidate = false;
            e.reasons.push("GUARDIAN_PAUSED_MARKET".into());
        }
        if self.pause.opens {
            e.open = false;
            e.reasons.push("VAULT_PAUSED: opens".into());
        }
        if self.frozen_markets.contains(&m.descriptor.market_id) {
            e.open = false;
            e.reasons.push("POLYGON_RECONCILIATION_FAILED".into());
        }
        if self.ledger.insurance < self.config.min_insurance_for_opens.0 {
            e.open = false;
            e.reasons.push("INSURANCE_BELOW_MINIMUM".into());
        }
        e
    }
}
