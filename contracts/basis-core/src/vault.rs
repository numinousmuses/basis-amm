//! Counterparty vault: bLP NEP-141 share token, conservative NAV, free vs reserved liquidity,
//! queued withdrawals that can never redeem capital reserved for synthetic payouts.

use crate::types::*;
use crate::*;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;
use near_contract_standards::fungible_token::{FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};

pub(crate) struct Nav {
    pub assets: u128,
    pub hedge_value: u128,
    pub liabilities: u128,
    pub nav: i128,
    pub fresh: bool,
}

#[near]
impl Contract {
    /// Queue a withdrawal of `shares`, settling immediately when free liquidity and NAV allow.
    /// `min_out` is the signed minimum collateral the LP accepts.
    pub fn request_withdraw(&mut self, shares: U128, min_out: U128) -> U64 {
        require!(!self.pause.withdrawals && !self.pause.lp_mint_burn, "VAULT_PAUSED: withdrawals");
        let owner = env::predecessor_account_id();
        require!(shares.0 > 0, "ZERO_SHARES");
        let me = env::current_account_id();
        self.blp.internal_transfer(&owner, &me, shares.0, Some("withdrawal escrow".into()));
        let id = self.next_withdrawal_id;
        self.next_withdrawal_id += 1;
        self.withdrawals.insert(
            id,
            Withdrawal {
                withdrawal_id: U64(id),
                owner: owner.clone(),
                shares,
                min_out,
                requested_ns: U64(now()),
                status: WithdrawalStatus::Queued,
                paid: U128(0),
            },
        );
        self.queued_withdrawals.insert(id);
        let mut list = self.user_withdrawals.get(&owner).cloned().unwrap_or_default();
        list.push(id);
        self.user_withdrawals.insert(owner.clone(), list);
        self.ledger.pending_withdrawal_shares += shares.0;
        self.emit("withdraw_requested", json!({"id": id, "owner": owner, "shares": shares, "min_out": min_out}));
        self.try_settle_withdrawal(id);
        U64(id)
    }

    /// Anyone may settle queued withdrawals in FIFO order when liquidity allows.
    pub fn settle_withdrawals(&mut self, limit: u32) -> u32 {
        let mut ids: Vec<u64> = self.queued_withdrawals.iter().copied().collect();
        ids.sort();
        let mut n = 0;
        for id in ids.into_iter().take(limit as usize) {
            if self.try_settle_withdrawal(id) {
                n += 1;
            } else {
                break; // FIFO: do not let later requests jump an unpayable earlier one
            }
        }
        n
    }

    pub fn cancel_withdraw(&mut self, withdrawal_id: U64) {
        let mut w = self.withdrawals.get(&withdrawal_id.0).cloned().unwrap_or_else(|| fail("UNKNOWN_WITHDRAWAL", ""));
        require!(w.owner == env::predecessor_account_id(), "UNAUTHORIZED: owner");
        require!(w.status == WithdrawalStatus::Queued, "WITHDRAWAL_NOT_QUEUED");
        let me = env::current_account_id();
        self.blp.internal_transfer(&me, &w.owner, w.shares.0, Some("withdrawal cancelled".into()));
        self.ledger.pending_withdrawal_shares -= w.shares.0;
        w.status = WithdrawalStatus::Cancelled;
        self.queued_withdrawals.remove(&withdrawal_id.0);
        self.withdrawals.insert(withdrawal_id.0, w);
        self.emit("withdraw_cancelled", json!({"id": withdrawal_id}));
    }
}

impl Contract {
    pub(crate) fn internal_lp_deposit(&mut self, sender: &AccountId, amount: u128, min_shares: u128) -> u128 {
        if self.pause.lp_mint_burn {
            fail("VAULT_PAUSED", "lp mint/burn");
        }
        require!(amount >= self.config.min_lp_deposit.0, "LP_DEPOSIT_TOO_SMALL");
        let nav = self.compute_nav();
        let supply = self.blp.total_supply;
        if supply > 0 {
            require!(nav.fresh, "PRICE_STALE: NAV stale, mint paused");
            require!(nav.nav > 0, "VAULT_INSOLVENT");
        }
        let shares = math(basis_math::vault::shares_for_deposit(amount, supply, basis_math::pos(nav.nav)));
        if shares == 0 || shares < min_shares {
            // Refund in full via the NEP-141 unused-amount return.
            self.emit("lp_deposit_refused", json!({"from": sender, "amount": U128(amount), "shares": U128(shares)}));
            return amount;
        }
        if !self.blp.accounts.contains_key(sender) {
            // Contract-paid registration; the minimum deposit bounds storage griefing.
            self.blp.internal_register_account(sender);
        }
        self.blp.internal_deposit(sender, shares);
        self.ledger.cash += amount;
        near_contract_standards::fungible_token::events::FtMint { owner_id: sender, amount: U128(shares), memo: Some("lp deposit") }.emit();
        self.emit(
            "lp_deposit",
            json!({"from": sender, "amount": U128(amount), "shares": U128(shares), "nav_before": nav.nav.to_string(), "supply_before": U128(supply)}),
        );
        0
    }

    pub(crate) fn try_settle_withdrawal(&mut self, id: u64) -> bool {
        let Some(mut w) = self.withdrawals.get(&id).cloned() else { return false };
        if w.status != WithdrawalStatus::Queued || self.pause.withdrawals || self.pause.lp_mint_burn {
            return false;
        }
        let nav = self.compute_nav();
        if !nav.fresh || nav.nav <= 0 {
            return false;
        }
        let supply = self.blp.total_supply;
        let assets = math(basis_math::vault::assets_for_shares(w.shares.0, supply, nav.nav as u128));
        if assets < w.min_out.0 || assets > self.free_liquidity() {
            return false;
        }
        let me = env::current_account_id();
        self.blp.internal_withdraw(&me, w.shares.0);
        near_contract_standards::fungible_token::events::FtBurn { owner_id: &w.owner, amount: w.shares, memo: Some("lp withdrawal") }.emit();
        self.ledger.pending_withdrawal_shares -= w.shares.0;
        self.ledger.cash -= assets;
        w.status = WithdrawalStatus::Settled;
        w.paid = U128(assets);
        self.queued_withdrawals.remove(&id);
        let owner = w.owner.clone();
        self.withdrawals.insert(id, w);
        self.emit("withdraw_settled", json!({"id": id, "owner": owner, "assets": U128(assets)}));
        self.pay(&owner, assets);
        true
    }

    /// Free liquidity: cash not backing posted margins or reserved worst-case payouts.
    pub(crate) fn free_liquidity(&self) -> u128 {
        self.ledger.cash.saturating_sub(self.ledger.total_open_margin).saturating_sub(self.ledger.total_payout_reserve)
    }

    /// Conservative NAV on one balance sheet. Assets: vault cash (which includes posted margin),
    /// hedge custody cash and vault-owned hedge inventory at the executable bid. Liabilities:
    /// every open synthetic claim valued at the ask (or its event maximum when no fresh mark),
    /// net of fees owed. User margin raises cash and the matching claim raises liabilities, so a
    /// fair zero-fee open leaves NAV unchanged. No loan receivable exists.
    pub(crate) fn compute_nav(&self) -> Nav {
        let staleness = self.config.nav_staleness_ns.0;
        let mut fresh = true;
        let mut liabilities: u128 = 0;
        let mut hedge_value: u128 = 0;
        let t = now();
        for (id, m) in self.markets.iter() {
            let Some(book) = self.books.get(id) else { continue };
            let has_hedge = book.hedge_units.iter().any(|u| *u > 0);
            if book.open_positions == 0 && !has_hedge {
                continue;
            }
            let settled_scenario = if m.state == MarketState::Settled { m.resolved_scenario } else { None };
            // A resolving market has no executable book by design: value it conservatively (claims
            // at their event maximum, hedges at zero) instead of freezing NAV for every market.
            let resolving = m.state == MarketState::Resolving;
            let mark = if settled_scenario.is_some() || resolving { None } else { self.fresh_mark(id, staleness) };
            if settled_scenario.is_none() && mark.is_none() && !resolving {
                fresh = false;
            }
            let matrix: Vec<Vec<u128>> =
                m.descriptor.scenarios.iter().map(|s| s.payouts.iter().map(|p| p.0).collect()).collect();
            // Hedge inventory: executable bid, or settlement payout once resolved; zero if stale.
            for (i, units) in book.hedge_units.iter().enumerate() {
                if *units == 0 {
                    continue;
                }
                let px = match (settled_scenario, &mark) {
                    (Some(s), _) => matrix[s as usize][i],
                    (None, Some(r)) => oracle::best_bid(oracle::outcome_book(r, i as u8)),
                    _ => 0,
                };
                hedge_value += math(basis_math::mul_div_floor(*units, px, basis_math::PRICE_SCALE));
            }
            let ids = self.market_positions.get(id).cloned().unwrap_or_default();
            for pid in ids {
                let Some(p) = self.positions.get(&pid) else { continue };
                if p.state != PositionState::Open {
                    continue;
                }
                let terms = to_terms(&p.terms);
                let px = match (settled_scenario, &mark) {
                    (Some(s), _) => matrix[s as usize][p.outcome_id as usize],
                    (None, Some(r)) => oracle::best_ask(oracle::outcome_book(r, p.outcome_id)),
                    _ => math(basis_math::stress::max_outcome_payout(&matrix, p.outcome_id as usize)),
                };
                let fees = p.accrued_hold_fees.0 + pending_hold_fee(p, t);
                liabilities += math(terms.equity(px, fees));
            }
        }
        let assets = self.ledger.cash + self.ledger.hedge_custody_cash + hedge_value;
        Nav { assets, hedge_value, liabilities, nav: assets as i128 - liabilities as i128, fresh }
    }
}

pub(crate) fn to_terms(t: &TermsView) -> basis_math::position::Terms {
    basis_math::position::Terms {
        margin: t.margin.0,
        notional: t.notional.0,
        units: t.units.0,
        entry_price: t.entry_price.0,
        leverage: t.leverage.0,
    }
}

pub(crate) fn from_terms(t: &basis_math::position::Terms) -> TermsView {
    TermsView {
        margin: U128(t.margin),
        notional: U128(t.notional),
        units: U128(t.units),
        entry_price: U128(t.entry_price),
        leverage: U128(t.leverage),
    }
}

pub(crate) fn pending_hold_fee(p: &Position, t: u64) -> u128 {
    let elapsed = t.saturating_sub(p.fee_accrued_ns.0) as u128;
    math(basis_math::fees::holding_fee(to_terms(&p.terms).virtual_financing_base(), p.hold_apr_bps as u128, elapsed))
}

// ---------------------------------------------------------------- bLP NEP-141

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(self.config.blp_transferable, "BLP_NONTRANSFERABLE");
        self.blp.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        require!(self.config.blp_transferable, "BLP_NONTRANSFERABLE");
        self.blp.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.blp.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.blp.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        // Force-unregister is disabled for bLP, so a resolve never burns shares.
        let (used, _burned) = self.blp.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.blp.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.blp.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Unregistering with a balance would burn bLP outside the ledger: never allow force.
        require!(force != Some(true), "BLP_FORCE_UNREGISTER_DISABLED");
        self.blp.internal_storage_unregister(Some(false)).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.blp.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.blp.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> near_contract_standards::fungible_token::metadata::FungibleTokenMetadata {
        self.blp_metadata.get().unwrap()
    }
}
