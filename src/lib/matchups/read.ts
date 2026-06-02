import "server-only";
import { db } from "@/db";
import { fantasyMatchups, fantasyRounds } from "@/db/schema";
import { players, nations, realFixtures } from "@/db/schema";
import { playerMatchStats, playerMatchScores } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getLineup, type LineupReadResult } from "@/lib/lineup/read";
import { scoreLineupBases } from "./score";

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

function buildPlayerDetails(
  lineup: LineupReadResult,
  basesMap: Map<string, number>,
  captainMinutesMap: Map<string, number>,
  nationMap: Map<string, { eliminatedAtRound: string | null; nextFixtureId: string | null }>,
): { players: PlayerMatchDetail[]; total: number } {
  const starters = lineup.slots.filter((s) => s.slotType === "starter");
  const { players: scored, total } = scoreLineupBases(
    starters,
    basesMap,
    lineup.captainPlayerId,
    lineup.vcPlayerId ?? null,
    captainMinutesMap.get(lineup.captainPlayerId ?? "") ?? 0,
  );

  const playerDetails: PlayerMatchDetail[] = scored.map((sp) => {
    const slot = starters.find((s) => s.playerId === sp.playerId)!;
    const nationInfo = nationMap.get(sp.playerId) ?? { eliminatedAtRound: null, nextFixtureId: null };
    return {
      playerId: sp.playerId,
      playerName: slot.playerName,
      fantasyPosition: slot.fantasyPosition as "GK" | "DEF" | "MID" | "FWD",
      basePoints: sp.basePoints,
      multiplier: sp.multiplier,
      finalPoints: sp.finalPoints,
      isCaptain: sp.isCaptain,
      isViceCaptain: sp.isViceCaptain,
      nationEliminatedAtRound: nationInfo.eliminatedAtRound,
      nationNextFixtureId: nationInfo.nextFixtureId,
    };
  });

  return { players: playerDetails, total };
}

export async function getMatchupsForRound(
  leagueId: string,
  fantasyRoundId: string,
): Promise<MatchupDetail[]> {
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

  const nonByeMatchups = matchups.filter((m) => m.awaySeedSource !== "BYE");
  const isLive = nonByeMatchups.some((m) => m.homeScore === null);

  const [roundRow] = await db
    .select({ round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(eq(fantasyRounds.id, fantasyRoundId));

  if (!roundRow) return [];
  const roundName = roundRow.round;

  const managerIds = Array.from(
    new Set(matchups.flatMap((m) => [m.homeManagerId, m.awayManagerId].filter(Boolean) as string[])),
  );

  const lineupResults = await Promise.all(
    managerIds.map((mid) => getLineup(leagueId, mid, fantasyRoundId)),
  );
  const lineupByManager = new Map<string, LineupReadResult | null>();
  for (let i = 0; i < managerIds.length; i++) {
    lineupByManager.set(managerIds[i], lineupResults[i]);
  }

  const allPlayerIds = Array.from(
    new Set(
      [...lineupByManager.values()]
        .filter(Boolean)
        .flatMap((lu) => lu!.slots.filter((s) => s.slotType === "starter").map((s) => s.playerId)),
    ),
  );

  const playerToFixtureId = new Map<string, string>();
  const nationMap = new Map<string, { eliminatedAtRound: string | null; nextFixtureId: string | null }>();
  const basesMap = new Map<string, number>();
  const captainMinutesMap = new Map<string, number>();

  if (allPlayerIds.length > 0) {
    // Players → nations (join for nation status)
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

    const [fixtureHomeRows, fixtureAwayRows] = await Promise.all([
      db
        .select({ fixtureId: realFixtures.id, homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId })
        .from(realFixtures)
        .where(and(eq(realFixtures.round, roundName), inArray(realFixtures.homeNationId, allNationIds.length > 0 ? allNationIds : [""]))),
      db
        .select({ fixtureId: realFixtures.id, homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId })
        .from(realFixtures)
        .where(and(eq(realFixtures.round, roundName), inArray(realFixtures.awayNationId, allNationIds.length > 0 ? allNationIds : [""]))),
    ]);

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

    // Captain player IDs (for minutesPlayed lookup only)
    const allCaptainIds = Array.from(
      new Set(
        [...lineupByManager.values()]
          .filter(Boolean)
          .map((lu) => lu!.captainPlayerId)
          .filter(Boolean) as string[],
      ),
    );

    if (allFixtureIds.length > 0) {
      // player_match_scores: authoritative base scores (overridePoints ?? points)
      // player_match_stats: captain minutesPlayed only (for VC-promotion check)
      const [scoresRows, captainStatsRows] = await Promise.all([
        db
          .select({
            playerId: playerMatchScores.playerId,
            fixtureId: playerMatchScores.fixtureId,
            points: playerMatchScores.points,
            overridePoints: playerMatchScores.overridePoints,
          })
          .from(playerMatchScores)
          .where(and(inArray(playerMatchScores.fixtureId, allFixtureIds), inArray(playerMatchScores.playerId, allPlayerIds))),
        db
          .select({
            playerId: playerMatchStats.playerId,
            fixtureId: playerMatchStats.fixtureId,
            minutesPlayed: playerMatchStats.minutesPlayed,
          })
          .from(playerMatchStats)
          .where(and(
            inArray(playerMatchStats.fixtureId, allFixtureIds),
            inArray(playerMatchStats.playerId, allCaptainIds.length > 0 ? allCaptainIds : [""]),
          )),
      ]);

      for (const row of scoresRows) {
        const expectedFixture = playerToFixtureId.get(row.playerId);
        if (expectedFixture === row.fixtureId) {
          basesMap.set(
            row.playerId,
            row.overridePoints !== null ? parseFloat(row.overridePoints) : parseFloat(row.points),
          );
        }
      }

      for (const row of captainStatsRows) {
        const expectedFixture = playerToFixtureId.get(row.playerId);
        if (expectedFixture === row.fixtureId) {
          captainMinutesMap.set(row.playerId, row.minutesPlayed);
        }
      }
    }
  }

  const result: MatchupDetail[] = [];

  for (const matchup of matchups) {
    const isByeRow = matchup.awaySeedSource === "BYE";

    const scoreManager = (managerId: string): ManagerMatchScore => {
      const lineup = lineupByManager.get(managerId) ?? null;
      if (!lineup) return { managerId, total: 0, players: [] };
      const { players: playerDetails, total } = buildPlayerDetails(
        lineup, basesMap, captainMinutesMap, nationMap,
      );
      return { managerId, total, players: playerDetails };
    };

    let home = matchup.homeManagerId ? scoreManager(matchup.homeManagerId) : null;
    let away = !isByeRow && matchup.awayManagerId ? scoreManager(matchup.awayManagerId) : null;

    // For finalized rounds the stored score is authoritative for the headline total
    // (a stat correction may land after resolution without a re-resolve). Per-player
    // finals still come from the current player_match_scores breakdown above.
    if (!isLive) {
      if (home && matchup.homeScore !== null) {
        home = { ...home, total: parseFloat(matchup.homeScore) };
      }
      if (away && matchup.awayScore !== null) {
        away = { ...away, total: parseFloat(matchup.awayScore) };
      }
    }

    result.push({
      matchupId: matchup.id,
      matchIndex: matchup.matchIndex,
      home,
      away,
      awaySeedSource: matchup.awaySeedSource ?? null,
      winnerManagerId: matchup.winnerManagerId ?? null,
      homeScore: matchup.homeScore ?? null,
      awayScore: matchup.awayScore ?? null,
      isLive,
    });
  }

  return result;
}
