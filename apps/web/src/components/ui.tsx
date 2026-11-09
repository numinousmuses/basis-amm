import { useState, type ReactNode } from "react";
import type { MarketState } from "@basis/sdk";
import { explainError, type ExplainedError } from "../lib/errors";
import { useApp } from "../lib/app";

export function Heading({ eyebrow = "Basis / Protocol", title, sub, right }: { eyebrow?: string; title: string; sub: ReactNode; right?: ReactNode }) {
  return (
    <div className="heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      {right}
    </div>
  );
}

export function Metric({ label, value, detail, testId }: { label: string; value: ReactNode; detail?: ReactNode; testId?: string }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value number" data-testid={testId}>
        {value}
      </div>
      <div className="detail">{detail}</div>
    </div>
  );
}

const STATE_LABEL: Record<MarketState, string> = {
  Unlisted: "Unlisted",
  PendingReview: "Pending review",
  Active: "Open",
  CloseOnly: "Close only",
  Suspended: "Suspended",
  Resolving: "Resolving",
  Settled: "Settled",
  Invalid: "Invalid",
};

/** Market access chip. `open` is the contract's effective-actions verdict, which already folds
 * in guardian flags, event windows and entry windows. */
export function StateChip({ state, open, closeOnly }: { state: MarketState; open: boolean; closeOnly?: boolean }) {
  let label = STATE_LABEL[state] ?? state;
  if (state === "Active" && !open) label = closeOnly ? "Close only" : "Restricted";
  const cls = state === "Active" && open ? "chip on" : state === "Settled" ? "chip" : "chip warn";
  return (
    <span className={cls} data-testid="state-chip">
      {label}
    </span>
  );
}

export function SimLabel({ text = "Simulated venue" }: { text?: string }) {
  return (
    <span className="chip sim" title="Prices and fills come from the deterministic mock venue, not a real market">
      {text}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error, onRetry }: { error: string | ExplainedError; onRetry?: () => void }) {
  const e = typeof error === "string" ? explainError(error) : error;
  return (
    <div className="errorBox" role="alert" data-testid="error-box" data-code={e.code}>
      <b>{e.title}</b>
      <div>{e.message}</div>
      {e.raw && e.raw !== e.message && <div className="code" style={{ marginTop: 6 }}>{e.raw}</div>}
      {onRetry && (
        <button className="mini" style={{ marginTop: 10 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="empty">{what}…</div>;
}

export function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

export function Toggle({ on, onChange, label, disabled, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} data-testid={testId}>
      <i />
    </button>
  );
}

export function Modal({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modalBack" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: "min(640px,100%)", maxHeight: "92vh", overflow: "auto" } : { maxHeight: "92vh", overflow: "auto" }} role="dialog">
        {children}
      </div>
    </div>
  );
}

export function Line({ k, v, testId }: { k: ReactNode; v: ReactNode; testId?: string }) {
  return (
    <div className="configLine">
      <span className="key">{k}</span>
      <b data-testid={testId}>{v}</b>
    </div>
  );
}

export function SumRow({ k, v, cls, testId }: { k: ReactNode; v: ReactNode; cls?: string; testId?: string }) {
  return (
    <div className="sumrow">
      <span>{k}</span>
      <strong className={cls} data-testid={testId}>
        {v}
      </strong>
    </div>
  );
}

/** SVG line/area chart. `series` values are plain numbers already scaled for display. */
export function LineChart({ series, color = "#333", height = 230, label, sub, yFormat }: { series: Array<{ x: number; y: number }>; color?: string; height?: number; label?: ReactNode; sub?: ReactNode; yFormat?: (y: number) => string }) {
  if (series.length < 2)
    return (
      <div className="chart" style={{ height, alignItems: "center", justifyContent: "center" }}>
        <span className="muted" style={{ fontSize: 12, width: "100%", textAlign: "center" }}>
          Not enough history yet
        </span>
      </div>
    );
  const xs = series.map((p) => p.x);
  const ys = series.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y1 - y0 < 1e-9) {
    y0 -= Math.abs(y0) * 0.01 + 0.01;
    y1 += Math.abs(y1) * 0.01 + 0.01;
  }
  const pad = (y1 - y0) * 0.12;
  y0 -= pad;
  y1 += pad;
  const W = 600;
  const H = 220;
  const px = (x: number) => ((x - x0) / (x1 - x0 || 1)) * W;
  const py = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const pts = series.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const id = `g${color.replace("#", "")}`;
  return (
    <div className="chart" style={{ height }} data-testid="line-chart">
      {label && (
        <div className="chartLabel">
          {label}
          {sub && <div className="chartSub">{sub}</div>}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop stopColor={color} stopOpacity=".17" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${id})`} />
        <polyline points={pts} stroke={color} strokeWidth="2.4" fill="none" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {yFormat && (
        <div className="chartAxis">
          <span>{yFormat(y1 - pad)}</span>
          <span>{yFormat(y0 + pad)}</span>
        </div>
      )}
    </div>
  );
}

/** Wrap a write: toast progress, map contract errors to plain English, refresh account views. */
export function useTx() {
  const { toast, bump } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ExplainedError | null>(null);
  async function run<T>(label: string, fn: () => Promise<T>, ok?: (v: T) => string | void): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      const v = await fn();
      const msg = ok?.(v);
      toast(msg || `${label}: confirmed`);
      bump();
      return v;
    } catch (e) {
      const ex = explainError(e);
      setError(ex);
      toast(`${label} failed: ${ex.title}`, "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  }
  return { run, busy, error, clearError: () => setError(null) };
}
