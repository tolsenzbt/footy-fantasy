import { getBracket, type BracketMatchup } from "@/lib/bracket/read";
import { db } from "@/db";
import { leagueMemberships } from "@/db/schema/league";
import { eq } from "drizzle-orm";
import { Card, CardContent } from "@/components/ui/card";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";
import { ScoreCell } from "@/components/primitives/ScoreCell";
import { cn } from "@/lib/utils";

type NameMap = Map<string, string>;

// ── MatchupSlot ───────────────────────────────────────────────────────────────

function MatchupSlot({
  managerId,
  seedSource,
  score,
  nameMap,
  isWinner,
  isLoser,
}: {
  managerId: string | null;
  seedSource: string | null;
  score: string | null;
  nameMap: NameMap;
  isWinner: boolean;
  isLoser: boolean;
}) {
  const displayName = managerId ? (nameMap.get(managerId) ?? "?") : null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-3 min-h-[44px] py-1",
        isWinner && "bg-[var(--win)]/10",
        isLoser && "opacity-50",
      )}
    >
      {displayName ? (
        <ManagerNameplate displayName={displayName} size="sm" />
      ) : (
        <span className="inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-mono font-semibold bg-muted text-[var(--text-dim)] border border-border/50 min-w-[2rem] text-center">
          {seedSource ?? "TBD"}
        </span>
      )}

      {score !== null && (
        <ScoreCell
          value={score}
          variant={isWinner ? "win" : isLoser ? "loss" : "neutral"}
          className="text-sm"
        />
      )}
    </div>
  );
}

// ── MatchupCard ───────────────────────────────────────────────────────────────

function MatchupCard({
  matchup,
  nameMap,
}: {
  matchup: BracketMatchup;
  nameMap: NameMap;
}) {
  const homeWon =
    !!matchup.winnerManagerId &&
    matchup.winnerManagerId === matchup.homeManagerId;
  const awayWon =
    !!matchup.winnerManagerId &&
    matchup.winnerManagerId === matchup.awayManagerId;

  return (
    <Card className="w-full">
      <CardContent className="p-0 overflow-hidden">
        <MatchupSlot
          managerId={matchup.homeManagerId}
          seedSource={matchup.homeSeedSource}
          score={matchup.homeScore}
          nameMap={nameMap}
          isWinner={homeWon}
          isLoser={awayWon}
        />
        <div className="border-t border-border/40" />
        <MatchupSlot
          managerId={matchup.awayManagerId}
          seedSource={matchup.awaySeedSource}
          score={matchup.awayScore}
          nameMap={nameMap}
          isWinner={awayWon}
          isLoser={homeWon}
        />
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function BracketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: leagueId } = await params;

  const [bracket, memberships] = await Promise.all([
    getBracket(leagueId),
    db
      .select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, leagueId)),
  ]);

  const nameMap: NameMap = new Map(
    memberships
      .filter((m): m is typeof m & { displayName: string } => m.displayName !== null)
      .map((m) => [m.id, m.displayName]),
  );

  const { qf, sf, final } = bracket;

  if (qf.length === 0 && sf.length === 0 && final.length === 0) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <h1 className="text-xl font-bold tracking-tight mb-4">Bracket</h1>
          <p className="text-sm text-[var(--text-dim)]">
            Knockout bracket not yet generated.
          </p>
        </div>
      </div>
    );
  }

  const showQF = qf.length > 0;
  const showSF = sf.length > 0;
  const showFinal = final.length > 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-4">

        <h1 className="text-xl font-bold tracking-tight">Bracket</h1>

        {/* Mobile: horizontal scroll preserves the bracket advancement flow.
            Desktop: full three-column layout. */}
        <div className="overflow-x-auto -mx-4 px-4 pb-4">
          <div style={{ minWidth: "580px" }}>

            {/* Round labels row — sits above the bracket, same column widths */}
            <div className="flex mb-0">
              {showQF && (
                <div className="flex-1 text-center pb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-dim)]">
                  Quarterfinals
                </div>
              )}
              {showQF && showSF && <div className="w-6 shrink-0" />}
              {showSF && (
                <div className="flex-1 text-center pb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-dim)]">
                  Semifinals
                </div>
              )}
              {showSF && showFinal && <div className="w-6 shrink-0" />}
              {showFinal && (
                <div className="flex-1 text-center pb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-dim)]">
                  Final
                </div>
              )}
            </div>

            {/* Bracket body — fixed height so all columns stretch equally.
                flex-1 children divide the height proportionally, which keeps
                SF cards centered between their two QF pairs. */}
            <div className="flex" style={{ height: "520px" }}>

              {/* QF: 4 flex-1 slots */}
              {showQF && (
                <div className="flex-1 flex flex-col min-w-[160px]">
                  {qf.map((m) => (
                    <div key={m.matchupId} className="flex-1 flex items-center py-1.5">
                      <MatchupCard matchup={m} nameMap={nameMap} />
                    </div>
                  ))}
                </div>
              )}

              {/* QF→SF connector: N pairs = sf.length groups, each group
                  has 2 flex-1 cells with border-r (vertical) + border-b/t
                  (horizontal branch at group midpoint = SF card center). */}
              {showQF && showSF && (
                <div className="w-6 shrink-0 flex flex-col">
                  {Array.from({ length: sf.length }).map((_, i) => (
                    <div key={i} className="flex-1 flex flex-col">
                      <div className="flex-1 border-r-2 border-b-2 border-border/50" />
                      <div className="flex-1 border-r-2 border-t-2 border-border/50" />
                    </div>
                  ))}
                </div>
              )}

              {/* SF: 2 flex-1 slots */}
              {showSF && (
                <div className="flex-1 flex flex-col min-w-[160px]">
                  {sf.map((m) => (
                    <div key={m.matchupId} className="flex-1 flex items-center py-1.5">
                      <MatchupCard matchup={m} nameMap={nameMap} />
                    </div>
                  ))}
                </div>
              )}

              {/* SF→Final connector: 1 group = 2 flex-1 cells */}
              {showSF && showFinal && (
                <div className="w-6 shrink-0 flex flex-col">
                  <div className="flex-1 border-r-2 border-b-2 border-border/50" />
                  <div className="flex-1 border-r-2 border-t-2 border-border/50" />
                </div>
              )}

              {/* Final: centered in the column */}
              {showFinal && (
                <div className="flex-1 flex flex-col justify-center min-w-[160px]">
                  {final.map((m) => (
                    <div key={m.matchupId} className="py-1.5">
                      <MatchupCard matchup={m} nameMap={nameMap} />
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
