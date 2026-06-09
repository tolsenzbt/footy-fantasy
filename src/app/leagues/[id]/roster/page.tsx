import { getRoster, type RosterPlayer } from "@/lib/roster/read";
import { db } from "@/db";
import { leagueMemberships } from "@/db/schema/league";
import { and, eq } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PositionBadge } from "@/components/primitives/PositionBadge";
import { NationChip } from "@/components/primitives/NationChip";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";

// Demo manager for the dev league when no ?manager= param is provided.
const DEMO_MANAGER_ID = "36ddad76-fb1f-4b61-bad9-ef2f9b50ffc7";

const POSITION_LABELS: Record<string, string> = {
  GK: "Goalkeepers",
  DEF: "Defenders",
  MID: "Midfielders",
  FWD: "Forwards",
};

const ACQUIRED_LABELS: Record<RosterPlayer["acquiredVia"], string> = {
  initial_draft: "Drafted",
  redraft: "Redrafted",
  waiver: "Waiver",
  free_agent: "FA",
};

// ── Position section ──────────────────────────────────────────────────────────

function PositionSection({ position, players }: { position: string; players: RosterPlayer[] }) {
  if (players.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold text-foreground">
          {POSITION_LABELS[position] ?? position}{" "}
          <span className="text-[var(--text-dim)] font-normal">({players.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-0.5">
        {players.map((p) => (
          <div
            key={p.playerId}
            className="flex items-center gap-2 min-h-[44px] py-1"
          >
            <PositionBadge position={p.position} />
            <NationChip
              fifaCode={p.nationFifaCode}
              isoCode={p.nationIsoCode}
              name={p.nationName}
            />
            <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
              {p.playerName}
            </span>
            <span className="text-xs text-[var(--text-dim)] shrink-0">
              {ACQUIRED_LABELS[p.acquiredVia]}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function RosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ manager?: string }>;
}) {
  const { id: leagueId } = await params;
  const { manager } = await searchParams;
  const managerId = manager ?? DEMO_MANAGER_ID;

  // Page-level membership lookup for manager display name (noted in summary).
  const [membership] = await db
    .select({ displayName: leagueMemberships.displayName })
    .from(leagueMemberships)
    .where(
      and(
        eq(leagueMemberships.id, managerId),
        eq(leagueMemberships.leagueId, leagueId)
      )
    )
    .limit(1);

  const roster = await getRoster(leagueId, managerId);

  // Group players by position (getRoster returns them sorted GK→DEF→MID→FWD).
  const byPosition: Record<string, RosterPlayer[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of roster.players) {
    byPosition[p.position].push(p);
  }

  const total = roster.players.length;
  const displayName = membership?.displayName ?? "Manager";

  const empty = total === 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Roster</h1>
            <div className="mt-1">
              <ManagerNameplate displayName={displayName} size="sm" />
            </div>
          </div>
          {!empty && (
            <div className="text-right text-xs text-[var(--text-dim)] space-y-0.5 pt-1">
              <div className="font-medium text-foreground tabular-nums">{total} players</div>
              <div className="tabular-nums">
                {(["GK", "DEF", "MID", "FWD"] as const)
                  .filter((pos) => byPosition[pos].length > 0)
                  .map((pos) => `${byPosition[pos].length} ${pos}`)
                  .join(" · ")}
              </div>
            </div>
          )}
        </div>

        {/* ── Empty state ── */}
        {empty && (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm text-[var(--text-dim)]">
                {membership ? "This manager has no players on their roster yet." : "Manager not found."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Position sections ── */}
        {!empty && (
          <div className="space-y-3">
            {(["GK", "DEF", "MID", "FWD"] as const).map((pos) => (
              <PositionSection
                key={pos}
                position={pos}
                players={byPosition[pos]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
