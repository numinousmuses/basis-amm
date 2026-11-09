import type { MarketDescriptor, MarketPolicy, StoredMark } from "@basis/sdk";
import { isSimulatedSource } from "../lib/format";
import { isLiveMarket, isLiveSource, polymarketUrl, txLink } from "../lib/live";
import { shortHash } from "../lib/format";

/** Venue chip for a market: "Live Polymarket" for markets with live refs (plus the mark's source
 * chain and an event link), the existing "mock venue" chip for fixtures. */
export function VenueChip({ d, mark, policy, compact }: { d: MarketDescriptor; mark?: StoredMark | null; policy?: MarketPolicy | null; compact?: boolean }) {
  const src = mark?.report.source_chain;
  if (isLiveMarket(d)) {
    const url = polymarketUrl(d, policy);
    return (
      <span className="venueTag" data-testid={`live-chip-${d.market_id}`}>
        <span className="chip live" title="Outcome refs point at real Polymarket tokens; marks come from the live CLOB book">
          Live Polymarket
        </span>
        {src && (
          <span className={`code ${isLiveSource(src) ? "" : "red"}`} title="Mark source chain">
            {src}
          </span>
        )}
        {!src && !compact && <span className="muted">no mark yet</span>}
        {url && (
          <a className="link" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} data-testid="polymarket-link">
            {compact ? "event ↗" : "Polymarket event ↗"}
          </a>
        )}
      </span>
    );
  }
  if (isSimulatedSource(src) || !src)
    return (
      <span className="chip sim" title="Prices and fills come from the deterministic mock venue, not a real market" data-testid={`mock-chip-${d.market_id}`}>
        mock venue
      </span>
    );
  return <span className="code">{src}</span>;
}

/** Hedge transaction reference. Only a real 0x hash on a non-simulated fill links to Polygonscan. */
export function TxRef({ hash, simulated }: { hash: string | null | undefined; simulated?: boolean | number | null }) {
  const t = txLink(hash, simulated);
  if (t.kind === "polygon")
    return (
      <a className="link code" href={t.url} target="_blank" rel="noreferrer" data-testid="tx-polygonscan">
        {shortHash(t.hash, 10)} ↗
      </a>
    );
  if (t.kind === "paper")
    return (
      <span title={`${t.hash}: paper fill, no order was placed`}>
        <span className="chip sim" data-testid="tx-paper">
          paper
        </span>{" "}
        <span className="code">{shortHash(t.hash.replace(/^paper:/, ""), 6)}</span>
      </span>
    );
  if (t.kind === "sim")
    return (
      <span title={`${t.hash}: simulated receipt from the mock venue`}>
        <span className="chip sim" data-testid="tx-sim">
          sim
        </span>{" "}
        <span className="code">{shortHash(t.hash.replace(/^sim:/, ""), 6)}</span>
      </span>
    );
  return <span className="code">{t.hash ? shortHash(t.hash, 10) : "n/a"}</span>;
}
