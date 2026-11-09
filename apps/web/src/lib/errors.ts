/** Contract reason codes -> plain English. The contract panics or records results as
 * `CODE: detail`; we keep the raw string visible next to the explanation so nothing is hidden. */

export interface ExplainedError {
  code: string;
  title: string;
  message: string;
  raw: string;
}

const MESSAGES: Record<string, [string, string]> = {
  MARKET_CLOSE_ONLY: ["Market is close-only", "This market accepts closes and reductions but no new positions right now. Existing positions can still be closed, topped up and settled."],
  MARKET_SUSPENDED: ["Market suspended", "Trading on this market is suspended. Settlement claims and margin top-ups stay available when technically possible."],
  GUARDIAN_CLOSE_ONLY: ["Guardian set close-only", "The protocol guardian restricted this market to closes only. New positions are not accepted."],
  PRICE_STALE: ["Price too old", "The signed price report is stale or the venue is not open, so the contract will not price an order against it. Try again when a fresh mark arrives."],
  PARTIAL_FILL: ["Fill below your minimum", "The vault could only take part of this order and that part is below the minimum fill you signed (or you turned partial fills off). Nothing was opened and your deposit was refunded."],
  RISK_LIMIT: ["Risk limit reached", "Opening this order would exceed a vault risk limit (event stress budget, payout liability, leverage or margin bounds). Try a smaller size or lower leverage."],
  SLIPPAGE: ["Price moved past your limit", "The executable price at execution time was worse than the maximum entry or minimum exit price you signed."],
  FAIR_VALUE: ["Fee cap too low for fair value", "The risk premium required to price the zero-floor on this position, plus the open fee, is above the maximum fee you signed. Raise the fee cap or lower leverage."],
  POLICY_MISMATCH: ["Market rules changed", "The order was signed against an older market policy. Reload the market rules and sign again."],
  POLICY_CHANGED: ["Market rules changed in flight", "The market policy changed between your request and execution, so the contract refused to execute under the new rules."],
  VAULT_PAUSED: ["Vault paused", "LP deposits or withdrawals are paused by the guardian. Funds already in the vault are unaffected."],
  POLYGON_RECONCILIATION_FAILED: ["Hedge reconciliation failed", "Independent reconciliation of the vault's external hedge inventory did not match. Opens on this market are blocked until it is resolved."],
  HEDGE_REJECTED: ["Hedge rejected", "The contract refused the vault's hedge for this order (for example no executable liquidity within your signed bound, a receipt for the wrong market or token, or a pool-only market). Your reserved deposit is released."],
  PRE_RESOLUTION_RAMP: ["Opens closed before resolution", "This market is inside its pre-resolution maintenance ramp. Maintenance for losing positions rises toward the ramp level as resolution approaches, so a new position would start underwater by the spread and could be liquidated at once. The contract takes no new positions until the market settles; existing positions can still be closed, topped up and settled."],
  ORACLE_UNATTESTED: ["Price signer not attested", "The protocol only accepts marks from reporters whose keys were registered through a TEE attestation, and this report came from a key without one. Wait for a mark from an attested reporter."],
  TEE_NOT_CONFIGURED: ["TEE not configured", "No TEE program is pinned in the protocol config, so an attested key cannot be requested yet."],
  LIQUIDATION_PENDING: ["Liquidation pending", "This position is below maintenance and a keeper liquidation is pending."],
  ORACLE_DISPUTED: ["Resolution disputed", "The final resolution of this market is disputed. Settlement waits for the dispute to clear."],
  SETTLEMENT_PENDING: ["Settlement pending", "The market is resolving. New opens are closed; positions settle against the official outcome after the dispute window."],
  OPEN_NOT_ALLOWED: ["Opens not allowed", "The market's current policy or state does not allow new positions."],
  CLOSE_NOT_ALLOWED: ["Close not allowed now", "The market's current policy or state does not allow this close right now."],
  ENTRY_WINDOW_CLOSED: ["Entry window closed", "The market policy's entry window is closed."],
  EVENT_WINDOW_CLOSE_ONLY: ["Event window: close only", "A scheduled event window put this market in close-only mode."],
  EVENT_WINDOW_SUSPENDED: ["Event window: suspended", "A scheduled event window suspended this market."],
  NO_ACTIVE_POLICY: ["No active policy", "This market has no approved policy, so it cannot trade."],
  POLICY_DISABLES_OPEN: ["Policy disables opens", "The approved policy for this market does not allow opening positions."],
  ORDER_EXPIRED: ["Order expired", "The order deadline passed before execution. Your deposit was refunded."],
  USER_CANCELLED: ["Cancelled", "You cancelled this order. Your deposit was refunded."],
  NONCE_REUSED: ["Duplicate order", "An order with this nonce was already submitted."],
  DEPOSIT_MISMATCH: ["Deposit mismatch", "The deposit must equal margin plus the maximum fee."],
  DEADLINE: ["Deadline outside policy", "The order deadline is outside the market's allowed order lifetime."],
  INVALID_PRICE: ["Invalid price", "A price in the order is outside the range (0, 1]."],
  POSITION_NOT_OPEN: ["Position not open", "The position is already closed, liquidated or settled."],
  NOTHING_TO_CLAIM: ["Nothing to claim", "There is no claimable balance for this account."],
  STORAGE_DEPOSIT_REQUIRED: ["Token registration needed", "The token contract needs a small NEAR storage deposit before it can hold a balance for this account."],
  FAUCET_LIMIT: ["Faucet limit", "The test token faucet caps each mint. Request a smaller amount."],
  LP_DEPOSIT_TOO_SMALL: ["Deposit too small", "The vault has a minimum LP deposit."],
  TIMELOCK_ACTIVE: ["Timelock active", "This policy proposal is still inside its governance timelock."],
  UNAUTHORIZED: ["Not authorized", "The connected account does not hold the role this action requires."],
  VAULT_INSOLVENT: ["Vault insolvent", "Vault NAV is not positive, so new LP shares cannot be minted."],
  NOT_LIQUIDATABLE: ["Not liquidatable", "The position is above maintenance."],
  TRIGGER_NOT_REACHED: ["Trigger not reached", "The take-profit or stop-loss price has not been reached."],
  ZERO_SHARES: ["Zero shares", "Enter a positive number of bLP shares."],
  UNKNOWN_MARKET: ["Unknown market", "This market is not admitted on the contract."],
};

const CODE_RE = /\b([A-Z][A-Z0-9_]{3,})\b/;

/** Extract the leading reason code from a contract panic or order result. */
export function errorCode(raw: string): string {
  const s = raw.replace(/^.*Smart contract panicked: /s, "").trim();
  const lead = s.match(/^([A-Z][A-Z0-9_]+)(?::|\b)/);
  if (lead && MESSAGES[lead[1]]) return lead[1];
  for (const code of Object.keys(MESSAGES)) if (s.includes(code)) return code;
  if (lead) return lead[1];
  return s.match(CODE_RE)?.[1] ?? "ERROR";
}

export function explainError(e: unknown): ExplainedError {
  const raw = typeof e === "string" ? e : String((e as any)?.message ?? e);
  const clean = raw.replace(/^.*Smart contract panicked: /s, "").trim();
  let code = errorCode(clean);
  // Generic OPEN_NOT_ALLOWED carries the specific reasons in its detail; surface the first known one.
  if (code === "OPEN_NOT_ALLOWED" || code === "CLOSE_NOT_ALLOWED") {
    const inner = Object.keys(MESSAGES).find((k) => k !== code && clean.includes(k));
    if (inner) code = inner;
  }
  const m = MESSAGES[code];
  if (!m) return { code, title: humanize(code), message: clean, raw: clean };
  return { code, title: m[0], message: m[1], raw: clean };
}

/** Plain explanation of an effective-actions reason (market restriction chip text). */
export function explainReason(reason: string): string {
  const e = explainError(reason);
  return MESSAGES[e.code] ? e.message : reason;
}

function humanize(code: string) {
  const s = code.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
