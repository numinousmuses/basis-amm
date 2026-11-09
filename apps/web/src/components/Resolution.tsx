import type { Market, MarketPolicy, ResolutionProposal } from "@basis/sdk";
import { api, type ResolverObservation } from "../lib/api";
import { useApp } from "../lib/app";
import { usePoll, useNow } from "../lib/hooks";
import { big, fmtDate, fmtSeconds, nsToMs, ppmPct, shortHash } from "../lib/format";
import { isLiveMarket } from "../lib/live";
import { Empty, ErrorBox, Line } from "./ui";

const STATUS_TEXT: Record<ResolutionProposal["status"], string> = {
  Collecting: "Collecting reports until the reporter quorum is reached",
  Pending: "Quorum reached; waiting out the dispute window",
  Disputed: "Disputed; settlement waits until the dispute clears",
  Finalized: "Finalized; positions settle at this scenario's payout",
};

/** Contract resolution proposal for a market, plus, for live Polymarket markets, what the
 * resolver saw from the Polymarket API and the Conditional Tokens contract on Polygon. */
export function ResolutionPanel({ market, policy, resolution }: { market: Market; policy: MarketPolicy | null; resolution: ResolutionProposal | null }) {
  const app = useApp();
  const now = useNow(1000);
  const d = market.descriptor;
  const live = isLiveMarket(d);
  const reporters = usePoll(() => app.anon.getReporters(), [], 0);
  const status = usePoll(() => (live ? api.polymarketStatus() : Promise.resolve(null)), [live], 10000);
  const label = (pk: string) => reporters.data?.find((r) => r.public_key === pk)?.label ?? shortHash(pk, 10);
  const obs = status.data?.resolutions[d.market_id];
  const finalizeMs = resolution ? nsToMs(resolution.finalize_after_ns) : 0;
  const settledLabel = market.resolved_scenario !== null && market.resolved_scenario !== undefined ? d.scenarios[market.resolved_scenario]?.label : null;
  return (
    <div className="surface" style={{ marginTop: 18 }} data-testid="resolution-panel">
      <div className="surfaceTitle">Resolution</div>
      <Line k="Source" v={<span style={{ fontWeight: 450 }}>{d.resolution_source}</span>} />
      <Line k="Expected resolution" v={fmtDate(nsToMs(d.expected_resolution_ns))} />
      {policy && <Line k="Quorum / dispute window" v={`${policy.min_resolution_reporters} reporter(s) · ${fmtSeconds(Math.round(nsToMs(policy.dispute_window_ns) / 1000))}`} />}
      {settledLabel && <Line k="Settled scenario" v={settledLabel} testId="resolution-settled" />}
      <div className="smallTitle">Contract proposal (get_resolution)</div>
      {!resolution ? (
        <div className="muted" style={{ fontSize: 12 }} data-testid="resolution-none">
          No resolution has been proposed. Reporters submit a signed final report once the venue resolves.
        </div>
      ) : (
        <div data-testid="resolution-proposal" data-status={resolution.status}>
          <Line k="Status" v={<span className={`chip ${resolution.status === "Finalized" ? "on" : resolution.status === "Disputed" ? "bad" : "warn"}`}>{resolution.status}</span>} testId="resolution-status" />
          <div className="muted" style={{ fontSize: 11, textAlign: "right" }}>
            {STATUS_TEXT[resolution.status]}
          </div>
          <Line k="Scenario" v={d.scenarios[resolution.scenario]?.label ?? `#${resolution.scenario}`} testId="resolution-scenario" />
          {big(resolution.quorum_ns) > 0n && <Line k="Quorum reached" v={fmtDate(nsToMs(resolution.quorum_ns))} />}
          {big(resolution.finalize_after_ns) > 0n && (
            <Line k="Finalize after" v={`${fmtDate(finalizeMs)}${resolution.status !== "Finalized" ? (finalizeMs > now ? ` (in ${fmtSeconds(Math.round((finalizeMs - now) / 1000))})` : " (window passed)") : ""}`} testId="resolution-finalize" />
          )}
          {resolution.dispute_reason && <Line k="Dispute reason" v={resolution.dispute_reason} />}
          <div className="smallTitle">Reports ({resolution.reporters.length})</div>
          {resolution.reporters.map((pk, i) => (
            <div className="configLine" key={pk + i} style={{ alignItems: "flex-start" }}>
              <div>
                <b>{label(pk)}</b>
                <div className="code">report {shortHash(resolution.report_ids[i], 12)}</div>
              </div>
              <span className="code" title="Source hash">
                src {shortHash(resolution.source_hashes[i], 8)}
              </span>
            </div>
          ))}
        </div>
      )}
      {live && (
        <>
          <div className="smallTitle">Resolver observations (basis-node, two independent sources)</div>
          {status.error && <ErrorBox error={status.error} />}
          {!obs ? (
            <Empty>The resolver has not checked this market yet.</Empty>
          ) : (
            <>
              <div className="obsGrid" data-testid="resolver-observations">
                <Observation title="Polymarket resolution API" o={obs.api} />
                <Observation title="Conditional Tokens contract (Polygon)" o={obs.chain} missing="Not read: Protocol V2 markets settle outside the legacy CTF contract" />
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                Checked {fmtDate(Date.parse(obs.at))}. Each source is signed by a different reporter; the contract needs the quorum and the dispute window before it settles.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Observation({ title, o, missing = "Not read yet" }: { title: string; o?: ResolverObservation; missing?: string }) {
  return (
    <div className="obs">
      <b>{title}</b>
      {!o ? (
        <span className="muted">{missing}</span>
      ) : (
        <>
          <span className={`chip ${o.resolved ? "on" : ""}`}>{o.resolved ? "Resolved" : "Not resolved"}</span>
          {o.resolved && <div style={{ marginTop: 6 }}>Payouts {o.payoutsPpm.map((p) => ppmPct(p, 0)).join(" / ")}</div>}
          <div className="code wrapCode" style={{ marginTop: 6 }}>
            {o.source}
          </div>
          <div className="code wrapCode muted">{o.evidence}</div>
        </>
      )}
    </div>
  );
}
