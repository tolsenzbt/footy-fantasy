import { getStandings, type StandingRow } from "@/lib/standings/read";
import { db } from "@/db";
import { leagueMemberships } from "@/db/schema/league";
import { eq } from "drizzle-orm";
import { Card, CardContent } from "@/components/ui/card";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";
import { ScoreCell } from "@/components/primitives/ScoreCell";

type NameMap = Map<string, string>; // managerId → displayName

// 2 groups → 8-team → top-3 advance; 4 groups → 12/16-team → top-2 advance
function advanceCutoff(groupCount: number): number {
  return groupCount === 2 ? 3 : 2;
}

function GroupTable({
  groupLetter,
  managers,
  nameMap,
  cutoff,
}: {
  groupLetter: string;
  managers: StandingRow[];
  nameMap: NameMap;
  cutoff: number;
}) {
  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        {/* Group header */}
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
            Group {groupLetter}
          </h2>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[2rem_1fr_5rem_4rem_4rem] sm:grid-cols-[2rem_1fr_5rem_4rem_4rem_4rem] items-center px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-dim)] border-b border-border">
          <span>#</span>
          <span>Manager</span>
          <span className="text-center">W-L-D</span>
          <span className="text-right text-foreground/80">PF</span>
          <span className="text-right">PA</span>
          <span className="hidden sm:block text-right">Best</span>
        </div>

        {/* Manager rows */}
        {managers.map((m, i) => {
          const isAdvancing = m.rank <= cutoff;
          const isLastAdvancing = m.rank === cutoff;
          const displayName = nameMap.get(m.managerId) ?? "—";

          return (
            <div key={m.managerId}>
              <div
                className={`grid grid-cols-[2rem_1fr_5rem_4rem_4rem] sm:grid-cols-[2rem_1fr_5rem_4rem_4rem_4rem] items-center px-4 min-h-[44px] py-2 ${
                  isAdvancing ? "bg-background" : "bg-muted/30"
                }`}
              >
                {/* Rank */}
                <span className="tabular-nums text-sm font-medium text-[var(--text-dim)]">
                  {m.rank}
                </span>

                {/* Manager nameplate */}
                <ManagerNameplate displayName={displayName} size="sm" />

                {/* W-L-D */}
                <span className="tabular-nums text-xs text-center text-[var(--text-dim)]">
                  {m.wins}-{m.losses}-{m.draws}
                </span>

                {/* PF — primary stat, emphasized */}
                <div className="text-right">
                  <ScoreCell
                    value={m.pointsFor}
                    className="text-base font-black text-foreground"
                  />
                </div>

                {/* PA — secondary, dimmed */}
                <div className="text-right">
                  <ScoreCell
                    value={m.pointsAgainst}
                    className="text-sm font-medium text-[var(--text-dim)]"
                  />
                </div>

                {/* Highest single-matchday score — hidden on small mobile */}
                <div className="hidden sm:block text-right">
                  <ScoreCell
                    value={m.highestSingleScore}
                    className="text-sm font-medium text-[var(--text-dim)]"
                  />
                </div>
              </div>

              {/* Advance divider — after last advancing row */}
              {isLastAdvancing && i < managers.length - 1 && (
                <div className="flex items-center gap-2 px-4 py-0.5 bg-muted/20">
                  <div className="flex-1 border-t border-dashed border-border" />
                  <span className="text-[9px] font-semibold uppercase tracking-widest text-[var(--text-dim)]">
                    Advance line
                  </span>
                  <div className="flex-1 border-t border-dashed border-border" />
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default async function StandingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: leagueId } = await params;

  const [groups, memberships] = await Promise.all([
    getStandings(leagueId),
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

  const cutoff = advanceCutoff(groups.length);

  if (groups.length === 0) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <p className="text-sm text-[var(--text-dim)]">No standings data yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-4">

        {/* Header */}
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold tracking-tight">Standings</h1>
          <span className="text-xs text-[var(--text-dim)] font-medium uppercase tracking-widest">
            Ranked by PF
          </span>
        </div>

        {/* Groups grid: 2-col on md+, 1-col on mobile */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map((g) => (
            <GroupTable
              key={g.groupLetter}
              groupLetter={g.groupLetter}
              managers={g.managers}
              nameMap={nameMap}
              cutoff={cutoff}
            />
          ))}
        </div>

        {/* Legend */}
        <p className="text-[10px] text-[var(--text-dim)]">
          PF = points for (tiebreaker primary) · PA = points against · Best = highest single matchday
        </p>
      </div>
    </div>
  );
}
