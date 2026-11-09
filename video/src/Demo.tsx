import React from "react";
import { AbsoluteFill, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const C = {
  bg: "#fafaf9",
  panel: "#ffffff",
  fg: "#171717",
  sub: "#62625f",
  muted: "#949490",
  green: "#197856",
  red: "#bf514b",
  soft: "#f1f1ef",
};
const FONT = 'Inter, -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export type DemoProps = {
  repoUrl: string;
  testnetContract: string;
  testnetSteps: number;
};

/** Fade + rise in at `at` frames into the parent sequence. */
const Rise: React.FC<{ at?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at = 0, children, style }) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        ...style,
        opacity: interpolate(f, [at, at + 18], [0, 1], { ...clamp, easing: ease }),
        translate: interpolate(f, [at, at + 18], ["0px 28px", "0px 0px"], { ...clamp, easing: ease }),
      }}
    >
      {children}
    </div>
  );
};

const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 26, letterSpacing: "0.18em", textTransform: "uppercase", color: C.muted, fontWeight: 650 }}>{children}</div>
);

const Intro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.bg, justifyContent: "center", alignItems: "center", fontFamily: FONT, color: C.fg }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 36 }}>
        <Rise>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <div style={{ width: 92, height: 92, borderRadius: 999, border: `8px solid ${C.fg}`, background: `linear-gradient(${C.fg} 50%, transparent 50%)`, rotate: `${interpolate(f, [0, 60], [-90, 0], { ...clamp, easing: ease })}deg` }} />
            <div style={{ fontSize: 150, fontWeight: 640, letterSpacing: "-0.06em" }}>basis</div>
          </div>
        </Rise>
        <Rise at={14}>
          <div style={{ fontSize: 58, letterSpacing: "-0.03em", textAlign: "center", lineHeight: 1.2 }}>Leveraged prediction-market positions on NEAR</div>
        </Rise>
        <Rise at={30}>
          <div style={{ fontSize: 40, color: C.sub, textAlign: "center" }}>
            Loss capped at your margin. <span style={{ color: C.fg, fontWeight: 600 }}>Profit not capped.</span>
          </div>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

const Row: React.FC<{ at: number; label: string; value: string; color: string; note: string }> = ({ at, label, value, color, note }) => (
  <Rise at={at} style={{ display: "grid", gridTemplateColumns: "560px 300px 1fr", alignItems: "baseline", gap: 40, padding: "30px 44px", background: C.panel, borderRadius: 24 }}>
    <div style={{ fontSize: 40, color: C.sub }}>{label}</div>
    <div style={{ fontSize: 72, fontWeight: 600, color, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    <div style={{ fontSize: 34, color: C.sub }}>{note}</div>
  </Rise>
);

const Payoff: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, padding: "110px 150px", fontFamily: FONT, color: C.fg, gap: 34 }}>
    <Rise>
      <Eyebrow>The trade</Eyebrow>
      <div style={{ fontSize: 84, letterSpacing: "-0.05em", fontWeight: 480, marginTop: 14 }}>$100 margin, 5x YES at $0.50</div>
    </Rise>
    <div style={{ display: "flex", flexDirection: "column", gap: 22, marginTop: 20 }}>
      <Row at={40} label="Mark moves to $0.60" value="+$100" color={C.green} note="+100%, and the position stays open" />
      <Row at={95} label="YES resolves at $1.00" value="+$500" color={C.green} note="$600 paid out, 5x the margin" />
      <Row at={150} label="NO resolves at $0.00" value="-$100" color={C.red} note="never more than the margin" />
    </div>
    <Rise at={210}>
      <div style={{ fontSize: 40, color: C.sub, marginTop: 10 }}>
        So the vault must reserve <span style={{ color: C.fg, fontWeight: 650 }}>$500 of payout capacity</span>, not $100.
      </div>
    </Rise>
  </AbsoluteFill>
);

export const SHOTS: Array<{ file: string; title: string; body: string; focus?: [number, number]; zoom?: number; live?: boolean }> = [
  { file: "01-markets.png", title: "Every admitted market", body: "Crypto, sports, elections, macro, commodities. Categories are labels in a manifest, never code.", focus: [0.6, 0.55], zoom: 1.1 },
  { file: "04-trade-composer.png", title: "Executable prices", body: "Depth from a signed oracle mark. Fills walk the book for the real size.", focus: [0.45, 0.45], zoom: 1.3 },
  { file: "05-composer-payout-and-warnings.png", title: "The contract's own numbers", body: "Max loss $100. Profit $500. Payout $600. Fees and the fair-value premium up front.", focus: [0.97, 0.1], zoom: 2.0 },
  { file: "06-confirm-with-market-rules.png", title: "Rules before you sign", body: "Policy version and hash, windows, leverage cap, maintenance, resolution source.", focus: [0.5, 0.5], zoom: 1.3 },
  { file: "08-order-executed-position-open.png", title: "Commit, then execute", body: "A keeper fills the order with a mark observed after your commit. No last look.", focus: [0.97, 0.97], zoom: 1.9 },
  { file: "12-plus-100-percent-still-open.png", title: "+100% and still open", body: "No forced take-profit. Equity keeps its full upside until you close.", focus: [0.62, 0.45], zoom: 1.7 },
  { file: "13-vault.png", title: "The counterparty vault", body: "bLP share price, NAV, free versus reserved liquidity, insurance, withdrawal queue.", focus: [0.55, 0.45], zoom: 1.2 },
  { file: "15-risk-monitor.png", title: "Scenario risk, per event", body: "Trader P&L in every outcome, hedge P&L, payout reserve, stress loss against the cap.", focus: [0.6, 0.5], zoom: 1.3 },
  { file: "17-trade-close-only.png", title: "Policy changes without redeploys", body: "A guardian can only restrict: close-only, pause. Open positions keep their terms.", focus: [0.6, 0.35], zoom: 1.3 },
  { file: "19-settlement-payout.png", title: "Settled on the exact outcome", body: "Quorum, dispute window, then payout from the resolved payout vector.", focus: [0.62, 0.5], zoom: 1.7 },
  { file: "20-activity-audit-log.png", title: "Everything is on the audit log", body: "Sequenced contract events. Simulated venue fills are labeled as simulated.", focus: [0.55, 0.4], zoom: 1.3 },
  { file: "22-admin-admit-live-form.png", title: "Any live Polymarket market", body: "Admitted from live Polymarket data by a timelocked governance vote. No contract change.", focus: [0.55, 0.4], zoom: 1.3 , live: true },
  { file: "25-trade-live-polymarket-book.png", title: "The real order book", body: "Marks come from the live Polymarket CLOB. At a 23c entry, $100 of margin can win $770.", focus: [0.5, 0.3], zoom: 1.25 , live: true },
  { file: "26-hedging-after-hedged-trade.png", title: "The vault hedges with real shares", body: "Exact outcome shares, filled against the live book and unwound when the trade closes. Paper by default, real orders on opt-in.", focus: [0.5, 0.35], zoom: 1.2 , live: true },
  { file: "29-resolution-panel-live-observations.png", title: "Two sources settle it", body: "Polymarket's resolution API and the Conditional Tokens contract on Polygon, signed by different reporters.", focus: [0.5, 0.45], zoom: 1.3 , live: true },
  { file: "30-tee-panel.png", title: "Keys that live in a TEE", body: "Oracle and hedge-executor keys are generated inside Intel TDX enclaves and only sign what the program allows.", focus: [0.5, 0.45], zoom: 1.3 , live: true },
  { file: "31-positions-maintenance-ramp.png", title: "Losers exit before the jump", body: "Maintenance for losing positions ramps up before resolution. Winners are never touched.", focus: [0.6, 0.45], zoom: 1.4 , live: true },
];

export const SHOT_FRAMES = 130;

const Shot: React.FC<{ file: string; title: string; body: string; focus?: [number, number]; zoom?: number; live?: boolean }> = ({ file, title, body, focus = [0.5, 0.5], zoom = 1, live = false }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, color: C.fg }}>
      <div style={{ position: "absolute", left: 90, top: 150, width: 1140, height: 712, borderRadius: 26, overflow: "hidden", background: C.panel, boxShadow: "0 30px 80px rgba(0,0,0,0.10)" }}>
        <Img
          src={staticFile(file)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transformOrigin: `${focus[0] * 100}% ${focus[1] * 100}%`,
            scale: interpolate(f, [0, SHOT_FRAMES], [zoom, zoom * 1.08], clamp),
            opacity: interpolate(f, [0, 12], [0, 1], clamp),
          }}
        />
      </div>
      <div style={{ position: "absolute", left: 1290, top: 150, width: 540, height: 712, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 }}>
        <Rise at={6}>
          <div style={{ fontSize: 62, fontWeight: 560, letterSpacing: "-0.045em", lineHeight: 1.08 }}>{title}</div>
        </Rise>
        <Rise at={16}>
          <div style={{ fontSize: 36, color: C.sub, lineHeight: 1.35 }}>{body}</div>
        </Rise>
      </div>
      <div style={{ position: "absolute", left: 90, bottom: 80, fontSize: 26, color: C.muted }}>{live ? "Real app, real NEAR transactions. Live Polymarket data; hedges are paper fills against the live book." : "Real app, real NEAR transactions. Prices from a labeled mock venue."}</div>
    </AbsoluteFill>
  );
};

const Bullet: React.FC<{ at: number; head: string; body: string }> = ({ at, head, body }) => (
  <Rise at={at} style={{ display: "flex", gap: 30, alignItems: "baseline" }}>
    <div style={{ width: 16, height: 16, borderRadius: 99, background: C.fg, flex: "none", translate: "0px -6px" }} />
    <div>
      <div style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-0.03em" }}>{head}</div>
      <div style={{ fontSize: 34, color: C.sub, marginTop: 6 }}>{body}</div>
    </div>
  </Rise>
);

const Architecture: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, padding: "110px 150px", fontFamily: FONT, color: C.fg, gap: 40 }}>
    <Rise>
      <Eyebrow>Under the hood</Eyebrow>
      <div style={{ fontSize: 84, letterSpacing: "-0.05em", fontWeight: 480, marginTop: 14 }}>One contract, one balance sheet</div>
    </Rise>
    <div style={{ display: "flex", flexDirection: "column", gap: 34, marginTop: 10 }}>
      <Bullet at={30} head="Rust contract on NEAR" body="Registry, vault with the bLP token, margin engine, oracle verifier, insurance ledger." />
      <Bullet at={70} head="Reserve before you open" body="Worst-case payout per event scenario, capped at 2% of NAV per event and 10% overall." />
      <Bullet at={110} head="Fair-price gate" body="A naive 5x quote at $0.80 is refused: the loss floor is worth +$80 to the trader." />
      <Bullet at={150} head="Real Polymarket, end to end" body="Live books, real resolution, hedges through the official SDK with a TEE-held session key." />
    </div>
  </AbsoluteFill>
);

const Stat: React.FC<{ at: number; n: string; label: string }> = ({ at, n, label }) => (
  <Rise at={at} style={{ background: C.panel, borderRadius: 26, padding: "40px 44px", display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ fontSize: 110, fontWeight: 560, letterSpacing: "-0.06em" }}>{n}</div>
    <div style={{ fontSize: 34, color: C.sub, lineHeight: 1.3 }}>{label}</div>
  </Rise>
);

const Proof: React.FC<DemoProps> = ({ testnetSteps }) => (
  <AbsoluteFill style={{ background: C.bg, padding: "110px 150px", fontFamily: FONT, color: C.fg, gap: 44 }}>
    <Rise>
      <Eyebrow>Tested end to end</Eyebrow>
      <div style={{ fontSize: 84, letterSpacing: "-0.05em", fontWeight: 480, marginTop: 14 }}>Every spec scenario, on a real NEAR node</div>
    </Rise>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 26 }}>
      <Stat at={30} n="45" label="Rust tests: payoff math and both TEE programs" />
      <Stat at={50} n="24" label="contract tests on a nearcore sandbox" />
      <Stat at={70} n="15" label="service tests, 5 against live Polymarket" />
      <Stat at={90} n="65" label="web unit and Playwright tests" />
    </div>
    <Rise at={130}>
      <div style={{ fontSize: 40, color: C.sub }}>
        {testnetSteps > 0 ? (
          <>
            The spec suite passed on <span style={{ color: C.fg, fontWeight: 650 }}>NEAR testnet</span>, and a live Polymarket trade settled there.
          </>
        ) : (
          <>The same acceptance suite runs on NEAR testnet with one flag.</>
        )}
      </div>
    </Rise>
  </AbsoluteFill>
);

const Outro: React.FC<DemoProps> = ({ repoUrl }) => (
  <AbsoluteFill style={{ background: C.fg, justifyContent: "center", alignItems: "center", fontFamily: FONT, color: C.bg }}>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
      <Rise>
        <div style={{ fontSize: 120, fontWeight: 640, letterSpacing: "-0.06em" }}>basis</div>
      </Rise>
      <Rise at={14}>
        <div style={{ fontSize: 46 }}>{repoUrl.replace("https://", "")}</div>
      </Rise>
      <Rise at={28}>
        <div style={{ fontSize: 32, color: "#a8a8a4", textAlign: "center", lineHeight: 1.45 }}>
          Testnet and test funds only. Hedges are paper fills against live books until live mode is switched on.
          <br />
          Fee and risk parameters are provisional until the product owner signs off.
        </div>
      </Rise>
    </div>
  </AbsoluteFill>
);

export const SCENES = { intro: 150, payoff: 300, shots: SHOTS.length * SHOT_FRAMES, arch: 270, proof: 240, outro: 180 };
export const TOTAL = Object.values(SCENES).reduce((a, b) => a + b, 0);

export const BasisDemo: React.FC<DemoProps> = (props) => {
  const { fps } = useVideoConfig();
  let t = 0;
  const at = (n: number) => {
    const s = t;
    t += n;
    return s;
  };
  void fps;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Sequence name="Intro" from={at(SCENES.intro)} durationInFrames={SCENES.intro}>
        <Intro />
      </Sequence>
      <Sequence name="Payoff" from={at(SCENES.payoff)} durationInFrames={SCENES.payoff}>
        <Payoff />
      </Sequence>
      {SHOTS.map((s) => (
        <Sequence key={s.file} name={`Shot ${s.file}`} from={at(SHOT_FRAMES)} durationInFrames={SHOT_FRAMES}>
          <Shot {...s} />
        </Sequence>
      ))}
      <Sequence name="Architecture" from={at(SCENES.arch)} durationInFrames={SCENES.arch}>
        <Architecture />
      </Sequence>
      <Sequence name="Proof" from={at(SCENES.proof)} durationInFrames={SCENES.proof}>
        <Proof {...props} />
      </Sequence>
      <Sequence name="Outro" from={at(SCENES.outro)} durationInFrames={SCENES.outro}>
        <Outro {...props} />
      </Sequence>
    </AbsoluteFill>
  );
};
