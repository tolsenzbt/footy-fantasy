import Link from "next/link";
import { getLineup, type LineupSlotDetail } from "@/lib/lineup/read";
import { db } from "@/db";
import { leagueMemberships } from "@/db/schema/league";
import { fantasyRounds } from "@/db/schema/schedule";
import { players as playersTable, nations } from "@/db/schema/tournament";
import { and, eq, inArray } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PositionBadge } from "@/components/primitives/PositionBadge";
import { NationChip } from "@/components/primitives/NationChip";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";

const DEMO_MANAGER_ID = "36ddad76-fb1f-4b61-bad9-ef2f9b50ffc7";
const DEFAULT_ROUND = "group_md1";

const POSITION_ORDER = ["GK", "DEF", "MID", "FWD"] as const;

const ROUND_LABELS: Record<string, string> = {
  group_md1: "MD1",
  group_md2: "MD2",
  group_md3: "MD3",
  qf: "QF",
  sf: "SF",
  final: "Final",
};

type NationInfo = { fifaCode: string; isoCode: string | null; nationName: string };
type NationMap = Map<string, NationInfo>;

// ── Player row ────────────────────────────────────────────────────────────────

function PlayerRow({
  slot,
  isCaptain,
  isVC,
  nation,
  dimmed,
}: {
  slot: LineupSlotDetail;
  isCaptain: boolean;
  isVC: boolean;
  nation: NationInfo | undefined;
  dimmed?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 min-h-[44px] py-1 ${dimmed ? "opacity-55" : ""}`}>
      <PositionBadge position={slot.position} />
      {nation ? (
        <NationChip fifaCode={nation.fifaCode} isoCode={nation.isoCode} name={nation.nationName} />
      ) : null}
      <span
        className={`flex-1 min-w-0 text-sm truncate ${
          isCaptain ? "font-semibold text-foreground" : "text-foreground"
        }`}
      >
        {slot.playerName}
      </span>
      {isCaptain && (
        <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 shrink-0 min-w-[1.75rem]">
          C
        </span>
      )}
      {isVC && (
        <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-semibold bg-zinc-600/20 text-zinc-400 border border-zinc-600/30 shrink-0 min-w-[1.75rem]">
          VC
        </span>
      )}
      {slot.lockedAt && (
        <span
          className="text-[10px] text-[var(--text-dim)] shrink-0"
          title={`Locked ${slot.lockedAt.toISOString()}`}
          aria-label="locked"
        >
          🔒
        </span>
      )}
    </div>
  );
}

// ── Starters panel ────────────────────────────────────────────────────────────

function StarterPanel({
  slots,
  captainId,
  vcId,
  nationMap,
}: {
  slots: LineupSlotDetail[];
  captainId: string | null;
  vcId: string | null;
  nationMap: NationMap;
}) {
  const starters = slots.filter((s) => s.slotType === "starter");
  const byPos = POSITION_ORDER.map((pos) => ({
    pos,
    players: starters.filter((s) => s.position === pos),
  }));

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold text-foreground">
          Starting XI{" "}
          <span className="text-[var(--text-dim)] font-normal">({starters.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-0">
        {byPos.map(({ pos, players }) =>
          players.length === 0 ? null : (
            <div key={pos}>
              <div className="text-[10px] font-semibold text-[var(--text-dim)] uppercase tracking-widest pt-2 pb-0.5">
                {pos}
              </div>
              {players.map((slot) => (
                <PlayerRow
                  key={slot.playerId}
                  slot={slot}
                  isCaptain={slot.playerId === captainId}
                  isVC={slot.playerId === vcId}
                  nation={nationMap.get(slot.playerId)}
                />
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ── Bench panel ───────────────────────────────────────────────────────────────

function BenchPanel({
  slots,
  nationMap,
}: {
  slots: LineupSlotDetail[];
  nationMap: NationMap;
}) {
  const bench = slots.filter((s) => s.slotType === "bench");

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold text-[var(--text-dim)]">
          Bench <span className="font-normal">({bench.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-0">
        {bench.map((slot) => (
          <PlayerRow
            key={slot.playerId}
            slot={slot}
            isCaptain={false}
            isVC={false}
            nation={nationMap.get(slot.playerId)}
            dimmed
          />
        ))}
      </CardContent>
    </Card>
  );
}

// ── Round selector ────────────────────────────────────────────────────────────

function RoundSelector({
  rounds,
  currentRoundId,
  leagueId,
  managerId,
}: {
  rounds: { id: string; round: string }[];
  currentRoundId: string;
  leagueId: string;
  managerId: string;
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {rounds.map((r) => {
        const label = ROUND_LABELS[r.round] ?? r.round;
        const active = r.id === currentRoundId;
        return (
          <Link
            key={r.id}
            href={`/leagues/${leagueId}/lineup?manager=${managerId}&round=${r.id}`}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "bg-muted text-[var(--text-dim)] hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function LineupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ manager?: string; round?: string }>;
}) {
  const { id: leagueId } = await params;
  const { manager, round } = await searchParams;
  const managerId = manager ?? DEMO_MANAGER_ID;

  // Page-level lookups: membership + available rounds (in parallel)
  const [membershipRows, allRounds] = await Promise.all([
    db
      .select({ displayName: leagueMemberships.displayName })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.id, managerId),
          eq(leagueMemberships.leagueId, leagueId)
        )
      )
      .limit(1),
    db
      .select({ id: fantasyRounds.id, round: fantasyRounds.round })
      .from(fantasyRounds)
      .where(eq(fantasyRounds.leagueId, leagueId)),
  ]);

  const membership = membershipRows[0];

  // Resolve round: ?round= param → default to group_md1 → first available
  const defaultRoundRow = allRounds.find((r) => r.round === DEFAULT_ROUND) ?? allRounds[0];
  const roundId = round ?? defaultRoundRow?.id;

  if (!roundId) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-4xl px-4 py-6">
          <p className="text-sm text-[var(--text-dim)]">No rounds found for this league.</p>
        </div>
      </div>
    );
  }

  const lineup = await getLineup(leagueId, managerId, roundId);

  // Batch-fetch nation data for all players in the lineup (page-level, not render path)
  let nationMap: NationMap = new Map();
  if (lineup && lineup.slots.length > 0) {
    const playerIds = lineup.slots.map((s) => s.playerId);
    const nationRows = await db
      .select({
        playerId: playersTable.id,
        fifaCode: nations.fifaCode,
        isoCode: nations.isoCode,
        nationName: nations.name,
      })
      .from(playersTable)
      .innerJoin(nations, eq(playersTable.nationId, nations.id))
      .where(inArray(playersTable.id, playerIds));
    nationMap = new Map(
      nationRows.map((r) => [
        r.playerId,
        { fifaCode: r.fifaCode, isoCode: r.isoCode, nationName: r.nationName },
      ])
    );
  }

  const displayName = membership?.displayName ?? "Manager";
  const currentRoundRow = allRounds.find((r) => r.id === roundId);
  const currentRoundLabel = currentRoundRow
    ? (ROUND_LABELS[currentRoundRow.round] ?? currentRoundRow.round)
    : "";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-4 py-6 space-y-4">

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Lineup</h1>
            <div className="mt-1">
              <ManagerNameplate displayName={displayName} size="sm" />
            </div>
          </div>
          {lineup && (
            <div className="flex flex-col items-end gap-0.5 pt-0.5">
              <span className="text-3xl font-black tabular-nums text-foreground tracking-tight leading-none">
                {lineup.formation}
              </span>
              <span className="text-xs text-[var(--text-dim)]">{currentRoundLabel}</span>
            </div>
          )}
        </div>

        {/* ── Round selector ── */}
        {allRounds.length > 0 && (
          <RoundSelector
            rounds={allRounds}
            currentRoundId={roundId}
            leagueId={leagueId}
            managerId={managerId}
          />
        )}

        {/* ── Empty state ── */}
        {!lineup && (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm text-[var(--text-dim)]">
                {membership
                  ? "No lineup has been set for this round."
                  : "Manager not found."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Lineup: Starting XI + Bench ── */}
        {lineup && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4 items-start">
            <StarterPanel
              slots={lineup.slots}
              captainId={lineup.captainPlayerId}
              vcId={lineup.vcPlayerId}
              nationMap={nationMap}
            />
            <BenchPanel slots={lineup.slots} nationMap={nationMap} />
          </div>
        )}

        {/* ── Fallback notice ── */}
        {lineup?.isFallback && (
          <p className="text-xs text-[var(--text-dim)] text-center">
            Showing lineup carried forward from {ROUND_LABELS[lineup.fallbackRound ?? ""] ?? lineup.fallbackRound}.
          </p>
        )}
      </div>
    </div>
  );
}
