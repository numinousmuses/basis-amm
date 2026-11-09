import { useApp } from "../lib/app";
import { useTx, ErrorBox } from "./ui";
import { usd } from "../lib/format";

const FAUCET_AMOUNT = 1_000_000_000n; // $1,000 test USDC

/** Mint test USDC from the mock token faucet. The mint attaches ~0.0125 NEAR so the token can
 * register storage for a new account; the SDK sends that deposit on every faucet call. */
export function FaucetButton({ amount = FAUCET_AMOUNT }: { amount?: bigint }) {
  const app = useApp();
  const tx = useTx();
  if (!app.client || !app.accountId) return null;
  return (
    <>
      <button
        className="secondary"
        style={{ width: "100%" }}
        disabled={!!tx.busy}
        data-testid="faucet"
        onClick={async () => {
          let a = amount;
          try {
            const limit = BigInt(await app.anon.view<string>("faucet_limit", {}, app.stack.tokenId));
            if (limit > 0n && a > limit) a = limit;
          } catch {
            /* older token without the view: keep the default */
          }
          await tx.run("Faucet", () => app.client!.faucet(app.accountId!, a), () => `Minted ${usd(a)} test USDC (not real USDC)`);
        }}
      >
        {tx.busy ? "Minting…" : `Get ${usd(amount, 0)} test USDC (faucet)`}
      </button>
      {tx.error && <ErrorBox error={tx.error} />}
    </>
  );
}
