/** Shared harness for the acceptance scenarios: one deployed stack, role clients, a mock venue
 * whose MARK reports are signed by the registered dev reporter, and conservation checks. */
import assert from "node:assert/strict";
import {
  BasisClient,
  ReporterKey,
  nowNs,
  resolutionReport,
  type OrderIntent,
  type PositionView,
  type TxResult,
} from "@basis/sdk";
import { MockVenue, clientFor, type DeployedStack, type RoleName } from "@basis/stack";

export const D = 1_000_000n; // $1
export const P = (x: number) => BigInt(Math.round(x * 1_000_000));
export const LEV = (x: number) => BigInt(Math.round(x * 10_000));

export interface OpenArgs {
  market: string;
  outcome?: number;
  margin: bigint;
  lev: bigint;
  maxFee?: bigint;
  maxEntry?: bigint;
  partial?: boolean;
  minFillPpm?: bigint;
  tp?: bigint | null;
  sl?: bigint | null;
  policyHash?: string;
  deadlineNs?: bigint;
  hedgeSlipBps?: number;
}

export class Ctx {
  readonly c: Record<RoleName | "anon", BasisClient>;
  readonly venue: MockVenue;
  readonly resolveA: ReporterKey;
  readonly resolveB: ReporterKey;
  readonly log: Array<{ step: string; tx: string; note?: string }> = [];
  private nonce = BigInt(Date.now());

  constructor(readonly stack: DeployedStack) {
    const roles = Object.keys(stack.accounts) as RoleName[];
    this.c = Object.fromEntries(roles.map((r) => [r, clientFor(stack, stack.accounts[r])])) as any;
    this.c.anon = clientFor(stack);
    this.venue = new MockVenue(stack.contractId, ReporterKey.fromHex(stack.reporterSecrets.mark));
    this.resolveA = ReporterKey.fromHex(stack.reporterSecrets.resolveA);
    this.resolveB = ReporterKey.fromHex(stack.reporterSecrets.resolveB);
  }

  record(step: string, r: TxResult | { hash: string }, note?: string) {
    this.log.push({ step, tx: r.hash, note });
  }

  id(role: RoleName) {
    return this.stack.accounts[role].accountId;
  }

  /** Keeper relays fresh signed marks for every market with a configured venue book. */
  async pushMarks(markets: string[] = [...this.venue.markets.keys()]) {
    for (const m of markets) await this.c.keeper.pushMark(this.venue.mark(m));
  }

  async intent(a: OpenArgs): Promise<OrderIntent> {
    const market = await this.c.anon.getMarket(a.market);
    assert(market, `unknown market ${a.market}`);
    this.nonce += 1n;
    const partial = a.partial ?? true;
    return {
      nonce: this.nonce.toString(),
      market_id: a.market,
      outcome_id: a.outcome ?? 0,
      margin_amount: a.margin.toString(),
      requested_leverage: a.lev.toString(),
      max_entry_price: (a.maxEntry ?? P(0.99)).toString(),
      max_hedge_slippage_bps: a.hedgeSlipBps ?? 100,
      max_fee: (a.maxFee ?? 20n * D).toString(),
      deadline_ns: (a.deadlineNs ?? nowNs() + 300_000_000_000n).toString(),
      take_profit_price: a.tp?.toString() ?? null,
      stop_loss_price: a.sl?.toString() ?? null,
      allow_partial_fill: partial,
      minimum_acceptable_fill_ppm: (partial ? (a.minFillPpm ?? 500_000n) : 1_000_000n).toString(),
      policy_hash: a.policyHash ?? market.policy_hash,
      quote_id: `quote-${this.nonce}`,
    };
  }

  /** Step 1 of an open: the user's own signed ft_transfer_call. Returns the order id. */
  async request(user: RoleName, a: OpenArgs): Promise<{ orderId: string; tx: TxResult }> {
    const tx = await this.c[user].requestOpen(await this.intent(a));
    assert.equal(tx.failures.length, 0, `request failed: ${tx.failures.join(" | ")}`);
    const ev = tx.events.find((e) => e.event === "order_requested");
    assert(ev, `no order_requested event; failures=${tx.failures}`);
    return { orderId: String(ev.detail.order_id), tx };
  }

  /** Request + keeper execution with a mark observed after the commit. */
  async open(user: RoleName, a: OpenArgs): Promise<{ orderId: string; result: string; positionId?: string; tx: TxResult; exec: TxResult }> {
    const { orderId, tx } = await this.request(user, a);
    const exec = await this.c.keeper.executeOpen(orderId, this.venue.mark(a.market));
    const result = String(exec.value);
    const positionId = result.startsWith("OPEN:") ? result.slice(5) : undefined;
    return { orderId, result, positionId, tx, exec };
  }

  async close(user: RoleName, positionId: string, fractionPpm = 1_000_000n, minExit = 0n) {
    const req = await this.c[user].requestClose(positionId, fractionPpm, minExit, nowNs() + 300_000_000_000n);
    const orderId = String(req.value);
    const pos = await this.c.anon.getPosition(positionId);
    const exec = await this.c.keeper.executeClose(orderId, this.venue.mark(pos!.position.market_id));
    return { orderId, req, exec, result: String(exec.value) };
  }

  async position(id: string): Promise<PositionView> {
    const p = await this.c.anon.getPosition(id);
    assert(p, `no position ${id}`);
    return p;
  }

  async balance(role: RoleName): Promise<bigint> {
    return BigInt(await this.c.anon.balanceOf(this.id(role)));
  }

  async vault() {
    return this.c.anon.getVaultSummary();
  }

  /** Every collateral micro-unit is accounted for: token balance == tracked buckets, nothing in flight. */
  async assertConservation(label = "") {
    const cons = await this.c.anon.getConservation();
    const onToken = BigInt(await this.c.anon.balanceOf(this.stack.contractId));
    assert.equal(cons.in_flight, "0", `${label}: transfers still in flight`);
    assert.equal(BigInt(cons.tracked_on_contract), onToken, `${label}: tracked ${cons.tracked_on_contract} != token balance ${onToken}`);
    return cons;
  }

  async resolve(market: string, scenario: number, reporters: ReporterKey[] = [this.resolveA], status: "Resolved" | "Invalid" = "Resolved") {
    const out: TxResult[] = [];
    for (const k of reporters) {
      const r = resolutionReport({ marketId: market, scenario, sourceTsNs: nowNs(), status, sourceChain: "mock-venue:uma-ctf-sim", attestationRef: "mock-venue@1:deterministic" });
      out.push(await this.c.keeper.submitResolution(k.sign(this.stack.contractId, r)));
    }
    return out;
  }

  async waitDispute(market: string) {
    const r = await this.c.anon.getResolution(market);
    assert(r);
    const ms = Number((BigInt(r.finalize_after_ns) - nowNs()) / 1_000_000n);
    if (ms > 0) await new Promise((res) => setTimeout(res, ms + 1500));
  }
}

export async function expectFailure(p: Promise<TxResult>, code: string) {
  try {
    const r = await p;
    if (r.failures.some((f) => f.includes(code))) return r;
    assert.fail(`expected failure ${code}, got success ${JSON.stringify(r.value)} failures=${r.failures}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    assert(msg.includes(code), `expected ${code}, got: ${msg}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
