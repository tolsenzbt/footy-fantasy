import "server-only";
import { db } from "@/db";
import { fantasyMatchups, fantasyRounds } from "@/db/schema";
import { players, nations, realFixtures } from "@/db/schema";
import { playerMatchStats, playerMatchScores } from "@/db/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { getLineup, type LineupReadResult } from "@/lib/lineup/read";
import { scoreStartingXI, type StartingXIInput } from "@/lib/scoring/lineup";
import { scorePlayer, type PlayerMatchStats, type FantasyPosition } from "@/lib/scoring/engine";

export type PlayerMatchDetail = {
  playerId: string;
  playerName: string;
  fantasyPosition: "GK" | "DEF" | "MID" | "FWD";
  basePoints: number;
  multiplier: 1 | 2;
  finalPoints: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  nationEliminatedAtRound: string | null;
  nationNextFixtureId: string | null;
};

export type ManagerMatchScore = {
  managerId: string;
  total: number;
  players: PlayerMatchDetail[];
};

export type MatchupDetail = {
  matchupId: string;
  matchIndex: number;
  home: ManagerMatchScore | null;
  away: ManagerMatchScore | null;
  awaySeedSource: string | null;
  winnerManagerId: string | null;
  homeScore: string | null;
  awayScore: string | null;
  isLive: boolean;
};

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

function buildPlayerDetails(
  lineup: LineupReadResult,
  playerToFixtureId: Map<string, string>,
  playerStatsMap: Map<string, PlayerMatchStats>,
  scoresMap: Map<string, { points: string; overridePoints: string | null }>,
  nationMap: Map<string, { eliminatedAtRound: string | null; nextFixtureId: string | null }>,
): { players: PlayerMatchDetail[]; total: number } {
  const starters = lineup.slots.filter((s) => s.slotType === "starter");

  if (lineup.captainPlayerId) {
    const xiPlayers = starters.map((s) => ({
      playerId: s.playerId,
      position: s.fantasyPosition as FantasyPosition,
      stats: playerStatsMap.get(s.playerId) ?? zeroStats(),
    }));

    const input: StartingXIInput = {
      players: xiPlayers,
      captainId: lineup.captainPlayerId,
      vcId: lineup.vcPlayerId ?? null,
    };

    const lineupScore = scoreStartingXI(input);

    let total = 0;
    const playerDetails: PlayerMatchDetail[] = [];

    for (const ps of lineupScore.players) {
      const slot = starters.find((s) => s.playerId === ps.playerId)!;
      const fixtureId = playerToFixtureId.get(ps.playerId);
      const scoreRow = fixtureId ? scoresMap.get(`${ps.playerId}:${fixtureId}`) : undefined;
      const nationInfo = nationMap.get(ps.playerId) ?? { eliminatedAtRound: null, nextFixtureId: null };

      let basePoints: number;
      let finalPoints: number;
      if (scoreRow?.overridePoints != null) {
        basePoints = parseFloat(scoreRow.overridePoints);
        finalPoints = basePoints * ps.multiplier;
      } else {
        basePoints = ps.basePoints;
        finalPoints = ps.finalPoints;
      }
      total += finalPoints;

      playerDetails.push({
        playerId: ps.playerId,
        playerName: slot.playerName,
        fantasyPosition: slot.fantasyPosition as "GK" | "DEF" | "MID" | "FWD",
        basePoints,
        multiplier: ps.multiplier,
        finalPoints,
        isCaptain: ps.isCaptain,
        isViceCaptain: ps.isViceCaptain,
        nationEliminatedAtRound: nationInfo.eliminatedAtRound,
        nationNextFixtureId: nationInfo.nextFixtureId,
      });
    }

    return { players: playerDetails, total };
  } else {
    // No captain: no multiplier
    let total = 0;
    const playerDetails: PlayerMatchDetail[] = [];

    for (const s of starters) {
      const stats = playerStatsMap.get(s.playerId) ?? zeroStats();
      const fixtureId = playerToFixtureId.get(s.playerId);
      const scoreRow = fixtureId ? scoresMap.get(`${s.playerId}:${fixtureId}`) : undefined;
      const nationInfo = nationMap.get(s.playerId) ?? { eliminatedAtRound: null, nextFixtureId: null };

      let basePoints: number;
      if (scoreRow?.overridePoints != null) {
        basePoints = parseFloat(scoreRow.overridePoints);
      } else {
        basePoints = scorePlayer(stats, s.fantasyPosition as FantasyPosition);
      }
      total += basePoints;

      playerDetails.push({
        playerId: s.playerId,
        playerName: s.playerName,
        fantasyPosition: s.fantasyPosition as "GK" | "DEF" | "MID" | "FWD",
        basePoints,
        multiplier: 1,
        finalPoints: basePoints,
        isCaptain: false,
        isViceCaptain: false,
        nationEliminatedAtRound: nationInfo.eliminatedAtRound,
        nationNextFixtureId: nationInfo.nextFixtureId,
      });
    }

    return { players: playerDetails, total };
  }
}

export async function getMatchupsForRound(
  leagueId: string,
  fantasyRoundId: string,
): Promise<MatchupDetail[]> {
  // Load all matchups for this round
  const matchups = await db
    .select()
    .from(fantasyMatchups)
    .where(
      and(
        eq(fantasyMatchups.leagueId, leagueId),
        eq(fantasyMatchups.fantasyRoundId, fantasyRoundId),
      ),
    );

  if (matchups.length === 0) return [];

  // Determine if round is live (any non-BYE matchup has null homeScore)
  const nonByeMatchups = matchups.filter((m) => m.awaySeedSource !== "BYE");
  const isLive = nonByeMatchups.some((m) => m.homeScore === null);

  // Get the round name for fixture lookup
  const [roundRow] = await db
    .select({ round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(eq(fantasyRounds.id, fantasyRoundId));

  if (!roundRow) return [];
  const roundName = roundRow.round;

  // Collect all manager IDs
  const managerIds = Array.from(
    new Set(
      matchups.flatMap((m) =>
        [m.homeManagerId, m.awayManagerId].filter(Boolean) as string[],
      ),
    ),
  );

  // Load all lineups
  const lineupResults = await Promise.all(
    managerIds.map((mid) => getLineup(leagueId, mid, fantasyRoundId)),
  );
  const lineupByManager = new Map<string, LineupReadResult | null>();
  for (let i = 0; i < managerIds.length; i++) {
    lineupByManager.set(managerIds[i], lineupResults[i]);
  }

  // Collect all player IDs
  const allPlayerIds = Array.from(
    new Set(
      [...lineupByManager.values()]
        .filter(Boolean)
        .flatMap((lu) =>
          lu!.slots.filter((s) => s.slotType === "starter").map((s) => s.playerId),
        ),
    ),
  );

  // Build player → nation → fixture maps
  const playerToFixtureId = new Map<string, string>();
  const nationMap = new Map<string, { eliminatedAtRound: string | null; nextFixtureId: string | null }>();
  const playerStatsMap = new Map<string, PlayerMatchStats>();
  const scoresMap = new Map<string, { points: string; overridePoints: string | null }>();

  if (allPlayerIds.length > 0) {
    // Players → nations
    const playerNationRows = await db
      .select({
        playerId: players.id,
        nationId: players.nationId,
        eliminatedAtRound: nations.eliminatedAtRound,
        nextFixtureId: nations.nextFixtureId,
      })
      .from(players)
      .innerJoin(nations, eq(nations.id, players.nationId))
      .where(inArray(players.id, allPlayerIds));

    const nationIdByPlayer = new Map<string, string>();
    for (const row of playerNationRows) {
      nationIdByPlayer.set(row.playerId, row.nationId);
      nationMap.set(row.playerId, {
        eliminatedAtRound: row.eliminatedAtRound ?? null,
        nextFixtureId: row.nextFixtureId ?? null,
      });
    }

    const allNationIds = Array.from(new Set(playerNationRows.map((r) => r.nationId)));

    // Nations → fixtures for this round
    const fixtureHomeRows = await db
      .select({ fixtureId: realFixtures.id, homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId })
      .from(realFixtures)
      .where(
        and(
          eq(realFixtures.round, roundName),
          inArray(realFixtures.homeNationId, allNationIds.length > 0 ? allNationIds : [""]),
        ),
      );
    const fixtureAwayRows = await db
      .select({ fixtureId: realFixtures.id, homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId })
      .from(realFixtures)
      .where(
        and(
          eq(realFixtures.round, roundName),
          inArray(realFixtures.awayNationId, allNationIds.length > 0 ? allNationIds : [""]),
        ),
      );

    const fixtureIdByNation = new Map<string, string>();
    for (const row of [...fixtureHomeRows, ...fixtureAwayRows]) {
      fixtureIdByNation.set(row.homeNationId, row.fixtureId);
      fixtureIdByNation.set(row.awayNationId, row.fixtureId);
    }

    for (const playerId of allPlayerIds) {
      const nationId = nationIdByPlayer.get(playerId);
      if (nationId) {
        const fId = fixtureIdByNation.get(nationId);
        if (fId) playerToFixtureId.set(playerId, fId);
      }
    }

    const allFixtureIds = Array.from(new Set(playerToFixtureId.values()));

    if (allFixtureIds.length > 0) {
      const [statsRows, scoresRows] = await Promise.all([
        db
          .select()
          .from(playerMatchStats)
          .where(
            and(
              inArray(playerMatchStats.fixtureId, allFixtureIds),
              inArray(playerMatchStats.playerId, allPlayerIds),
            ),
          ),
        db
          .select()
          .from(playerMatchScores)
          .where(
            and(
              inArray(playerMatchScores.fixtureId, allFixtureIds),
              inArray(playerMatchScores.playerId, allPlayerIds),
            ),
          ),
      ]);

      for (const row of statsRows) {
        playerStatsMap.set(row.playerId, statsFromRow(row));
        // Also key by playerId:fixtureId for scoresMap lookups
      }

      for (const row of scoresRows) {
        scoresMap.set(`${row.playerId}:${row.fixtureId}`, {
          points: row.points,
          overridePoints: row.overridePoints ?? null,
        });
      }
    }
  }

  // Build result
  const result: MatchupDetail[] = [];

  for (const matchup of matchups) {
    const isByeRow = matchup.awaySeedSource === "BYE";

    let home: ManagerMatchScore | null = null;
    let away: ManagerMatchScore | null = null;

    if (matchup.homeManagerId) {
      const lineup = lineupByManager.get(matchup.homeManagerId) ?? null;
      if (lineup) {
        const { players: playerDetails, total } = buildPlayerDetails(
          lineup,
          playerToFixtureId,
          playerStatsMap,
          scoresMap,
          nationMap,
        );
        home = { managerId: matchup.homeManagerId, total, players: playerDetails };
      } else {
        home = { managerId: matchup.homeManagerId, total: 0, players: [] };
      }
    }

    if (!isByeRow && matchup.awayManagerId) {
      const lineup = lineupByManager.get(matchup.awayManagerId) ?? null;
      if (lineup) {
        const { players: playerDetails, total } = buildPlayerDetails(
          lineup,
          playerToFixtureId,
          playerStatsMap,
          scoresMap,
          nationMap,
        );
        away = { managerId: matchup.awayManagerId, total, players: playerDetails };
      } else {
        away = { managerId: matchup.awayManagerId, total: 0, players: [] };
      }
    }

    result.push({
      matchupId: matchup.id,
      matchIndex: matchup.matchIndex,
      home,
      away: isByeRow ? null : away,
      awaySeedSource: matchup.awaySeedSource ?? null,
      winnerManagerId: matchup.winnerManagerId ?? null,
      homeScore: matchup.homeScore ?? null,
      awayScore: matchup.awayScore ?? null,
      isLive,
    });
  }

  return result;
}
