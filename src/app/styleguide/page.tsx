import { Fragment } from "react";
import {
  Panel,
  StatRow,
  PositionBadge,
  NationChip,
  ScoreCell,
  LivePill,
  ManagerNameplate,
} from "@/components/primitives";

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="space-y-4">
    <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)] border-b border-border pb-2">
      {title}
    </h2>
    {children}
  </section>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-3">{children}</div>
);

export default function StyleguidePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-10 space-y-12">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Design System Styleguide</h1>
          <p className="mt-1 text-sm text-[var(--text-dim)]">
            Footy Fantasy · dark-only · Manrope · Tailwind v4
          </p>
        </header>

        {/* ── Color tokens ── */}
        <Section title="Color tokens">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { name: "--background", hex: "#0d1117" },
              { name: "--card (surface)", hex: "#161b22" },
              { name: "--surface-2", hex: "#21262d" },
              { name: "--border", hex: "#30363d" },
              { name: "--foreground (text)", hex: "#e6edf3" },
              { name: "--text-dim", hex: "#8b949e" },
              { name: "--primary (accent)", hex: "#3b82f6" },
              { name: "--live", hex: "#ef4444" },
              { name: "--win", hex: "#22c55e" },
              { name: "--loss", hex: "#9ca3af" },
            ].map(({ name, hex }) => (
              <div key={name} className="flex items-center gap-2">
                <div
                  className="size-6 rounded border border-border flex-shrink-0"
                  style={{ background: hex }}
                />
                <div className="min-w-0">
                  <div className="text-xs font-mono text-foreground truncate">{hex}</div>
                  <div className="text-[10px] text-[var(--text-dim)] truncate">{name}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Typography ── */}
        <Section title="Type scale">
          <div className="space-y-3">
            <div className="text-3xl font-bold">3xl / Bold — heading</div>
            <div className="text-2xl font-semibold">2xl / Semibold — page title</div>
            <div className="text-xl font-semibold">xl / Semibold — section</div>
            <div className="text-lg font-medium">lg / Medium — subheading</div>
            <div className="text-base">base / Regular — body</div>
            <div className="text-sm text-[var(--text-dim)]">sm / Regular — secondary</div>
            <div className="text-xs text-[var(--text-dim)]">xs / Regular — metadata</div>
            <div className="text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
              xs / Semibold / uppercase / wide-tracking — section label
            </div>
            <div className="tabular-nums text-2xl font-semibold">
              Tabular numerals: 1,234.56 pts · 0 1 2 3 4 5 6 7 8 9
            </div>
          </div>
        </Section>

        {/* ── Panel ── */}
        <Section title="Panel / Card">
          <div className="grid gap-3 sm:grid-cols-3">
            <Panel padding="sm">
              <p className="text-sm text-[var(--text-dim)]">padding=sm</p>
              <p className="text-foreground">Surface panel</p>
            </Panel>
            <Panel padding="md">
              <p className="text-sm text-[var(--text-dim)]">padding=md (default)</p>
              <p className="text-foreground">Surface panel</p>
            </Panel>
            <Panel padding="lg">
              <p className="text-sm text-[var(--text-dim)]">padding=lg</p>
              <p className="text-foreground">Surface panel</p>
            </Panel>
            <Panel elevated padding="md" className="sm:col-span-3">
              <p className="text-sm text-[var(--text-dim)]">elevated=true (surface-2 bg)</p>
              <p className="text-foreground">Elevated panel — used for nested content</p>
            </Panel>
          </div>
        </Section>

        {/* ── StatRow ── */}
        <Section title="StatRow">
          <Panel>
            <StatRow label="Points For" value="134.50" />
            <StatRow label="Points Against" value="118.25" />
            <StatRow label="Win / Loss / Draw" value="2 / 1 / 0" />
            <StatRow label="Highest Matchday" value="56.00" />
          </Panel>
        </Section>

        {/* ── PositionBadge ── */}
        <Section title="PositionBadge">
          <Row>
            <PositionBadge position="GK" />
            <PositionBadge position="DEF" />
            <PositionBadge position="MID" />
            <PositionBadge position="FWD" />
          </Row>
          <Panel elevated>
            <div className="flex flex-wrap gap-2">
              {(["GK", "DEF", "MID", "FWD"] as const).map((pos) => (
                <div key={pos} className="flex items-center gap-2">
                  <PositionBadge position={pos} />
                  <span className="text-sm text-[var(--text-dim)]">{pos}</span>
                </div>
              ))}
            </div>
          </Panel>
        </Section>

        {/* ── NationChip ── */}
        <Section title="NationChip">
          <Row>
            {/* Known FIFA codes with ISO mapping */}
            <NationChip fifaCode="GER" name="Germany" />
            <NationChip fifaCode="FRA" name="France" />
            <NationChip fifaCode="USA" name="United States" />
            <NationChip fifaCode="BRA" name="Brazil" />
            <NationChip fifaCode="ARG" name="Argentina" />
            <NationChip fifaCode="JPN" name="Japan" />
            <NationChip fifaCode="MAR" name="Morocco" />
            <NationChip fifaCode="NED" name="Netherlands" />
            <NationChip fifaCode="ENG" name="England" />
            <NationChip fifaCode="SUI" name="Switzerland" />
            <NationChip fifaCode="KOR" name="South Korea" />
            <NationChip fifaCode="MEX" name="Mexico" />
          </Row>
          <p className="text-xs text-[var(--text-dim)] mt-2">Fallback (no ISO mapping):</p>
          <Row>
            {/* Codes not in the map — graceful fallback, shows code only */}
            <NationChip fifaCode="ZZZ" name="Unknown Nation" />
            <NationChip fifaCode="XYZ" />
          </Row>
        </Section>

        {/* ── ScoreCell ── */}
        <Section title="ScoreCell">
          <Row>
            <span className="text-xs text-[var(--text-dim)]">neutral:</span>
            <ScoreCell value="87.50" />
            <span className="text-xs text-[var(--text-dim)]">win:</span>
            <ScoreCell value="87.50" variant="win" />
            <span className="text-xs text-[var(--text-dim)]">loss:</span>
            <ScoreCell value="72.25" variant="loss" />
            <span className="text-xs text-[var(--text-dim)]">null:</span>
            <ScoreCell value={null} />
          </Row>
          {/* Alignment demo */}
          <Panel elevated>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="text-[var(--text-dim)]">Manager</div>
              <div className="text-[var(--text-dim)] text-right">Score</div>
              <div className="text-[var(--text-dim)] text-right">Result</div>
              {[
                { name: "Alice", score: "134.50", win: true },
                { name: "Bob", score: "98.25", win: false },
                { name: "Carlos", score: "112.00", win: true },
              ].map(({ name, score, win }) => (
                <Fragment key={name}>
                  <div className="text-foreground">{name}</div>
                  <div className="text-right">
                    <ScoreCell value={score} variant={win ? "win" : "loss"} />
                  </div>
                  <div className="text-right text-xs text-[var(--text-dim)]">
                    {win ? "W" : "L"}
                  </div>
                </Fragment>
              ))}
            </div>
          </Panel>
        </Section>

        {/* ── LivePill ── */}
        <Section title="LivePill">
          <Row>
            <LivePill />
            <LivePill label="PROVISIONAL" />
            <LivePill label="UPDATING" />
          </Row>
          <Panel elevated className="flex items-center justify-between">
            <span className="text-sm text-foreground">Group MD1 · Matchup 3</span>
            <LivePill />
          </Panel>
        </Section>

        {/* ── ManagerNameplate ── */}
        <Section title="ManagerNameplate">
          <Row>
            <ManagerNameplate displayName="Alice Johnson" size="sm" />
            <ManagerNameplate displayName="Bob Smith" size="md" />
            <ManagerNameplate displayName="Carlos Ruiz" size="lg" />
          </Row>
          <Row>
            <ManagerNameplate displayName="Single" size="md" />
            <ManagerNameplate displayName="A" size="md" />
            <ManagerNameplate displayName="Very Long Display Name Here" size="md" />
          </Row>
          <Panel elevated className="space-y-3">
            {["Alice Johnson", "Bob Smith", "Carlos Ruiz", "Diana Prince"].map((name) => (
              <div key={name} className="flex items-center justify-between">
                <ManagerNameplate displayName={name} size="sm" />
                <ScoreCell value={Math.floor(Math.random() * 50 + 80) + ".50"} variant="neutral" />
              </div>
            ))}
          </Panel>
        </Section>

        {/* ── Composite demo ── */}
        <Section title="Composite: Matchup card">
          <Panel>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
                Group MD1 · Match 1
              </span>
              <LivePill />
            </div>
            <div className="grid grid-cols-3 items-center gap-2">
              <div className="space-y-1">
                <ManagerNameplate displayName="Alice Johnson" size="sm" />
                <div className="flex flex-wrap gap-1 mt-1">
                  <PositionBadge position="GK" />
                  <PositionBadge position="DEF" />
                  <NationChip fifaCode="GER" name="Germany" />
                </div>
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-3">
                  <ScoreCell value="67.50" variant="win" className="text-2xl" />
                  <span className="text-[var(--text-dim)]">–</span>
                  <ScoreCell value="54.25" variant="loss" className="text-2xl" />
                </div>
                <span className="text-xs text-[var(--text-dim)]">provisional</span>
              </div>
              <div className="space-y-1 text-right">
                <ManagerNameplate displayName="Bob Smith" size="sm" className="justify-end" />
                <div className="flex flex-wrap gap-1 mt-1 justify-end">
                  <NationChip fifaCode="BRA" name="Brazil" />
                  <PositionBadge position="FWD" />
                </div>
              </div>
            </div>
          </Panel>
        </Section>

        {/* ── Touch targets note ── */}
        <Section title="Touch targets (44px min)">
          <Panel elevated>
            <p className="text-sm text-[var(--text-dim)]">
              All interactive elements must meet the 44px minimum. Verify in DevTools
              device mode. Hover enhancements (e.g. hover:bg-*) are additive only —
              tap on mobile must work without hover.
            </p>
            <div className="mt-3 flex gap-3">
              <button className="min-h-[44px] min-w-[44px] px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium">
                Primary action
              </button>
              <button className="min-h-[44px] px-4 rounded-lg border border-border text-foreground text-sm font-medium hover:bg-[var(--surface-2)]">
                Secondary
              </button>
            </div>
          </Panel>
        </Section>
      </div>
    </div>
  );
}
