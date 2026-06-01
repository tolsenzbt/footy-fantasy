import "server-only";
import { randomInt } from "crypto";
import { db } from "@/db";
import { fantasyMatchups, fantasyRounds, groupStandings, scheduleSlots } from "@/db/schema";
import { eq, and, inArray, isNotNull } from "drizzle-orm";

export type H2HMatchResult = {
  homeManagerId: string;
  awayManagerId: string;
  homeScore: number;
  awayScore: number;
};

export type ManagerGroupStats = {
  managerId: string;
  groupLetter: string;
  wins: number;
  losses: number;
  draws: number;
  pointsFor: number;
  pointsAgainst: number;
  highestSingleScore: number;
  randomTiebreak: number;
};

/**
 * Ranks managers within a group using the tiebreaker chain:
 * 1. pointsFor DESC
 * 2. H2H (2-way direct; 3+-way mini-table then recurse)
 * 3. highestSingleScore DESC
 * 4. randomTiebreak ASC
 */
export function rankGroupManagers(
  managers: ManagerGroupStats[],
  h2hResults: H2HMatchResult[],
): ManagerGroupStats[] {
  if (managers.length <= 1) return [...managers];

  // Step 1: Sort by pointsFor DESC
  const sorted = [...managers].sort((a, b) => b.pointsFor - a.pointsFor);

  // Find groups of tied managers (same pointsFor)
  const ranked: ManagerGroupStats[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].pointsFor === sorted[i].pointsFor) {
      j++;
    }
    const tiedGroup = sorted.slice(i, j);
    if (tiedGroup.length === 1) {
      ranked.push(tiedGroup[0]);
    } else {
      const resolved = resolveH2H(tiedGroup, h2hResults);
      ranked.push(...resolved);
    }
    i = j;
  }
  return ranked;
}

function resolveH2H(
  managers: ManagerGroupStats[],
  h2hResults: H2HMatchResult[],
): ManagerGroupStats[] {
  if (managers.length === 1) return [...managers];

  const ids = new Set(managers.map((m) => m.managerId));

  if (managers.length === 2) {
    const [a, b] = managers;
    // Find direct match between a and b
    const match = h2hResults.find(
      (r) =>
        (r.homeManagerId === a.managerId && r.awayManagerId === b.managerId) ||
        (r.homeManagerId === b.managerId && r.awayManagerId === a.managerId),
    );
    if (match) {
      const aIsHome = match.homeManagerId === a.managerId;
      const aScore = aIsHome ? match.homeScore : match.awayScore;
      const bScore = aIsHome ? match.awayScore : match.homeScore;
      if (aScore > bScore) return [a, b];
      if (bScore > aScore) return [b, a];
      // Draw: fall through to highestSingleScore + randomTiebreak
    }
    return resolveByFallback([a, b]);
  }

  // 3+-way: build mini-table among these managers
  type MiniRow = { managerId: string; wins: number; draws: number; losses: number };
  const miniTable = new Map<string, MiniRow>();
  for (const m of managers) {
    miniTable.set(m.managerId, { managerId: m.managerId, wins: 0, draws: 0, losses: 0 });
  }

  for (const r of h2hResults) {
    if (!ids.has(r.homeManagerId) || !ids.has(r.awayManagerId)) continue;
    const homeRow = miniTable.get(r.homeManagerId)!;
    const awayRow = miniTable.get(r.awayManagerId)!;
    if (r.homeScore > r.awayScore) {
      homeRow.wins++;
      awayRow.losses++;
    } else if (r.awayScore > r.homeScore) {
      awayRow.wins++;
      homeRow.losses++;
    } else {
      homeRow.draws++;
      awayRow.draws++;
    }
  }

  // Sort mini-table by wins DESC, then draws DESC
  const miniSorted = [...miniTable.values()].sort(
    (a, b) => b.wins - a.wins || b.draws - a.draws,
  );

  // Find groups with the same W/D record
  const resolved: ManagerGroupStats[] = [];
  let i = 0;
  while (i < miniSorted.length) {
    let j = i + 1;
    while (
      j < miniSorted.length &&
      miniSorted[j].wins === miniSorted[i].wins &&
      miniSorted[j].draws === miniSorted[i].draws
    ) {
      j++;
    }
    const tiedMini = miniSorted.slice(i, j).map((row) =>
      managers.find((m) => m.managerId === row.managerId)!,
    );
    if (tiedMini.length === 1) {
      resolved.push(tiedMini[0]);
    } else if (tiedMini.length === 2) {
      // 2-way subset: re-run full chain — the 2-way H2H path uses their direct
      // match result and is safe (won't loop back into 3+-way mini-table logic).
      resolved.push(...rankGroupManagers(tiedMini, h2hResults));
    } else {
      // 3+-way subset still tied in H2H mini-table (e.g. circular A>B>C>A).
      // Re-running from step 1 would produce the same circular result since their
      // PF is equal and the mini-table hasn't changed — skip directly to fallback.
      resolved.push(...resolveByFallback(tiedMini));
    }
    i = j;
  }
  return resolved;
}

function resolveByFallback(managers: ManagerGroupStats[]): ManagerGroupStats[] {
  // Sort by highestSingleScore DESC
  const sorted = [...managers].sort(
    (a, b) => b.highestSingleScore - a.highestSingleScore,
  );

  const ranked: ManagerGroupStats[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (
      j < sorted.length &&
      sorted[j].highestSingleScore === sorted[i].highestSingleScore
    ) {
      j++;
    }
    const tiedGroup = sorted.slice(i, j);
    if (tiedGroup.length === 1) {
      ranked.push(tiedGroup[0]);
    } else {
      // Sort by randomTiebreak ASC
      const byRandom = [...tiedGroup].sort(
        (a, b) => a.randomTiebreak - b.randomTiebreak,
      );
      ranked.push(...byRandom);
    }
    i = j;
  }
  return ranked;
}

const GROUP_ROUNDS = ["group_md1", "group_md2", "group_md3"] as const;

export async function computeStandings(leagueId: string): Promise<void> {
  // 1. Load all group-stage fantasy rounds for this league
  const rounds = await db
    .select({ id: fantasyRounds.id, round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(
      and(
        eq(fantasyRounds.leagueId, leagueId),
        inArray(fantasyRounds.round, [...GROUP_ROUNDS]),
      ),
    );

  const roundIds = rounds.map((r) => r.id);

  if (roundIds.length === 0) return;

  // 2. Load resolved group-stage matchups
  const matchupRows = await db
    .select()
    .from(fantasyMatchups)
    .where(
      and(
        eq(fantasyMatchups.leagueId, leagueId),
        inArray(fantasyMatchups.fantasyRoundId, roundIds),
        isNotNull(fantasyMatchups.homeScore),
      ),
    );

  // 3. Load schedule_slots to get groupLetter per manager
  const slotRows = await db
    .select({
      managerId: scheduleSlots.managerId,
      groupLetter: scheduleSlots.groupLetter,
    })
    .from(scheduleSlots)
    .where(eq(scheduleSlots.leagueId, leagueId));

  const groupByManager = new Map<string, string>();
  for (const slot of slotRows) {
    if (slot.managerId) {
      groupByManager.set(slot.managerId, slot.groupLetter);
    }
  }

  // 4. Load existing standings to preserve randomTiebreak values
  const existingRows = await db
    .select({
      managerId: groupStandings.managerId,
      randomTiebreak: groupStandings.randomTiebreak,
    })
    .from(groupStandings)
    .where(eq(groupStandings.leagueId, leagueId));

  const existingTiebreak = new Map<string, number>();
  for (const row of existingRows) {
    if (row.randomTiebreak != null) {
      existingTiebreak.set(row.managerId, row.randomTiebreak);
    }
  }

  // 5. Compute per-manager stats
  type Stats = {
    managerId: string;
    wins: number;
    losses: number;
    draws: number;
    pointsFor: number;
    pointsAgainst: number;
    scores: number[]; // individual round scores for highestSingleScore
  };

  const statsMap = new Map<string, Stats>();

  function getOrCreate(managerId: string): Stats {
    if (!statsMap.has(managerId)) {
      statsMap.set(managerId, {
        managerId,
        wins: 0,
        losses: 0,
        draws: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        scores: [],
      });
    }
    return statsMap.get(managerId)!;
  }

  const h2hResults: H2HMatchResult[] = [];

  for (const matchup of matchupRows) {
    if (!matchup.homeManagerId || !matchup.awayManagerId) continue;
    if (!matchup.homeScore || !matchup.awayScore) continue;

    const hScore = parseFloat(matchup.homeScore);
    const aScore = parseFloat(matchup.awayScore);

    const home = getOrCreate(matchup.homeManagerId);
    const away = getOrCreate(matchup.awayManagerId);

    home.pointsFor += hScore;
    home.pointsAgainst += aScore;
    home.scores.push(hScore);

    away.pointsFor += aScore;
    away.pointsAgainst += hScore;
    away.scores.push(aScore);

    if (hScore > aScore) {
      home.wins++;
      away.losses++;
    } else if (aScore > hScore) {
      away.wins++;
      home.losses++;
    } else {
      home.draws++;
      away.draws++;
    }

    h2hResults.push({
      homeManagerId: matchup.homeManagerId,
      awayManagerId: matchup.awayManagerId,
      homeScore: hScore,
      awayScore: aScore,
    });
  }

  // 6. Group managers by groupLetter
  const groups = new Map<string, ManagerGroupStats[]>();

  for (const [managerId, stats] of statsMap) {
    const groupLetter = groupByManager.get(managerId);
    if (!groupLetter) continue;

    const tiebreak =
      existingTiebreak.get(managerId) ?? randomInt(0, 1_000_000_000);

    const managerStats: ManagerGroupStats = {
      managerId,
      groupLetter,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      pointsFor: stats.pointsFor,
      pointsAgainst: stats.pointsAgainst,
      highestSingleScore: stats.scores.length > 0 ? Math.max(...stats.scores) : 0,
      randomTiebreak: tiebreak,
    };

    if (!groups.has(groupLetter)) {
      groups.set(groupLetter, []);
    }
    groups.get(groupLetter)!.push(managerStats);
  }

  // 7. Rank and write
  await db.transaction(async (tx) => {
    for (const [groupLetter, groupManagers] of groups) {
      const ranked = rankGroupManagers(groupManagers, h2hResults);

      for (let rankIdx = 0; rankIdx < ranked.length; rankIdx++) {
        const m = ranked[rankIdx];
        const rank = rankIdx + 1;

        await tx
          .insert(groupStandings)
          .values({
            leagueId,
            groupLetter,
            rank,
            managerId: m.managerId,
            wins: m.wins,
            losses: m.losses,
            draws: m.draws,
            pointsFor: m.pointsFor.toFixed(2),
            pointsAgainst: m.pointsAgainst.toFixed(2),
            highestSingleScore: m.highestSingleScore.toFixed(2),
            randomTiebreak: m.randomTiebreak,
            computedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [groupStandings.leagueId, groupStandings.managerId],
            set: {
              groupLetter,
              rank,
              wins: m.wins,
              losses: m.losses,
              draws: m.draws,
              pointsFor: m.pointsFor.toFixed(2),
              pointsAgainst: m.pointsAgainst.toFixed(2),
              highestSingleScore: m.highestSingleScore.toFixed(2),
              randomTiebreak: m.randomTiebreak,
              computedAt: new Date(),
            },
          });
      }
    }
  });
}
