import { useEffect, useState } from "react";
import { decimalToFixed, lev as levFixed, type MarketPolicy } from "@basis/sdk";
import { api, type MarketRow } from "../lib/api";
import { useApp, useLive } from "../lib/app";
import { usePoll } from "../lib/hooks";
import { cents, fmtDate, levX, midOf, nsToMs, shortHash, usd } from "../lib/format";
import { Empty, ErrorBox, Heading, Line, Loading, StateChip, Toggle, useTx } from "../components/ui";

const TABS = ["Markets", "Governance", "Guardian", "Oracles & adapters", "Manifests", "Mock venue"] as const;
type Tab = (typeof TABS)[number];

const slug = (t: string) => t.split(" ")[0].toLowerCase();

export function AdminPage({ tab: initial }: { tab?: string }) {
  const app = useApp();
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => slug(t) === initial) ?? "Markets");
  const markets = usePoll(() => api.markets(), [], 6000, app.version);
  useLive((m) => m.type === "event" && ["guardian", "market_state", "restrictions_lifted", "policy_activated", "policy_proposed", "resolution_vote", "resolution_finalized", "settled"].includes(m.kind) && void markets.reload());
  const roles = app.roleOf(app.accountId);
  return (
    <>
      <Heading eyebrow="Basis / Operations" title="Administration" sub="Market admission, policy approvals, guardian restrictions and dev controls. Every action is a transaction signed by the connected account." />
      <div className="warnBox" style={{ marginTop: -20, marginBottom: 20 }} data-testid="admin-role">
        Connected as <b>{app.accountId ?? "nobody"}</b>
        {roles.length ? ` (${roles.join(", ")})` : " (no protocol role)"}. The contract checks roles; buttons you cannot use are disabled.
        {app.stack.network === "sandbox" && (
          <span style={{ marginLeft: 8 }}>
            Switch dev key:{" "}
            {app.devAccounts
              .filter((d) => ["admin", "risk", "guardian"].includes(d.role))
              .map((d) => (
                <button key={d.accountId} className="mini" style={{ marginLeft: 4 }} onClick={() => app.connectDev(d.accountId)} data-testid={`switch-${d.role}`}>
                  {d.role}
                </button>
              ))}
          </span>
        )}
      </div>
      <div className="subnav">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} data-testid={`admin-tab-${slug(t)}`}>
            {t}
          </button>
        ))}
      </div>
      {markets.error && !markets.data && <ErrorBox error={markets.error} onRetry={markets.reload} />}
      {!markets.data && !markets.error && <Loading />}
      {markets.data && tab === "Markets" && <MarketsAdmin rows={markets.data} />}
      {markets.data && tab === "Governance" && <Governance rows={markets.data} />}
      {tab === "Guardian" && <GuardianSwitches />}
      {tab === "Oracles & adapters" && <Oracles />}
      {tab === "Manifests" && <Manifests />}
      {markets.data && tab === "Mock venue" && <MockVenue rows={markets.data} />}
    </>
  );
}

function useRoles() {
  const app = useApp();
  const r = app.roleOf(app.accountId);
  return { admin: r.includes("admin"), risk: r.includes("risk council"), guardian: r.includes("guardian") || r.includes("risk council"), adminOrRisk: r.includes("admin") || r.includes("risk council") };
}

function MarketsAdmin({ rows }: { rows: MarketRow[] }) {
  const app = useApp();
  const tx = useTx();
  const can = useRoles();
  const active = rows.filter((r) => r.market.state === "Active" && r.actions.open).length;
  return (
    <div className="surface">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="surfaceTitle">Market policies</div>
        <span className="muted" style={{ fontSize: 11 }}>
          {active} open · {rows.length - active} restricted or finished
        </span>
      </div>
      <div className="scrollX">
        <table className="table" data-testid="admin-markets">
          <thead>
            <tr>
              <th>Market</th>
              <th>Adapters</th>
              <th>Policy</th>
              <th>Max leverage</th>
              <th>State</th>
              <th>Guardian (restrict only)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = r.market.descriptor;
              const id = d.market_id;
              return (
                <tr key={id} data-testid={`admin-market-${id}`}>
                  <td>
                    <div className="event">{d.underlying_event}</div>
                    <div className="eventMeta">
                      {d.category_label} · {d.venue} · {id}
                    </div>
                  </td>
                  <td className="code">
                    {r.policy?.executor_adapter_id}
                    <br />
                    {d.resolution_adapter_id}
                  </td>
                  <td className="code">
                    epoch {r.market.policy_epoch}
                    <br />
                    {shortHash(r.market.policy_hash)}
                  </td>
                  <td>{r.policy ? levX(r.policy.max_leverage) : "n/a"}</td>
                  <td>
                    <StateChip state={r.market.state} open={r.actions.open} closeOnly={r.actions.reasons.some((x) => x.includes("CLOSE_ONLY"))} />
                    <div className="eventMeta">{r.actions.reasons.join(", ")}</div>
                  </td>
                  <td>
                    <div className="posActions">
                      <button className="mini" disabled={!can.guardian || !!tx.busy || r.market.guardian_close_only} onClick={() => void tx.run("Set close-only", () => app.client!.setCloseOnly(id))} data-testid={`close-only-${id}`}>
                        Close only
                      </button>
                      <button className="mini" disabled={!can.guardian || !!tx.busy || r.market.guardian_paused} onClick={() => void tx.run("Pause market", () => app.client!.pauseMarket(id))} data-testid={`pause-${id}`}>
                        Pause
                      </button>
                      <button className="mini" disabled={!can.adminOrRisk || !!tx.busy || (!r.market.guardian_close_only && !r.market.guardian_paused)} onClick={() => void tx.run("Lift restrictions", () => app.client!.liftRestrictions(id))} data-testid={`lift-${id}`}>
                        Lift
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tx.error && <ErrorBox error={tx.error} />}
      <div className="callout">Markets are data: descriptors plus approved, hashed policies. No category, horizon or cutoff is hard-coded in the contract. The guardian can only restrict (close-only, pause); lifting needs admin or the risk council. Neither can confiscate positions or force a profitable close.</div>
    </div>
  );
}

function Governance({ rows }: { rows: MarketRow[] }) {
  const app = useApp();
  const tx = useTx();
  const can = useRoles();
  const props = usePoll(() => app.anon.getProposals(), [], 5000, app.version);
  const [mid, setMid] = useState(rows.find((r) => r.policy)?.market.descriptor.market_id ?? "");
  const row = rows.find((r) => r.market.descriptor.market_id === mid);
  const [levStr, setLev] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (row?.policy) setLev(String(Number(row.policy.max_leverage) / 10_000));
  }, [mid]); // eslint-disable-line react-hooks/exhaustive-deps
  const propose = () => {
    if (!row?.policy) return;
    const policy: MarketPolicy = { ...row.policy, max_leverage: levFixed(levStr || "1").toString(), human_readable_rules: note ? `${row.policy.human_readable_rules} ${note}` : row.policy.human_readable_rules };
    return tx.run("Propose policy", () => app.client!.proposePolicy(mid, policy), (r: any) => `Proposal #${r.value} created; risk council approves after the timelock`);
  };
  return (
    <div className="colsWide">
      <div className="surface">
        <div className="surfaceTitle">Pending policy proposals</div>
        {props.error && <ErrorBox error={props.error} />}
        {props.data && props.data.length === 0 && <Empty>No pending proposals.</Empty>}
        {(props.data ?? []).map(([id, p]) => {
          const ready = Date.now() >= nsToMs(p.eta_ns);
          return (
            <div className="configLine" key={id} data-testid={`proposal-${id}`}>
              <div>
                <div className="event">
                  #{id} · {p.market_id}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  by {p.proposed_by} · max leverage {levX(p.policy.max_leverage)} · hash {shortHash(p.policy_hash)} · {ready ? "timelock passed" : `timelock until ${fmtDate(nsToMs(p.eta_ns))}`}
                </div>
              </div>
              <button className="mini" disabled={!can.risk || !ready || !!tx.busy} onClick={() => void tx.run("Approve policy", () => app.client!.approvePolicy(id))} data-testid={`approve-${id}`}>
                Approve (risk council)
              </button>
            </div>
          );
        })}
        {tx.error && <ErrorBox error={tx.error} />}
      </div>
      <div className="config">
        <div className="confighead">
          <div>
            <h3>Propose a policy change</h3>
            <p>Copies the current approved policy with your edits. Activation needs risk-council approval after the timelock; orders signed against the old hash then fail with POLICY_MISMATCH.</p>
          </div>
          <span className="chip">Admin</span>
        </div>
        <label className="fieldLabel">Market</label>
        <select className="field select" value={mid} onChange={(e) => setMid(e.target.value)}>
          {rows.map((r) => (
            <option key={r.market.descriptor.market_id} value={r.market.descriptor.market_id}>
              {r.market.descriptor.underlying_event}
            </option>
          ))}
        </select>
        <div className="configLine">
          <span className="key">Max leverage (x)</span>
          <input className="field" value={levStr} onChange={(e) => setLev(e.target.value)} aria-label="Max leverage" />
        </div>
        <div className="configLine">
          <span className="key">Rules note</span>
          <input className="field" style={{ maxWidth: 260, textAlign: "left" }} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Rules note" />
        </div>
        <button className="primary" style={{ marginTop: 16 }} disabled={!can.admin || !row?.policy || !!tx.busy} onClick={() => void propose()}>
          Submit proposal
        </button>
      </div>
    </div>
  );
}

function GuardianSwitches() {
  const app = useApp();
  const tx = useTx();
  const can = useRoles();
  const pause = usePoll(() => app.anon.getPause(), [], 5000, app.version);
  const roles = usePoll(() => app.anon.getRoles(), [], 0);
  const p = pause.data;
  const sw = (label: string, on: boolean | undefined, act: () => Promise<unknown>, testId: string) => (
    <div className="configLine">
      <span>{label}</span>
      <Toggle on={!!on} label={label} disabled={!can.guardian || on || !!tx.busy} onChange={() => void tx.run(label, act)} testId={testId} />
    </div>
  );
  return (
    <div className="adminGrid">
      <div className="config">
        <h3>Protocol safety switches</h3>
        <p className="muted" style={{ fontSize: 11 }}>
          Guardian switches only restrict. Turning them back off needs admin or the risk council (Lift all).
        </p>
        {sw("Pause new opens", p?.opens, () => app.client!.pauseOpens(), "pause-opens")}
        {sw("Pause LP withdrawals", p?.withdrawals, () => app.client!.pauseWithdrawals(), "pause-withdrawals")}
        {sw("Pause LP mint and burn", p?.lp_mint_burn, () => app.client!.pauseLpMintBurn(), "pause-lp")}
        <button className="secondary" style={{ marginTop: 16 }} disabled={!can.adminOrRisk || !!tx.busy} onClick={() => void tx.run("Lift protocol pauses", () => app.client!.liftRestrictions(null))} data-testid="lift-all">
          Lift protocol pauses
        </button>
        {tx.error && <ErrorBox error={tx.error} />}
        <div className="callout">Emergency controls cannot confiscate positions, block settlement claims or silently force a profitable +100% close.</div>
      </div>
      <div className="config">
        <h3>Roles</h3>
        {roles.data ? (
          <>
            <Line k="Admin" v={roles.data.admin} />
            <Line k="Risk council" v={roles.data.risk_council} />
            <Line k="Guardian" v={roles.data.guardian} />
            <Line k="Keepers" v={roles.data.keepers.join(", ")} />
            <Line k="Executors" v={roles.data.executors.join(", ")} />
          </>
        ) : (
          <Loading />
        )}
      </div>
    </div>
  );
}

function Oracles() {
  const app = useApp();
  const reporters = usePoll(() => app.anon.getReporters(), [], 0);
  const adapters = usePoll(() => app.anon.getAdapters(), [], 0);
  const cfg = usePoll(() => app.anon.getConfig(), [], 0);
  return (
    <div className="adminGrid">
      <div className="config">
        <h3>Registered reporters</h3>
        {reporters.error && <ErrorBox error={reporters.error} />}
        {(reporters.data ?? []).map((r) => (
          <div className="configLine" key={r.public_key}>
            <div>
              <b>{r.label}</b>
              <div className="code">{shortHash(r.public_key, 10)}</div>
              <div className="muted" style={{ fontSize: 11 }}>
                {[r.can_mark && "marks", r.can_resolve && "resolution"].filter(Boolean).join(" + ")} · attestation {r.attestation_measurement || "none"}
              </div>
            </div>
            <span className={`chip ${r.active ? "on" : "warn"}`}>{r.active ? "Active" : "Inactive"}</span>
          </div>
        ))}
        <div className="callout">Reporters sign borsh-encoded reports with ed25519; the contract verifies every signature. Dev reporters on this deployment are unattested and labeled as such.</div>
      </div>
      <div className="config">
        <h3>Allowlisted adapters</h3>
        {(adapters.data ?? []).map((a) => (
          <div className="configLine" key={a}>
            <span className="code">{a}</span>
            <span className={`chip ${a.startsWith("mock") ? "sim" : "on"}`}>{a.startsWith("mock") ? "Simulated" : "Allowlisted"}</span>
          </div>
        ))}
        <h3 style={{ marginTop: 22 }}>Protocol config</h3>
        {cfg.data && (
          <>
            <Line k="Leverage ceiling" v={levX(cfg.data.max_leverage_ceiling)} />
            <Line k="Global stress cap" v={`${(cfg.data.global_stress_cap_bps / 100).toFixed(1)}% NAV`} />
            <Line k="Policy timelock" v={`${Number(cfg.data.policy_timelock_ns) / 1e9}s`} />
            <Line k="Min LP deposit" v={usd(cfg.data.min_lp_deposit)} />
            <Line k="Min insurance for opens" v={usd(cfg.data.min_insurance_for_opens)} />
          </>
        )}
      </div>
    </div>
  );
}

function Manifests() {
  const m = usePoll(() => api.manifests(), [], 0);
  if (m.error) return <ErrorBox error={m.error} />;
  if (!m.data) return <Loading />;
  return (
    <div className="surface">
      <div className="surfaceTitle">Market manifests (policies/examples)</div>
      {m.data.length === 0 && <Empty>No manifests found.</Empty>}
      <div className="scrollX">
        <table className="table">
          <thead>
            <tr>
              <th>Manifest</th>
              <th>Outcomes</th>
              <th>Strategy</th>
              <th>Max leverage</th>
              <th>Fees (open / close / hold)</th>
            </tr>
          </thead>
          <tbody>
            {m.data.map((x) => (
              <tr key={x.chain.descriptor.market_id}>
                <td>
                  <div className="event">{x.chain.descriptor.underlying_event}</div>
                  <div className="eventMeta">
                    {x.chain.descriptor.market_id} · {x.chain.descriptor.category_label}
                  </div>
                </td>
                <td>{x.chain.descriptor.outcomes.map((o) => o.label).join(" / ")}</td>
                <td className="code">{x.chain.policy.strategy}</td>
                <td>{levX(x.chain.policy.max_leverage)}</td>
                <td>
                  {x.chain.policy.fees.open_bps} / {x.chain.policy.fees.close_bps} / {x.chain.policy.fees.hold_apr_bps} bps
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="footnote">Manifests are data. Admission still requires an admin proposal and risk-council approval onchain.</div>
    </div>
  );
}

function MockVenue({ rows }: { rows: MarketRow[] }) {
  const app = useApp();
  const tradable = rows.filter((r) => !["Settled", "Invalid"].includes(r.market.state));
  const [mid, setMid] = useState(tradable[0]?.market.descriptor.market_id ?? rows[0]?.market.descriptor.market_id ?? "");
  const row = rows.find((r) => r.market.descriptor.market_id === mid);
  const outs = row?.market.descriptor.outcomes ?? [];
  const [vals, setVals] = useState<string[]>([]);
  const [scenario, setScenario] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (!row) return;
    setVals(outs.map((o) => (Number(midOf(row.mark, o.outcome_id) ?? 500000n) / 10_000).toFixed(1)));
    setScenario(0);
  }, [mid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!app.stack.devControls) return <Empty>Dev controls are disabled on this deployment.</Empty>;
  const call = async (label: string, fn: () => Promise<{ label: string; txs?: string[] }>) => {
    setBusy(label);
    setErr(null);
    try {
      const r = await fn();
      setLast(`${r.label}${r.txs?.length ? ` · ${r.txs.length} resolution tx` : ""}`);
      app.toast(r.label);
      app.bump();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };
  const setVal = (i: number, v: string) => {
    const next = [...vals];
    next[i] = v;
    if (outs.length === 2) next[1 - i] = (100 - Number(v || 0)).toFixed(1);
    setVals(next);
  };
  return (
    <div className="mockPanel" data-testid="mock-venue">
      <div className="confighead">
        <div>
          <h3>MOCK VENUE CONTROLS (simulated prices)</h3>
          <p>These call basis-node /api/dev routes. They move the deterministic mock venue and submit dev-reporter resolutions. Nothing here touches a real market.</p>
        </div>
        <span className="chip sim">Simulated</span>
      </div>
      <label className="fieldLabel">Market</label>
      <select className="field select" value={mid} onChange={(e) => setMid(e.target.value)} data-testid="mock-market">
        {rows.map((r) => (
          <option key={r.market.descriptor.market_id} value={r.market.descriptor.market_id}>
            {r.market.descriptor.underlying_event} ({r.market.state})
          </option>
        ))}
      </select>
      <div className="smallTitle">Simulated mid per outcome (¢), current {outs.map((o) => `${o.label} ${cents(midOf(row?.mark, o.outcome_id))}`).join(" · ")}</div>
      <div className="fields">
        {outs.map((o, i) => (
          <div key={o.outcome_id}>
            <label className="fieldLabel">{o.label}</label>
            <input className="field" type="number" step="0.5" value={vals[i] ?? ""} onChange={(e) => setVal(i, e.target.value)} data-testid={`mock-mid-${o.outcome_id}`} />
          </div>
        ))}
      </div>
      <div className="actionRow" style={{ marginTop: 14 }}>
        <button className="primary" disabled={!!busy} onClick={() => void call("Set prices", () => api.devVenue({ market_id: mid, mids: vals.map((v) => decimalToFixed(v || "0", 4).toString()) }))} data-testid="mock-apply">
          Apply simulated prices
        </button>
        <button className="secondary" disabled={!!busy} onClick={() => void call("Clear override", () => api.devVenue({ market_id: mid, clear: true }))} data-testid="mock-clear">
          Resume random walk
        </button>
      </div>
      <div className="smallTitle">Simulated resolution</div>
      <div className="inlineField">
        <select className="field select" value={scenario} onChange={(e) => setScenario(Number(e.target.value))} data-testid="mock-scenario">
          {(row?.market.descriptor.scenarios ?? []).map((s, i) => (
            <option key={i} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!!busy || !row || ["Settled", "Invalid"].includes(row.market.state)} onClick={() => void call("Resolve", () => api.devResolve({ market_id: mid, scenario }))} data-testid="mock-resolve">
          Submit mock resolution
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Dev reporters sign a FinalResolution report labeled mock-venue:uma-ctf-sim. After the policy dispute window the keeper finalizes and settles every open position at the scenario payout.
      </div>
      {busy && <div className="muted" style={{ marginTop: 10 }}>{busy}…</div>}
      {last && (
        <div className="muted" style={{ marginTop: 10 }} data-testid="mock-last">
          {last}
        </div>
      )}
      {err && <ErrorBox error={err} />}
      {row?.policy && <div className="footnote">Policy max mark staleness {Number(row.policy.max_mark_staleness_ns) / 1e9}s; the oracle worker relays a fresh mark every few seconds.</div>}
    </div>
  );
}
