import "server-only";
import { db } from "@/db";
import { groupStandings } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export type StandingRow = {
  managerId: string;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  pointsFor: string;
  pointsAgainst: string;
  highestSingleScore: string;
};

export type GroupStanding = {
  groupLetter: string;
  managers: StandingRow[];
};

export async function getStandings(leagueId: string): Promise<GroupStanding[]> {
  const rows = await db
    .select()
    .from(groupStandings)
    .where(eq(groupStandings.leagueId, leagueId))
    .orderBy(asc(groupStandings.groupLetter), asc(groupStandings.rank));

  const groupMap = new Map<string, StandingRow[]>();

  for (const row of rows) {
    if (!groupMap.has(row.groupLetter)) {
      groupMap.set(row.groupLetter, []);
    }
    groupMap.get(row.groupLetter)!.push({
      managerId: row.managerId,
      rank: row.rank,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      pointsFor: row.pointsFor,
      pointsAgainst: row.pointsAgainst,
      highestSingleScore: row.highestSingleScore,
    });
  }

  return Array.from(groupMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupLetter, managers]) => ({ groupLetter, managers }));
}
