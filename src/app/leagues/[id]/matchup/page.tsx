import Link from "next/link";
import { getMatchupsForRound, type MatchupDetail, type ManagerMatchScore, type PlayerMatchDetail } from "@/lib/matchups/read";
import { db } from "@/db";
import { leagueMemberships } from "@/db/schema/league";
import { fantasyRounds } from "@/db/schema/schedule";
import { players as playersTable, nations } from "@/db/schema/tournament";
import { eq, inArray } from "drizzle-orm";
import { Card, CardContent } from "@/components/ui/card";
import { PositionBadge } from "@/components/primitives/PositionBadge";
import { NationChip } from "@/components/primitives/NationChip";
import { ScoreCell } from "@/components/primitives/ScoreCell";
import { LivePill } from "@/components/primitives/LivePill";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";

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
type NameMap = Map<string, string>; // managerId → displayName

// ── Side variant logic ────────────────────────────────────────────────────────

function getSideVariant(
  managerId: string,
  ownTotal: number,
  opponentTotal: number,
  winnerManagerId: string | null,
): { scoreVariant: "win" | "loss" | "neutral"; dim: boolean } {
  if (winnerManagerId) {
    const won = winnerManagerId === managerId;
    return { scoreVariant: won ? "win" : "loss", dim: !won };
  }
  if (ownTotal > opponentTotal) return { scoreVariant: "win", dim: false };
  if (ownTotal < opponentTotal) return { scoreVariant: "neutral", dim: true };
  return { scoreVariant: "neutral", dim: false };
}

// ── Player score row ──────────────────────────────────────────────────────────

function PlayerScoreRow({
  player,
  nation,
}: {
  player: PlayerMatchDetail;
  nation: NationInfo | undefined;
}) {
  return (
    <div className="flex items-center gap-2 min-h-[44px] py-1">
      <PositionBadge position={player.position} />
      {nation ? (
        <NationChip fifaCode={nation.fifaCode} isoCode={nation.isoCode} name={nation.nationName} />
      ) : null}
      <span
        className={`flex-1 min-w-0 text-sm truncate ${
          player.isCaptain ? "font-semibold text-foreground" : "text-foreground"
        }`}
      >
        {player.playerName}
      </span>
      {player.isCaptain && (
        <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 shrink-0">
          C
        </span>
      )}
      {player.isViceCaptain && player.multiplier === 2 && (
        <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-semibold bg-zinc-600/20 text-zinc-400 border border-zinc-600/30 shrink-0">
          VC★
        </span>
      )}
      {player.isViceCaptain && player.multiplier !== 2 && (
        <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-semibold bg-zinc-600/20 text-zinc-400 border border-zinc-600/30 shrink-0">
          VC
        </span>
      )}
      <ScoreCell
        value={player.finalPoints % 1 === 0 ? player.finalPoints : player.finalPoints.toFixed(1)}
        className="text-sm w-8 text-right"
      />
    </div>
  );
}

// ── Manager side ─────────────────────────────────────────────────────────────

function ManagerSide({
  score,
  displayName,
  nationMap,
  winnerManagerId,
  opponentTotal,
}: {
  score: ManagerMatchScore;
  displayName: string;
  nationMap: NationMap;
  winnerManagerId: string | null;
  opponentTotal: number;
}) {
  const { scoreVariant, dim } = getSideVariant(
    score.managerId,
    score.total,
    opponentTotal,
    winnerManagerId,
  );

  const byPos = POSITION_ORDER.map((pos) => ({
    pos,
    players: score.players.filter((p) => p.position === pos),
  }));

  return (
    <div className={dim ? "opacity-60" : ""}>
      <Card>
        <CardContent className="px-4 pb-4 pt-4">
          {/* Nameplate + total score */}
          <div className="flex items-center justify-between gap-3 mb-4">
            <ManagerNameplate displayName={displayName} size="sm" />
            <ScoreCell
              value={score.total % 1 === 0 ? score.total : score.total.toFixed(1)}
              variant={scoreVariant}
              className="text-3xl font-black"
            />
          </div>

          {/* Players by position */}
          {byPos.map(({ pos, players }) =>
            players.length === 0 ? null : (
              <div key={pos}>
                <div className="text-[10px] font-semibold text-[var(--text-dim)] uppercase tracking-widest pt-2 pb-0.5">
                  {pos}
                </div>
                {players.map((p) => (
                  <PlayerScoreRow
                    key={p.playerId}
                    player={p}
                    nation={nationMap.get(p.playerId)}
                  />
                ))}
              </div>
            )
          )}

          {score.players.length === 0 && (
            <p className="text-sm text-[var(--text-dim)] py-2">No lineup set.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Round selector ────────────────────────────────────────────────────────────

function RoundSelector({
  rounds,
  currentRoundId,
  leagueId,
}: {
  rounds: { id: string; round: string }[];
  currentRoundId: string;
  leagueId: string;
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {rounds.map((r) => {
        const label = ROUND_LABELS[r.round] ?? r.round;
        const active = r.id === currentRoundId;
        return (
          <Link
            key={r.id}
            href={`/leagues/${leagueId}/matchup?round=${r.id}`}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors min-h-[44px] flex items-center ${
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

// ── Matchup selector ──────────────────────────────────────────────────────────

function MatchupSelector({
  matchups,
  nameMap,
  currentMatchupId,
  leagueId,
  roundId,
}: {
  matchups: MatchupDetail[];
  nameMap: NameMap;
  currentMatchupId: string;
  leagueId: string;
  roundId: string;
}) {
  const nonBye = matchups.filter((m) => m.awaySeedSource !== "BYE");
  if (nonBye.length <= 1) return null;

  return (
    <div className="flex gap-1.5 flex-wrap">
      {nonBye.map((m) => {
        const homeName = m.home ? (nameMap.get(m.home.managerId) ?? "?") : "?";
        const awayName = m.away ? (nameMap.get(m.away.managerId) ?? "?") : "?";
        const active = m.matchupId === currentMatchupId;
        const label = `M${m.matchIndex + 1}`;
        return (
          <Link
            key={m.matchupId}
            href={`/leagues/${leagueId}/matchup?round=${roundId}&matchup=${m.matchupId}`}
            title={`${homeName} vs ${awayName}`}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors min-h-[44px] flex items-center ${
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

export default async function MatchupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ round?: string; matchup?: string }>;
}) {
  const { id: leagueId } = await params;
  const { round, matchup: matchupParam } = await searchParams;

  // Fetch rounds + all memberships in parallel
  const [allRounds, allMemberships] = await Promise.all([
    db
      .select({ id: fantasyRounds.id, round: fantasyRounds.round })
      .from(fantasyRounds)
      .where(eq(fantasyRounds.leagueId, leagueId)),
    db
      .select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, leagueId)),
  ]);

  const nameMap: NameMap = new Map(
    allMemberships
      .filter((m): m is typeof m & { displayName: string } => m.displayName !== null)
      .map((m) => [m.id, m.displayName]),
  );

  // Resolve round
  const defaultRoundRow = allRounds.find((r) => r.round === DEFAULT_ROUND) ?? allRounds[0];
  const roundId = round ?? defaultRoundRow?.id;

  if (!roundId) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <p className="text-sm text-[var(--text-dim)]">No rounds found for this league.</p>
        </div>
      </div>
    );
  }

  // Fetch all matchups for the round
  const allMatchups = await getMatchupsForRound(leagueId, roundId);
  const nonBye = allMatchups.filter((m) => m.awaySeedSource !== "BYE");

  if (nonBye.length === 0) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-5xl px-4 py-6 space-y-4">
          <h1 className="text-xl font-bold tracking-tight">Matchup</h1>
          <RoundSelector rounds={allRounds} currentRoundId={roundId} leagueId={leagueId} />
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm text-[var(--text-dim)]">No matchups for this round.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Select matchup
  const selectedMatchup =
    nonBye.find((m) => m.matchupId === matchupParam) ?? nonBye[0];

  const { isLive, winnerManagerId, home, away } = selectedMatchup;

  // Page-level nation join for players in the selected matchup
  const allPlayerIds = [
    ...(home?.players ?? []),
    ...(away?.players ?? []),
  ].map((p) => p.playerId);

  let nationMap: NationMap = new Map();
  if (allPlayerIds.length > 0) {
    const nationRows = await db
      .select({
        playerId: playersTable.id,
        fifaCode: nations.fifaCode,
        isoCode: nations.isoCode,
        nationName: nations.name,
      })
      .from(playersTable)
      .innerJoin(nations, eq(playersTable.nationId, nations.id))
      .where(inArray(playersTable.id, allPlayerIds));
    nationMap = new Map(
      nationRows.map((r) => [
        r.playerId,
        { fifaCode: r.fifaCode, isoCode: r.isoCode, nationName: r.nationName },
      ]),
    );
  }

  const currentRoundRow = allRounds.find((r) => r.id === roundId);
  const roundLabel = currentRoundRow
    ? (ROUND_LABELS[currentRoundRow.round] ?? currentRoundRow.round)
    : "";

  const homeName = home ? (nameMap.get(home.managerId) ?? "Home") : "Home";
  const awayName = away ? (nameMap.get(away.managerId) ?? "Away") : "Away";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-4">

        {/* ── Header ── */}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold tracking-tight">Matchup</h1>
          <span className="text-sm text-[var(--text-dim)]">{roundLabel}</span>
          {isLive && <LivePill />}
        </div>

        {/* ── Round selector ── */}
        {allRounds.length > 1 && (
          <RoundSelector rounds={allRounds} currentRoundId={roundId} leagueId={leagueId} />
        )}

        {/* ── Matchup selector ── */}
        <MatchupSelector
          matchups={allMatchups}
          nameMap={nameMap}
          currentMatchupId={selectedMatchup.matchupId}
          leagueId={leagueId}
          roundId={roundId}
        />

        {/* ── Live notice ── */}
        {isLive && (
          <p className="text-xs text-[var(--text-dim)]">
            Scores are provisional — updates as matches complete.
          </p>
        )}

        {/* ── Head-to-head: desktop side-by-side, mobile stacked ── */}
        {home && away ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <ManagerSide
              score={home}
              displayName={homeName}
              nationMap={nationMap}
              winnerManagerId={winnerManagerId}
              opponentTotal={away.total}
            />
            <ManagerSide
              score={away}
              displayName={awayName}
              nationMap={nationMap}
              winnerManagerId={winnerManagerId}
              opponentTotal={home.total}
            />
          </div>
        ) : (
          // BYE or missing side — render what's there
          <div className="max-w-sm">
            {home && (
              <ManagerSide
                score={home}
                displayName={homeName}
                nationMap={nationMap}
                winnerManagerId={winnerManagerId}
                opponentTotal={0}
              />
            )}
            {away && (
              <ManagerSide
                score={away}
                displayName={awayName}
                nationMap={nationMap}
                winnerManagerId={winnerManagerId}
                opponentTotal={0}
              />
            )}
            <p className="text-sm text-[var(--text-dim)] mt-2">BYE week — no opponent.</p>
          </div>
        )}
      </div>
    </div>
  );
}
