/** Typed client for `basis-core` and the collateral token. Writes always go through a NEAR
 * transaction signed by the acting account: a backend response never replaces user consent. */
import { Account, JsonRpcProvider } from "near-api-js";
import type {
  AuditEvent,
  Conservation,
  EffectiveActions,
  HedgeFillReceipt,
  Market,
  MarketDescriptor,
  MarketPolicy,
  OpenPreview,
  Order,
  OrderIntent,
  PauseFlags,
  PolicyProposal,
  PositionView,
  ProtocolConfig,
  ReporterInfo,
  ResolutionProposal,
  RiskSummary,
  Roles,
  SignedReport,
  StoredMark,
  VaultSummary,
  Withdrawal,
} from "./types.js";

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;

export interface TxResult<T = unknown> {
  hash: string;
  value: T | undefined;
  /** Panic messages from any receipt in the transaction (cross-contract failures included). */
  failures: string[];
  logs: string[];
  events: Array<{ event: string; seq: string; detail: any }>;
}

export class BasisTxError extends Error {
  constructor(
    message: string,
    readonly result: TxResult,
  ) {
    super(message);
  }
}

function decodeValue(b64: string | undefined): unknown {
  if (b64 === undefined || b64 === "") return undefined;
  const bin = atob(b64);
  const s = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function extractFailure(status: any): string | null {
  if (!status || typeof status !== "object" || !("Failure" in status)) return null;
  const f = status.Failure;
  const exec = f?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (exec) return String(exec).replace(/^Smart contract panicked: /, "");
  return JSON.stringify(f);
}

export function parseTx<T>(res: any): TxResult<T> {
  const hash: string = res?.transaction?.hash ?? res?.transaction_outcome?.id ?? "";
  const failures: string[] = [];
  const logs: string[] = [];
  const events: TxResult["events"] = [];
  const top = extractFailure(res?.status);
  if (top) failures.push(top);
  for (const r of res?.receipts_outcome ?? []) {
    const f = extractFailure(r?.outcome?.status);
    if (f && !failures.includes(f)) failures.push(f);
    for (const l of r?.outcome?.logs ?? []) {
      logs.push(l);
      if (l.startsWith("EVENT_JSON:")) {
        try {
          const e = JSON.parse(l.slice(11));
          if (e.standard === "basis-amm") for (const d of e.data) events.push({ event: e.event, seq: d.seq, detail: d.detail });
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
  const value = decodeValue(res?.status?.SuccessValue) as T | undefined;
  return { hash, value, failures, logs, events };
}

/** Signs and sends one function call; returns the raw RPC transaction outcome. Lets the web app
 * route writes through a browser wallet (wallet-selector) instead of a local key. */
export type TxSender = (call: {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}) => Promise<any>;

export interface BasisClientOptions {
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  account?: Account;
  sender?: TxSender;
  signerId?: string;
}

/** Highest block height any write through this process landed in, per RPC URL. Load-balanced
 * RPC endpoints can serve a node one block behind; views wait until the node has caught up so a
 * read after a write always sees that write. */
const writeHeads = new Map<string, number>();

/** Public RPC endpoints rate-limit (HTTP 429). Back off exponentially instead of failing. */
export async function withRateLimitRetry<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (i >= tries || !/429|rate limit|Too Many Requests/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
    }
  }
}

/** Optional shared view cache per RPC URL (enabled with `BasisClient.enableViewCache`). Identical
 * concurrent reads share one request; any write through this process clears the cache. */
const viewCaches = new Map<string, { ttlMs: number; entries: Map<string, { at: number; p: Promise<unknown> }> }>();

export class BasisClient {
  static enableViewCache(rpcUrl: string, ttlMs: number) {
    viewCaches.set(rpcUrl, { ttlMs, entries: new Map() });
  }

  readonly provider: JsonRpcProvider;
  readonly contractId: string;
  readonly tokenId: string;
  account?: Account;
  /** Execution wait level; EXECUTED_OPTIMISTIC waits for every receipt (cross-contract included). */
  waitUntil: "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC";

  sender?: TxSender;
  signerId?: string;

  constructor(opts: BasisClientOptions) {
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl });
    this.contractId = opts.contractId;
    this.tokenId = opts.tokenId;
    this.account = opts.account;
    this.sender = opts.sender;
    this.signerId = opts.signerId ?? opts.account?.accountId;
  }

  withAccount(account: Account): BasisClient {
    return new BasisClient({ rpcUrl: (this.provider as any).connection.url, contractId: this.contractId, tokenId: this.tokenId, account });
  }

  // ------------------------------------------------------------------ low level

  private get rpcUrl(): string {
    return (this.provider as any).connection?.url ?? "";
  }

  async view<T>(method: string, args: Record<string, unknown> = {}, contractId = this.contractId): Promise<T> {
    const vc = viewCaches.get(this.rpcUrl);
    if (vc) {
      const key = `${contractId}|${method}|${JSON.stringify(args)}`;
      const hit = vc.entries.get(key);
      if (hit && Date.now() - hit.at < vc.ttlMs) return hit.p as Promise<T>;
      const p = this.viewUncached<T>(method, args, contractId);
      vc.entries.set(key, { at: Date.now(), p });
      p.catch(() => vc.entries.delete(key));
      return p;
    }
    return this.viewUncached<T>(method, args, contractId);
  }

  private async viewUncached<T>(method: string, args: Record<string, unknown>, contractId: string): Promise<T> {
    const min = writeHeads.get(this.rpcUrl) ?? 0;
    for (let attempt = 0; ; attempt++) {
      const r: any = await withRateLimitRetry(() => this.provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality: "optimistic" } } as any));
      if ((r.block_height ?? Infinity) >= min || attempt >= 40) {
        if (!r.result || r.result.length === 0) return undefined as T;
        const text = new TextDecoder().decode(new Uint8Array(r.result));
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  /** Record the height of the last block a transaction's receipts executed in. */
  private async noteWrite(raw: any) {
    viewCaches.get(this.rpcUrl)?.entries.clear();
    const hashes: string[] = (raw?.receipts_outcome ?? []).map((r: any) => r.block_hash).filter(Boolean);
    const last = hashes[hashes.length - 1];
    if (!last) return;
    try {
      const b: any = await this.provider.viewBlock({ blockId: last } as any);
      const h = Number(b?.header?.height ?? 0);
      if (h > (writeHeads.get(this.rpcUrl) ?? 0)) writeHeads.set(this.rpcUrl, h);
    } catch {
      /* best effort */
    }
  }

  async call<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
    opts: { gas?: bigint; deposit?: bigint; contractId?: string; allowFailure?: boolean } = {},
  ): Promise<TxResult<T>> {
    if (!this.account && !this.sender) throw new Error("BasisClient: no signing account or wallet");
    let raw: any;
    try {
      const call = { receiverId: opts.contractId ?? this.contractId, methodName: method, args, gas: opts.gas ?? 300n * TGAS, deposit: opts.deposit ?? 0n };
      raw = this.sender
        ? await this.sender(call)
        : await this.account!.callFunctionRaw({
            contractId: call.receiverId,
            methodName: call.methodName,
            args: call.args,
            gas: call.gas,
            deposit: call.deposit,
            waitUntil: this.waitUntil,
          });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const panic = msg.match(/Smart contract panicked: (.*)/)?.[1] ?? msg;
      const result: TxResult = { hash: "", value: undefined, failures: [panic], logs: [], events: [] };
      if (opts.allowFailure) return result as TxResult<T>;
      throw new BasisTxError(`${method}: ${panic}`, result);
    }
    await this.noteWrite(raw);
    const r = parseTx<T>(raw);
    if (r.failures.length && !opts.allowFailure) throw new BasisTxError(`${method}: ${r.failures.join(" | ")}`, r);
    return r;
  }

  // ------------------------------------------------------------------ token

  balanceOf(accountId: string): Promise<string> {
    return this.view<string>("ft_balance_of", { account_id: accountId }, this.tokenId);
  }

  blpBalanceOf(accountId: string): Promise<string> {
    return this.view<string>("ft_balance_of", { account_id: accountId });
  }

  async storageRegistered(accountId: string, contractId = this.tokenId): Promise<boolean> {
    return (await this.view<unknown>("storage_balance_of", { account_id: accountId }, contractId)) !== null;
  }

  async registerToken(accountId: string, contractId = this.tokenId): Promise<void> {
    if (await this.storageRegistered(accountId, contractId)) return;
    await this.call("storage_deposit", { account_id: accountId, registration_only: true }, { contractId, deposit: 12_500_000_000_000_000_000_000n, gas: 30n * TGAS });
  }

  faucet(accountId: string, amount: bigint) {
    return this.call("mint", { account_id: accountId, amount: amount.toString() }, { contractId: this.tokenId, deposit: 12_500_000_000_000_000_000_000n, gas: 30n * TGAS });
  }

  /** `ft_transfer_call` of collateral into the protocol with a typed action message. */
  transferCall(amount: bigint, msg: Record<string, unknown>, opts: { allowFailure?: boolean } = {}) {
    return this.call<string>(
      "ft_transfer_call",
      { receiver_id: this.contractId, amount: amount.toString(), msg: JSON.stringify(msg) },
      { contractId: this.tokenId, deposit: ONE_YOCTO, gas: 300n * TGAS, allowFailure: opts.allowFailure },
    );
  }

  // ------------------------------------------------------------------ user writes

  /** Submit an order: deposits exactly `margin + max_fee`; the intent is frozen in this signed tx. */
  requestOpen(intent: OrderIntent, opts: { allowFailure?: boolean } = {}) {
    return this.transferCall(BigInt(intent.margin_amount) + BigInt(intent.max_fee), { action: "open", intent }, opts);
  }
  lpDeposit(amount: bigint, minShares = 0n) {
    return this.transferCall(amount, { action: "lp_deposit", min_shares: minShares.toString() });
  }
  seedInsurance(amount: bigint) {
    return this.transferCall(amount, { action: "insurance_seed" });
  }
  postMargin(positionId: string, amount: bigint) {
    return this.transferCall(amount, { action: "post_margin", position_id: positionId });
  }
  hedgeReturn(amount: bigint, marketId: string, note: string) {
    return this.transferCall(amount, { action: "hedge_return", market_id: marketId, note });
  }
  cancelOpen(orderId: string) {
    return this.call("cancel_open", { order_id: orderId });
  }
  requestClose(positionId: string, fractionPpm: bigint, minExitPrice: bigint, deadlineNs: bigint) {
    return this.call<string>("request_close", {
      position_id: positionId,
      fraction_ppm: fractionPpm.toString(),
      min_exit_price: minExitPrice.toString(),
      deadline_ns: deadlineNs.toString(),
    });
  }
  setTriggers(positionId: string, tp: bigint | null, sl: bigint | null) {
    return this.call("set_triggers", { position_id: positionId, take_profit_price: tp?.toString() ?? null, stop_loss_price: sl?.toString() ?? null });
  }
  requestWithdraw(shares: bigint, minOut = 0n) {
    return this.call<string>("request_withdraw", { shares: shares.toString(), min_out: minOut.toString() });
  }
  cancelWithdraw(id: string) {
    return this.call("cancel_withdraw", { withdrawal_id: id });
  }
  claim() {
    return this.call("claim", {});
  }

  // ------------------------------------------------------------------ keeper / executor / oracle

  pushMark(signed: SignedReport) {
    return this.call("push_mark", { signed });
  }
  executeOpen(orderId: string, signed: SignedReport) {
    return this.call<string>("execute_open", { order_id: orderId, signed });
  }
  executeClose(orderId: string, signed: SignedReport) {
    return this.call<string>("execute_close", { order_id: orderId, signed });
  }
  executeTrigger(positionId: string, signed: SignedReport) {
    return this.call<string>("execute_trigger", { position_id: positionId, signed });
  }
  liquidate(positionId: string, signed: SignedReport) {
    return this.call<string>("liquidate", { position_id: positionId, signed });
  }
  expireOrder(orderId: string) {
    return this.call("expire_order", { order_id: orderId });
  }
  submitResolution(signed: SignedReport) {
    return this.call("submit_resolution", { signed });
  }
  finalizeResolution(marketId: string) {
    return this.call("finalize_resolution", { market_id: marketId });
  }
  settlePositions(marketId: string, limit = 50) {
    return this.call<number>("settle_positions", { market_id: marketId, limit });
  }
  settleWithdrawals(limit = 20) {
    return this.call<number>("settle_withdrawals", { limit });
  }
  commitHedge(orderId: string) {
    return this.call("commit_hedge", { order_id: orderId });
  }
  submitHedgeFill(receipt: HedgeFillReceipt, opts: { allowFailure?: boolean } = {}) {
    return this.call<string>("submit_hedge_fill", { receipt }, opts);
  }
  finalizeOpenHedged(orderId: string) {
    return this.call<string>("finalize_open_hedged", { order_id: orderId });
  }
  abandonHedge(orderId: string, reason: string) {
    return this.call<string>("abandon_hedge", { order_id: orderId, reason });
  }
  requestHedgeCapital(marketId: string, amount: bigint) {
    return this.call("request_hedge_capital", { market_id: marketId, amount: amount.toString() });
  }
  reportReconciliation(marketId: string, ok: boolean, detail: string) {
    return this.call("report_reconciliation", { market_id: marketId, ok, detail });
  }
  recordHedgeRedemption(marketId: string, outcomeId: number, units: bigint, proceeds: bigint, txHash: string) {
    return this.call("record_hedge_redemption", { market_id: marketId, outcome_id: outcomeId, units: units.toString(), proceeds: proceeds.toString(), tx_hash: txHash });
  }

  // ------------------------------------------------------------------ governance

  registerAdapter(adapter: string) {
    return this.call("register_adapter", { adapter });
  }
  registerReporter(info: ReporterInfo) {
    return this.call("register_reporter", { info });
  }
  proposeMarket(descriptor: MarketDescriptor, policy: MarketPolicy) {
    return this.call<number>("propose_market", { descriptor, policy });
  }
  proposePolicy(marketId: string, policy: MarketPolicy) {
    return this.call<number>("propose_policy", { market_id: marketId, policy });
  }
  approvePolicy(proposalId: number) {
    return this.call("approve_policy", { proposal_id: proposalId });
  }
  setMarketState(marketId: string, state: string, reason: string) {
    return this.call("set_market_state", { market_id: marketId, state, reason });
  }
  setCloseOnly(marketId: string) {
    return this.call("set_close_only", { market_id: marketId });
  }
  pauseMarket(marketId: string) {
    return this.call("pause_market", { market_id: marketId });
  }
  pauseOpens() {
    return this.call("pause_opens", {});
  }
  pauseWithdrawals() {
    return this.call("pause_withdrawals", {});
  }
  pauseLpMintBurn() {
    return this.call("pause_lp_mint_burn", {});
  }
  liftRestrictions(marketId: string | null) {
    return this.call("lift_restrictions", { market_id: marketId });
  }
  disputeResolution(marketId: string, reason: string) {
    return this.call("dispute_resolution", { market_id: marketId, reason });
  }
  resetResolution(marketId: string) {
    return this.call("reset_resolution", { market_id: marketId });
  }
  writeOffHedge(marketId: string, outcomeId: number, units: bigint, custodyCash: bigint, reason: string) {
    return this.call("write_off_hedge", { market_id: marketId, outcome_id: outcomeId, units: units.toString(), custody_cash: custodyCash.toString(), reason });
  }

  // ------------------------------------------------------------------ views

  getConfig = () => this.view<ProtocolConfig>("get_config");
  getRoles = () => this.view<Roles>("get_roles");
  getPause = () => this.view<PauseFlags>("get_pause");
  getAdapters = () => this.view<string[]>("get_adapters");
  getMarkets = () => this.view<Market[]>("get_markets");
  getMarket = (marketId: string) => this.view<Market | null>("get_market", { market_id: marketId });
  getPolicy = (hash: string) => this.view<MarketPolicy | null>("get_policy", { policy_hash: hash });
  getPolicyHistory = (marketId: string) => this.view<string[]>("get_policy_history", { market_id: marketId });
  getProposals = () => this.view<Array<[number, PolicyProposal]>>("get_proposals");
  hashPolicy = (policy: MarketPolicy) => this.view<string>("hash_policy", { policy });
  getEffectiveActions = (marketId: string) => this.view<EffectiveActions>("get_effective_actions", { market_id: marketId });
  getMark = (marketId: string) => this.view<StoredMark | null>("get_mark", { market_id: marketId });
  getResolution = (marketId: string) => this.view<ResolutionProposal | null>("get_resolution", { market_id: marketId });
  getReporters = () => this.view<ReporterInfo[]>("get_reporters");
  reportDigestHex = (report: unknown) => this.view<string>("report_digest", { report });
  getVaultSummary = () => this.view<VaultSummary>("get_vault_summary");
  getConservation = () => this.view<Conservation>("get_conservation");
  getRiskSummary = (marketId: string) => this.view<RiskSummary>("get_risk_summary", { market_id: marketId });
  getPosition = (id: string) => this.view<PositionView | null>("get_position", { position_id: id });
  getPositionsByOwner = (owner: string) => this.view<PositionView[]>("get_positions_by_owner", { owner });
  getOpenPositions = (marketId: string) => this.view<PositionView[]>("get_open_positions", { market_id: marketId });
  getOrder = (id: string) => this.view<Order | null>("get_order", { order_id: id });
  getOrdersByOwner = (owner: string) => this.view<Order[]>("get_orders_by_owner", { owner });
  getPendingOrders = () => this.view<Order[]>("get_pending_orders");
  getWithdrawalsByOwner = (owner: string) => this.view<Withdrawal[]>("get_withdrawals_by_owner", { owner });
  getQueuedWithdrawals = () => this.view<Withdrawal[]>("get_queued_withdrawals");
  getClaimable = (accountId: string) => this.view<string>("get_claimable", { account_id: accountId });
  getHedgeFills = (marketId: string) => this.view<HedgeFillReceipt[]>("get_hedge_fills", { market_id: marketId });
  getEvents = (fromSeq: number | string, limit = 100) => this.view<AuditEvent[]>("get_events", { from_seq: String(fromSeq), limit });
  getLastEventSeq = () => this.view<string>("get_last_event_seq");
  isNonceUsed = (accountId: string, nonce: string) => this.view<boolean>("is_nonce_used", { account_id: accountId, nonce });
  previewOpen = (marketId: string, outcomeId: number, margin: bigint, leverage: bigint) =>
    this.view<OpenPreview>("preview_open", { market_id: marketId, outcome_id: outcomeId, margin: margin.toString(), leverage: leverage.toString() });
}
