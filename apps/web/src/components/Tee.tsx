import type { TeeConfig } from "@basis/sdk";
import { useApp } from "../lib/app";
import { usePoll } from "../lib/hooks";
import { fmtDate, nsToMs, shortHash } from "../lib/format";
import { Empty, ErrorBox, Line, Loading } from "./ui";

/** TEE oracle and executor state, read straight from the contract. */
export function TeePanel() {
  const app = useApp();
  const cfg = usePoll(() => app.anon.getConfig(), [], 15000);
  const reporters = usePoll(() => app.anon.getReporters(), [], 15000);
  const execs = usePoll(() => app.anon.getTeeExecutors(), [], 15000);
  const c = cfg.data;
  const attested = (reporters.data ?? []).filter((r) => r.tee_attested).length;
  return (
    <div className="surface" style={{ marginTop: 20 }} data-testid="tee-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="surfaceTitle">TEE oracle and executor</div>
        {c && (
          <span className={`chip ${c.require_attested_marks ? "on" : "warn"}`} data-testid="tee-require">
            require_attested_marks: {c.require_attested_marks ? "on" : "off"}
          </span>
        )}
      </div>
      <div className="callout" style={{ marginTop: 0 }}>
        <div>
          <b>Attested</b> means the reporter's signing key was generated inside an Intel TDX enclave running the exact WASM program pinned below, and the contract registered it through OutLayer; nobody, including the operator, ever sees that key.
        </div>
        <div style={{ marginTop: 6 }} data-testid="tee-demo-note">
          {c?.require_attested_marks
            ? "This deployment rejects marks from unattested keys (ORACLE_UNATTESTED)."
            : `The ${app.stack.network} demo runs without it: require_attested_marks is off, so marks signed by the dev reporter key are accepted and labeled unattested.`}
        </div>
      </div>
      {cfg.error && <ErrorBox error={cfg.error} />}
      {!c && !cfg.error && <Loading />}
      {c && (
        <div className="split" style={{ marginTop: 14 }}>
          <TeeConfigBlock title="Mark oracle program (config.tee)" t={c.tee} testId="tee-config" />
          <TeeConfigBlock title="Hedge executor program (config.tee_executor)" t={c.tee_executor} testId="tee-executor-config" />
        </div>
      )}
      <div className="smallTitle">
        Reporters ({attested} of {reporters.data?.length ?? 0} attested)
      </div>
      {reporters.error && <ErrorBox error={reporters.error} />}
      {(reporters.data ?? []).map((r) => (
        <div className="configLine" key={r.public_key} data-testid={`tee-reporter-${r.label}`}>
          <div style={{ minWidth: 0 }}>
            <b>{r.label}</b> <span className="code">{shortHash(r.public_key, 8)}</span>
            <div className="muted wrapCode" style={{ fontSize: 11 }}>
              {[r.can_mark && "marks", r.can_resolve && "resolution"].filter(Boolean).join(" + ")} · measurement {r.attestation_measurement || "none"}
            </div>
          </div>
          <span>
            <span className={`chip ${r.tee_attested ? "on" : "warn"}`}>{r.tee_attested ? "TEE attested" : "Unattested"}</span> {!r.active && <span className="chip">Inactive</span>}
          </span>
        </div>
      ))}
      <div className="smallTitle">TEE executor keys (get_tee_executors)</div>
      {execs.error && <ErrorBox error={execs.error} />}
      {execs.data && execs.data.length === 0 && <Empty>No TEE executor key is registered. In LIVE mode, hedge orders would be signed by the key basis-node was started with instead.</Empty>}
      {(execs.data ?? []).map((k) => (
        <div className="configLine" key={k.evm_address} data-testid="tee-executor-row">
          <div>
            <b>{k.label}</b> <span className="code">{k.evm_address}</span>
            <div className="muted" style={{ fontSize: 11 }}>
              wasm {shortHash(k.wasm_hash, 10)} · registered {fmtDate(nsToMs(k.registered_ns))}
            </div>
          </div>
          <span className={`chip ${k.active ? "on" : ""}`}>{k.active ? "Active" : "Deactivated"}</span>
        </div>
      ))}
      <div className="footnote">Attestation proves which program ran and what it signed. It does not prove the venue told the truth, so the program cross-checks a second price source and the contract still enforces staleness, spread and depth. Resolution never comes from the TEE alone.</div>
    </div>
  );
}

function TeeConfigBlock({ title, t, testId }: { title: string; t: TeeConfig | null; testId: string }) {
  return (
    <div className="obs" data-testid={testId}>
      <b>{title}</b>
      {!t ? (
        <span className="muted">Not configured</span>
      ) : (
        <>
          <Line k="OutLayer contract" v={<span className="code">{t.outlayer_contract}</span>} />
          <Line k="Pinned WASM SHA-256" v={<span className="code wrapCode">{shortHash(t.wasm_hash, 12)}</span>} />
          <Line k="Build target" v={<span className="code">{t.build_target}</span>} />
          <Line k="Secrets" v={<span className="code">{t.secrets_profile} · {t.secrets_owner}</span>} />
          <Line k="Max execution" v={`${t.max_execution_seconds}s`} />
          <div className="code wrapCode muted" style={{ marginTop: 4 }}>
            {t.wasm_url}
          </div>
        </>
      )}
    </div>
  );
}
