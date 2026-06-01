import "server-only";
import { db } from "@/db";
import {
  fantasyMatchups,
  fantasyRounds,
  groupStandings,
  scheduleSlots,
} from "@/db/schema";
import { players, nations, realFixtures } from "@/db/schema";
import { playerMatchStats, playerMatchScores } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getLineup, type LineupReadResult } from "@/lib/lineup/read";
import { scoreStartingXI, type StartingXIInput } from "@/lib/scoring/lineup";
import { scorePlayer, type PlayerMatchStats, type FantasyPosition } from "@/lib/scoring/engine";

function statsFromRow(row: {
  minutesPlayed: number;
  goals: number;
  assists: number;
  goalsConceded: number;
  saves: number;
  penaltySaved: boolean;
  penaltyMissed: boolean;
  yellowCards: number;
  redCard: boolean;
  ownGoals: number;
}): PlayerMatchStats {
  return {
    minutesPlayed: row.minutesPlayed,
    goals: row.goals,
    assists: row.assists,
    concededWhileOnPitch: row.goalsConceded,
    saves: row.saves,
    penaltiesSaved: row.penaltySaved ? 1 : 0,
    penaltiesMissed: row.penaltyMissed ? 1 : 0,
    yellowCards: row.yellowCards,
    redCards: row.redCard ? 1 : 0,
    ownGoals: row.ownGoals,
  };
}

function zeroStats(): PlayerMatchStats {
  return {
    minutesPlayed: 0,
    goals: 0,
    assists: 0,
    concededWhileOnPitch: 0,
    saves: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    yellowCards: 0,
    redCards: 0,
    ownGoals: 0,
  };
}

function computeManagerScore(
  lineup: LineupReadResult,
  playerToFixtureId: Map<string, string>,
  statsMap: Map<string, PlayerMatchStats>,
  scoresMap: Map<string, { points: string; overridePoints: string | null }>,
): number {
  const starters = lineup.slots.filter((s) => s.slotType === "starter");

  if (lineup.captainPlayerId) {
    const xiPlayers = starters.map((s) => ({
      playerId: s.playerId,
      position: s.fantasyPosition as FantasyPosition,
      stats: statsMap.get(s.playerId) ?? zeroStats(),
    }));

    const input: StartingXIInput = {
      players: xiPlayers,
      captainId: lineup.captainPlayerId,
      vcId: lineup.vcPlayerId ?? null,
    };

    const lineupScore = scoreStartingXI(input);

    // Apply overrides: replace effectiveBasePoints and recompute
    let total = 0;
    for (const ps of lineupScore.players) {
      const fixtureId = playerToFixtureId.get(ps.playerId);
      const scoreRow = fixtureId ? scoresMap.get(`${ps.playerId}:${fixtureId}`) : undefined;
      if (scoreRow?.overridePoints != null) {
        const effectiveBase = parseFloat(scoreRow.overridePoints);
        total += effectiveBase * ps.multiplier;
      } else {
        total += ps.finalPoints;
      }
    }
    return total;
  } else {
    // No captain: sum scorePlayer for each starter, apply overrides without multiplier
    let total = 0;
    for (const s of starters) {
      const stats = statsMap.get(s.playerId) ?? zeroStats();
      const fixtureId = playerToFixtureId.get(s.playerId);
      const scoreRow = fixtureId ? scoresMap.get(`${s.playerId}:${fixtureId}`) : undefined;
      if (scoreRow?.overridePoints != null) {
        total += parseFloat(scoreRow.overridePoints);
      } else {
        total += scorePlayer(stats, s.fantasyPosition as FantasyPosition);
      }
    }
    return total;
  }
}

export async function resolveMatchups(
  leagueId: string,
  fantasyRoundId: string,
): Promise<void> {
  // 1. Load matchups for this round
  const matchups = await db
    .select()
    .from(fantasyMatchups)
    .where(
      and(
        eq(fantasyMatchups.leagueId, leagueId),
        eq(fantasyMatchups.fantasyRoundId, fantasyRoundId),
      ),
    );

  // Filter out BYE rows
  const activeMatchups = matchups.filter((m) => m.awaySeedSource !== "BYE");

  if (activeMatchups.length === 0) return;

  // 2. Get the round name
  const [roundRow] = await db
    .select({ round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(eq(fantasyRounds.id, fantasyRoundId));

  if (!roundRow) return;
  const roundName = roundRow.round;

  // 3. Collect all manager IDs (home + away, non-null)
  const managerIds = Array.from(
    new Set(
      activeMatchups.flatMap((m) =>
        [m.homeManagerId, m.awayManagerId].filter(Boolean) as string[],
      ),
    ),
  );

  // 4. Load all lineups in parallel
  const lineupResults = await Promise.all(
    managerIds.map((mid) => getLineup(leagueId, mid, fantasyRoundId)),
  );
  const lineupByManager = new Map<string, LineupReadResult | null>();
  for (let i = 0; i < managerIds.length; i++) {
    lineupByManager.set(managerIds[i], lineupResults[i]);
  }

  // 5. Collect all player IDs from all starters
  const allPlayerIds = Array.from(
    new Set(
      [...lineupByManager.values()]
        .filter(Boolean)
        .flatMap((lu) =>
          lu!.slots.filter((s) => s.slotType === "starter").map((s) => s.playerId),
        ),
    ),
  );

  if (allPlayerIds.length === 0) {
    // All managers have no lineup; write zero scores
    await db.transaction(async (tx) => {
      for (const matchup of activeMatchups) {
        await tx
          .update(fantasyMatchups)
          .set({
            homeScore: "0",
            awayScore: "0",
            winnerManagerId: null,
          })
          .where(eq(fantasyMatchups.id, matchup.id));
      }
    });
    return;
  }

  // 6. Players → nations batch query
  const playerRows = await db
    .select({ id: players.id, nationId: players.nationId })
    .from(players)
    .where(inArray(players.id, allPlayerIds));

  const nationIdByPlayer = new Map<string, string>();
  const allNationIds: string[] = [];
  for (const p of playerRows) {
    nationIdByPlayer.set(p.id, p.nationId);
    allNationIds.push(p.nationId);
  }

  // 7. Nations → realFixtures for this round
  const fixtureRows = await db
    .select({
      fixtureId: realFixtures.id,
      homeNationId: realFixtures.homeNationId,
      awayNationId: realFixtures.awayNationId,
    })
    .from(realFixtures)
    .where(
      and(
        eq(realFixtures.round, roundName),
        inArray(realFixtures.homeNationId, allNationIds.length > 0 ? allNationIds : [""]),
      ),
    );

  // Also query by awayNationId
  const fixtureRowsAway = await db
    .select({
      fixtureId: realFixtures.id,
      homeNationId: realFixtures.homeNationId,
      awayNationId: realFixtures.awayNationId,
    })
    .from(realFixtures)
    .where(
      and(
        eq(realFixtures.round, roundName),
        inArray(realFixtures.awayNationId, allNationIds.length > 0 ? allNationIds : [""]),
      ),
    );

  // Build nationId → fixtureId map
  const fixtureIdByNation = new Map<string, string>();
  for (const row of [...fixtureRows, ...fixtureRowsAway]) {
    fixtureIdByNation.set(row.homeNationId, row.fixtureId);
    fixtureIdByNation.set(row.awayNationId, row.fixtureId);
  }

  // Build playerId → fixtureId map
  const playerToFixtureId = new Map<string, string>();
  for (const playerId of allPlayerIds) {
    const nationId = nationIdByPlayer.get(playerId);
    if (nationId) {
      const fId = fixtureIdByNation.get(nationId);
      if (fId) playerToFixtureId.set(playerId, fId);
    }
  }

  // 8. Collect all fixture IDs used
  const allFixtureIds = Array.from(new Set(playerToFixtureId.values()));

  // 9. Batch fetch stats and scores
  const [statsRows, scoresRows] = await Promise.all([
    allFixtureIds.length > 0
      ? db
          .select()
          .from(playerMatchStats)
          .where(
            and(
              inArray(playerMatchStats.fixtureId, allFixtureIds),
              inArray(playerMatchStats.playerId, allPlayerIds),
            ),
          )
      : Promise.resolve([]),
    allFixtureIds.length > 0
      ? db
          .select()
          .from(playerMatchScores)
          .where(
            and(
              inArray(playerMatchScores.fixtureId, allFixtureIds),
              inArray(playerMatchScores.playerId, allPlayerIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  // Build lookup maps keyed by "playerId:fixtureId"
  const statsMap = new Map<string, PlayerMatchStats>();
  for (const row of statsRows) {
    statsMap.set(`${row.playerId}:${row.fixtureId}`, statsFromRow(row));
  }

  const scoresMap = new Map<string, { points: string; overridePoints: string | null }>();
  for (const row of scoresRows) {
    scoresMap.set(`${row.playerId}:${row.fixtureId}`, {
      points: row.points,
      overridePoints: row.overridePoints ?? null,
    });
  }

  // Build per-player stats map keyed by playerId (using their fixture)
  const playerStatsMap = new Map<string, PlayerMatchStats>();
  for (const playerId of allPlayerIds) {
    const fixtureId = playerToFixtureId.get(playerId);
    if (fixtureId) {
      playerStatsMap.set(playerId, statsMap.get(`${playerId}:${fixtureId}`) ?? zeroStats());
    } else {
      playerStatsMap.set(playerId, zeroStats());
    }
  }

  // Process matchups and write results in a transaction
  await db.transaction(async (tx) => {
    for (const matchup of activeMatchups) {
      const homeLineup = matchup.homeManagerId
        ? lineupByManager.get(matchup.homeManagerId) ?? null
        : null;
      const awayLineup = matchup.awayManagerId
        ? lineupByManager.get(matchup.awayManagerId) ?? null
        : null;

      const homeScore = homeLineup
        ? computeManagerScore(homeLineup, playerToFixtureId, playerStatsMap, scoresMap)
        : 0;
      const awayScore = awayLineup
        ? computeManagerScore(awayLineup, playerToFixtureId, playerStatsMap, scoresMap)
        : 0;

      let winnerManagerId: string | null = null;
      if (homeScore > awayScore) {
        winnerManagerId = matchup.homeManagerId ?? null;
      } else if (awayScore > homeScore) {
        winnerManagerId = matchup.awayManagerId ?? null;
      }
      // equal → null (draw)

      await tx
        .update(fantasyMatchups)
        .set({
          homeScore: homeScore.toFixed(2),
          awayScore: awayScore.toFixed(2),
          winnerManagerId,
        })
        .where(eq(fantasyMatchups.id, matchup.id));
    }
  });
}
