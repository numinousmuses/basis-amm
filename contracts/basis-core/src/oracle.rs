//! Oracle: registered ed25519 reporter keys, typed MARK / RISK / FINAL_RESOLUTION reports,
//! freshness / monotonicity / spread / depth guards, and a quorum + dispute-window resolution
//! process. A TEE attestation recorded with a reporter binds code to inputs and outputs; it is not
//! proof that the external source was truthful or fresh, so finality still requires the venue's
//! own resolved status, reporter quorum and an unchallenged dispute window.

use crate::types::*;
use crate::*;
use basis_math::book::Level;

/// Allowed clock skew between a reporter's source timestamp and NEAR block time.
pub(crate) const MAX_FUTURE_SKEW_NS: u64 = 5_000_000_000;

pub(crate) fn report_digest(contract: &AccountId, r: &OracleReport) -> [u8; 32] {
    let mut msg = b"BASIS_AMM_ORACLE_V1".to_vec();
    msg.extend_from_slice(contract.as_bytes());
    msg.extend(near_sdk::borsh::to_vec(r).unwrap_or_else(|_| fail("REPORT_ENCODING", "")));
    env::sha256_array(&msg)
}

pub(crate) fn levels(v: &[BookLevel]) -> Vec<Level> {
    v.iter().map(|l| Level { price: l.price.0, size: l.size.0 }).collect()
}

pub(crate) fn outcome_book<'a>(r: &'a OracleReport, outcome: u8) -> &'a OutcomeBook {
    r.outcomes.iter().find(|o| o.outcome_id == outcome).unwrap_or_else(|| fail("PRICE_STALE", "outcome missing from report"))
}

pub(crate) fn best_bid(b: &OutcomeBook) -> u128 {
    b.bids.first().map(|l| l.price.0).unwrap_or(0)
}

pub(crate) fn best_ask(b: &OutcomeBook) -> u128 {
    b.asks.first().map(|l| l.price.0).unwrap_or(0)
}

#[near]
impl Contract {
    pub fn register_reporter(&mut self, info: ReporterInfo) {
        self.assert_admin();
        let pk = hex_decode(&info.public_key).unwrap_or_else(|| fail("REPORTER_KEY", "hex"));
        require!(pk.len() == 32, "REPORTER_KEY: 32 bytes");
        self.emit("reporter_registered", json!({"public_key": info.public_key, "label": info.label}));
        self.reporters.insert(info.public_key.clone(), info);
    }

    pub fn deactivate_reporter(&mut self, public_key: String) {
        self.assert_guardian_or_risk();
        let mut r = self.reporters.get(&public_key).cloned().unwrap_or_else(|| fail("UNKNOWN_REPORTER", &public_key));
        r.active = false;
        self.reporters.insert(public_key.clone(), r);
        self.emit("reporter_deactivated", json!({"public_key": public_key}));
    }

    /// Permissionless relay of a signed MARK report; the signature authenticates it.
    pub fn push_mark(&mut self, signed: SignedReport) {
        let m = self.market(&signed.report.market_id);
        let p = self.policy(&m.policy_hash);
        self.verify_mark(&signed, &p, 0);
    }

    /// Submit a FINAL_RESOLUTION vote. Conflicting votes move the proposal to `Disputed`.
    pub fn submit_resolution(&mut self, signed: SignedReport) {
        let info = self.verify_signature(&signed);
        require!(info.can_resolve, "UNAUTHORIZED: reporter cannot resolve");
        let r = &signed.report;
        require!(r.kind == ReportKind::FinalResolution, "ORACLE_KIND: expected FINAL_RESOLUTION");
        require!(
            matches!(r.market_status, VenueStatus::Resolved | VenueStatus::Invalid),
            "SETTLEMENT_PENDING: venue has not finalized"
        );
        let scenario = r.final_scenario.unwrap_or_else(|| fail("ORACLE_FIELDS", "final_scenario"));
        let mut m = self.market(&r.market_id);
        require!((scenario as usize) < m.descriptor.scenarios.len(), "INVALID_SCENARIO");
        require!(
            !matches!(m.state, MarketState::Settled | MarketState::Invalid | MarketState::Unlisted),
            "ALREADY_SETTLED"
        );
        let p = self.policy(&m.policy_hash);
        let mut prop = self.resolutions.get(&r.market_id).cloned().unwrap_or(ResolutionProposal {
            market_id: r.market_id.clone(),
            scenario,
            reporters: vec![],
            report_ids: vec![],
            source_hashes: vec![],
            status: ResolutionStatus::Collecting,
            quorum_ns: U64(0),
            finalize_after_ns: U64(0),
            dispute_reason: None,
        });
        require!(prop.status != ResolutionStatus::Finalized, "ALREADY_SETTLED");
        require!(!prop.reporters.contains(&signed.public_key), "DUPLICATE_RESOLUTION_VOTE");
        prop.reporters.push(signed.public_key.clone());
        prop.report_ids.push(r.report_id.clone());
        prop.source_hashes.push(r.source_hash.clone());
        if scenario != prop.scenario {
            prop.status = ResolutionStatus::Disputed;
            prop.dispute_reason = Some("ORACLE_DISPUTED: conflicting reporter outcomes".into());
        } else if prop.status == ResolutionStatus::Collecting && prop.reporters.len() >= p.min_resolution_reporters as usize {
            prop.status = ResolutionStatus::Pending;
            prop.quorum_ns = U64(now());
            prop.finalize_after_ns = U64(now() + p.dispute_window_ns.0);
        }
        // Venue has resolved: no executable book exists any more.
        m.state = MarketState::Resolving;
        let market_id = r.market_id.clone();
        self.markets.insert(market_id.clone(), m);
        self.emit(
            "resolution_vote",
            json!({"market_id": market_id, "scenario": scenario, "reporter": signed.public_key, "status": prop.status}),
        );
        self.resolutions.insert(market_id, prop);
    }

    /// Guardian or risk council freezes settlement pending investigation.
    pub fn dispute_resolution(&mut self, market_id: MarketId, reason: String) {
        self.assert_guardian_or_risk();
        let mut prop = self.resolutions.get(&market_id).cloned().unwrap_or_else(|| fail("NO_RESOLUTION", &market_id));
        require!(prop.status != ResolutionStatus::Finalized, "ALREADY_SETTLED");
        prop.status = ResolutionStatus::Disputed;
        prop.dispute_reason = Some(reason.clone());
        self.resolutions.insert(market_id.clone(), prop);
        self.emit("resolution_disputed", json!({"market_id": market_id, "reason": reason}));
    }

    /// Risk council clears a disputed proposal so reporters can vote again from scratch.
    pub fn reset_resolution(&mut self, market_id: MarketId) {
        self.assert_risk();
        let prop = self.resolutions.get(&market_id).cloned().unwrap_or_else(|| fail("NO_RESOLUTION", &market_id));
        require!(prop.status == ResolutionStatus::Disputed, "NOT_DISPUTED");
        self.resolutions.remove(&market_id);
        self.emit("resolution_reset", json!({"market_id": market_id}));
    }

    /// Anyone may finalize once quorum was reached and the dispute window passed undisputed.
    pub fn finalize_resolution(&mut self, market_id: MarketId) {
        let mut prop = self.resolutions.get(&market_id).cloned().unwrap_or_else(|| fail("NO_RESOLUTION", &market_id));
        match prop.status {
            ResolutionStatus::Pending => {}
            ResolutionStatus::Disputed => fail("ORACLE_DISPUTED", prop.dispute_reason.clone().unwrap_or_default()),
            ResolutionStatus::Collecting => fail("SETTLEMENT_PENDING", "quorum not reached"),
            ResolutionStatus::Finalized => fail("ALREADY_SETTLED", ""),
        }
        require!(now() >= prop.finalize_after_ns.0, "SETTLEMENT_PENDING: dispute window open");
        prop.status = ResolutionStatus::Finalized;
        let mut m = self.market(&market_id);
        m.state = MarketState::Settled;
        m.resolved_scenario = Some(prop.scenario);
        self.markets.insert(market_id.clone(), m);
        self.emit("resolution_finalized", json!({"market_id": market_id, "scenario": prop.scenario}));
        self.resolutions.insert(market_id, prop);
    }
}

impl Contract {
    pub(crate) fn verify_signature(&self, s: &SignedReport) -> ReporterInfo {
        let info = self.reporters.get(&s.public_key).cloned().unwrap_or_else(|| fail("UNKNOWN_REPORTER", &s.public_key));
        require!(info.active, "REPORTER_INACTIVE");
        let pk: [u8; 32] = hex_decode(&s.public_key)
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| fail("REPORTER_KEY", "decode"));
        let sig: [u8; 64] = hex_decode(&s.signature)
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| fail("ORACLE_BAD_SIGNATURE", "decode"));
        let digest = report_digest(&env::current_account_id(), &s.report);
        require!(env::ed25519_verify(&sig, digest, &pk), "ORACLE_BAD_SIGNATURE");
        info
    }

    /// Verify a MARK report for use at time `now()`: signature, kind, freshness, monotonic source
    /// time, observed after `not_before_ns` (order commit), venue open, spreads within policy.
    /// Stores it as the latest mark and returns it.
    pub(crate) fn verify_mark(&mut self, s: &SignedReport, p: &MarketPolicy, not_before_ns: u64) -> OracleReport {
        let info = self.verify_signature(s);
        require!(info.can_mark, "UNAUTHORIZED: reporter cannot mark");
        let r = &s.report;
        require!(r.kind == ReportKind::Mark, "ORACLE_KIND: expected MARK");
        let t = now();
        let src = r.source_timestamp_ns.0;
        require!(src <= t + MAX_FUTURE_SKEW_NS, "PRICE_STALE: source timestamp in the future");
        require!(t <= r.valid_until_ns.0, "PRICE_STALE: report expired");
        require!(t.saturating_sub(src) <= p.max_mark_staleness_ns.0, "PRICE_STALE: older than policy staleness");
        require!(src >= not_before_ns, "PRICE_STALE: observation precedes order commit");
        require!(!r.source_hash.is_empty() && !r.source_chain.is_empty(), "ORACLE_FIELDS: missing source provenance");
        let m = self.market(&r.market_id);
        require!(r.outcomes.len() == m.descriptor.outcomes.len(), "ORACLE_FIELDS: outcome count");
        for ob in &r.outcomes {
            require!((ob.outcome_id as usize) < m.descriptor.outcomes.len(), "ORACLE_FIELDS: outcome id");
            let (bid, ask) = (best_bid(ob), best_ask(ob));
            require!(bid > 0 && ask > 0 && bid <= ask, "PRICE_STALE: missing or crossed book");
            let spread = math(basis_math::book::spread_bps(bid, ask));
            require!(spread <= p.max_spread_bps as u128, "SLIPPAGE: spread above policy guard");
        }
        if let Some(prev) = self.marks.get(&r.market_id) {
            require!(src >= prev.report.source_timestamp_ns.0, "PRICE_STALE: older than stored mark (replay)");
        }
        let report = r.clone();
        self.marks.insert(
            r.market_id.clone(),
            StoredMark { report: report.clone(), reporter: s.public_key.clone(), stored_ns: U64(t) },
        );
        report
    }

    /// Latest stored mark if still within `staleness_ns`.
    pub(crate) fn fresh_mark(&self, market_id: &MarketId, staleness_ns: u64) -> Option<OracleReport> {
        let m = self.marks.get(market_id)?;
        let t = now();
        if t <= m.report.valid_until_ns.0.max(m.report.source_timestamp_ns.0 + staleness_ns)
            && t.saturating_sub(m.report.source_timestamp_ns.0) <= staleness_ns
        {
            Some(m.report.clone())
        } else {
            None
        }
    }
}
