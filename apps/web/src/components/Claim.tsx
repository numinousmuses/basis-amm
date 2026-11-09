import { useApp } from "../lib/app";
import { big, usd } from "../lib/format";
import { useTx, ErrorBox } from "./ui";

/** Claim the account's claimable collateral (refunds or payouts whose transfer could not complete). */
export function ClaimButton({ claimable, compact }: { claimable?: string; compact?: boolean }) {
  const app = useApp();
  const tx = useTx();
  const amt = big(claimable);
  if (!app.client) return null;
  return (
    <>
      <button className={compact ? "mini" : "primary"} disabled={amt === 0n || !!tx.busy} onClick={() => void tx.run("Claim", () => app.client!.claim(), () => `Claimed ${usd(amt)}`)} data-testid="claim">
        {tx.busy ? "Claiming…" : amt === 0n ? "Nothing to claim" : `Claim ${usd(amt)}`}
      </button>
      {!compact && tx.error && <ErrorBox error={tx.error} />}
    </>
  );
}
