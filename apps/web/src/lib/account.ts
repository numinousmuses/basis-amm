/** Account reads straight from the contract through the SDK (not the backend projection). */
import type { BasisClient, Market, Order, PositionView, Withdrawal } from "@basis/sdk";
import { useApp } from "./app";
import { usePoll } from "./hooks";

export interface AccountData {
  positions: PositionView[];
  orders: Order[];
  withdrawals: Withdrawal[];
  claimable: string;
  usdc: string;
  blp: string;
  registered: boolean;
}

export async function readAccount(c: BasisClient, id: string): Promise<AccountData> {
  const [positions, orders, withdrawals, claimable, usdc, blp, registered] = await Promise.all([
    c.getPositionsByOwner(id),
    c.getOrdersByOwner(id),
    c.getWithdrawalsByOwner(id),
    c.getClaimable(id),
    c.balanceOf(id).catch(() => "0"),
    c.blpBalanceOf(id).catch(() => "0"),
    c.storageRegistered(id).catch(() => false),
  ]);
  return { positions, orders, withdrawals, claimable, usdc, blp, registered };
}

export function useAccount(intervalMs = 5000) {
  const app = useApp();
  return usePoll(() => (app.accountId ? readAccount(app.anon, app.accountId) : Promise.resolve(null)), [app.accountId, app.version], intervalMs);
}

export function useMarketsMap() {
  const app = useApp();
  return usePoll(async () => new Map<string, Market>((await app.anon.getMarkets()).map((m) => [m.descriptor.market_id, m])), [], 15000);
}

export function outcomeLabel(m: Market | undefined, outcomeId: number) {
  return m?.descriptor.outcomes.find((o) => o.outcome_id === outcomeId)?.label ?? `outcome ${outcomeId}`;
}
