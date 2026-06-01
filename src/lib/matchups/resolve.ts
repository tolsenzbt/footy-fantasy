import "server-only";
import { db } from "@/db";
import { fantasyMatchups, fantasyRounds } from "@/db/schema";
import { players, nations, realFixtures } from "@/db/schema";
import { playerMatchStats, playerMatchScores } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getLineup, type LineupReadResult } from "@/lib/lineup/read";
import { applyCaptainMultiplier } from "@/lib/scoring/engine";

// Compute a manager's round total from materialized player_match_scores.
// base = overridePoints ?? points from player_match_scores (missing row → 0).
// Captain/VC multiplier applied on top of those bases, matching scoreStartingXI rules:
//   - captainPlayed = captainMinutesPlayed > 0 (from player_match_stats)
//   - vcPromotes = !captainPlayed && vcPlayerId !== null
//   - the one recipient (captain or promoting VC) gets 2x; no-VC, no-play → 1x all
function computeManagerScoreFromBases(
  starters: Array<{ playerId: string }>,
  basesMap: Map<string, number>,       // playerId → effective base (override ?? points ?? 0)
  captainPlayerId: string | null,
  vcPlayerId: string | null,
  captainMinutesPlayed: number,        // 0 if no stats row or no captain set
): number {
  if (!captainPlayerId) {
    return starters.reduce((sum, s) => sum + (basesMap.get(s.playerId) ?? 0), 0);
  }

  const captainPlayed = captainMinutesPlayed > 0;
  const vcPromotes = !captainPlayed && vcPlayerId !== null;
  const recipientId = vcPromotes ? vcPlayerId! : captainPlayerId;
  const recipientBonus = captainPlayed || vcPromotes;

  return starters.reduce((sum, { playerId }) => {
    const base = basesMap.get(playerId) ?? 0;
    return sum + applyCaptainMultiplier(base, recipientBonus && playerId === recipientId);
  }, 0);
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

  const activeMatchups = matchups.filter((m) => m.awaySeedSource !== "BYE");
  if (activeMatchups.length === 0) return;

  // 2. Get the round name (needed to match realFixtures.round)
  const [roundRow] = await db
    .select({ round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(eq(fantasyRounds.id, fantasyRoundId));

  if (!roundRow) return;
  const roundName = roundRow.round;

  // 3. Collect all manager IDs
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

  // 5. Collect all starter player IDs across all lineups
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
    await db.transaction(async (tx) => {
      for (const matchup of activeMatchups) {
        await tx
          .update(fantasyMatchups)
          .set({ homeScore: "0", awayScore: "0", winnerManagerId: null })
          .where(eq(fantasyMatchups.id, matchup.id));
      }
    });
    return;
  }

  // 6. Players → nation IDs batch query
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

  // 7. Nations → realFixtures for this round (home side, then away side)
  const [fixtureRowsHome, fixtureRowsAway] = await Promise.all([
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
  for (const row of [...fixtureRowsHome, ...fixtureRowsAway]) {
    fixtureIdByNation.set(row.homeNationId, row.fixtureId);
    fixtureIdByNation.set(row.awayNationId, row.fixtureId);
  }

  const playerToFixtureId = new Map<string, string>();
  for (const playerId of allPlayerIds) {
    const nationId = nationIdByPlayer.get(playerId);
    if (nationId) {
      const fId = fixtureIdByNation.get(nationId);
      if (fId) playerToFixtureId.set(playerId, fId);
    }
  }

  const allFixtureIds = Array.from(new Set(playerToFixtureId.values()));

  // 8. Collect captain player IDs (for minutesPlayed — VC-promotion check only)
  const allCaptainIds = Array.from(
    new Set(
      [...lineupByManager.values()]
        .filter(Boolean)
        .map((lu) => lu!.captainPlayerId)
        .filter(Boolean) as string[],
    ),
  );

  // 9. Fetch player_match_scores (base scores) and player_match_stats (captain minutesPlayed) in parallel.
  // Both queries always fire when fixtures exist so mock call-count is stable regardless of captain presence.
  const [scoresRows, captainStatsRows] = await Promise.all([
    allFixtureIds.length > 0
      ? db
          .select({
            playerId: playerMatchScores.playerId,
            fixtureId: playerMatchScores.fixtureId,
            points: playerMatchScores.points,
            overridePoints: playerMatchScores.overridePoints,
          })
          .from(playerMatchScores)
          .where(
            and(
              inArray(playerMatchScores.fixtureId, allFixtureIds),
              inArray(playerMatchScores.playerId, allPlayerIds),
            ),
          )
      : Promise.resolve([]),
    allFixtureIds.length > 0
      ? db
          .select({
            playerId: playerMatchStats.playerId,
            fixtureId: playerMatchStats.fixtureId,
            minutesPlayed: playerMatchStats.minutesPlayed,
          })
          .from(playerMatchStats)
          .where(
            and(
              inArray(playerMatchStats.fixtureId, allFixtureIds),
              // [""] is a no-match sentinel when there are no captains (avoids inArray([]) error)
              inArray(playerMatchStats.playerId, allCaptainIds.length > 0 ? allCaptainIds : [""]),
            ),
          )
      : Promise.resolve([]),
  ]);

  // 10. Build per-player base-score map: playerId → effective base (overridePoints ?? points)
  const basesMap = new Map<string, number>();
  for (const row of scoresRows) {
    const expectedFixture = playerToFixtureId.get(row.playerId);
    if (expectedFixture === row.fixtureId) {
      const base =
        row.overridePoints !== null
          ? parseFloat(row.overridePoints)
          : parseFloat(row.points);
      basesMap.set(row.playerId, base);
    }
  }

  // 11. Build captain minutesPlayed map: captainPlayerId → minutesPlayed
  const captainMinutesMap = new Map<string, number>();
  for (const row of captainStatsRows) {
    const expectedFixture = playerToFixtureId.get(row.playerId);
    if (expectedFixture === row.fixtureId) {
      captainMinutesMap.set(row.playerId, row.minutesPlayed);
    }
  }

  // 12. Score each matchup and write results
  await db.transaction(async (tx) => {
    for (const matchup of activeMatchups) {
      const homeScore = scoreLineup(matchup.homeManagerId, lineupByManager, basesMap, captainMinutesMap);
      const awayScore = scoreLineup(matchup.awayManagerId, lineupByManager, basesMap, captainMinutesMap);

      let winnerManagerId: string | null = null;
      if (homeScore > awayScore) winnerManagerId = matchup.homeManagerId ?? null;
      else if (awayScore > homeScore) winnerManagerId = matchup.awayManagerId ?? null;

      await tx
        .update(fantasyMatchups)
        .set({ homeScore: homeScore.toFixed(2), awayScore: awayScore.toFixed(2), winnerManagerId })
        .where(eq(fantasyMatchups.id, matchup.id));
    }
  });
}

function scoreLineup(
  managerId: string | null,
  lineupByManager: Map<string, LineupReadResult | null>,
  basesMap: Map<string, number>,
  captainMinutesMap: Map<string, number>,
): number {
  if (!managerId) return 0;
  const lineup = lineupByManager.get(managerId);
  if (!lineup) return 0;
  const starters = lineup.slots.filter((s) => s.slotType === "starter");
  return computeManagerScoreFromBases(
    starters,
    basesMap,
    lineup.captainPlayerId,
    lineup.vcPlayerId ?? null,
    captainMinutesMap.get(lineup.captainPlayerId ?? "") ?? 0,
  );
}
