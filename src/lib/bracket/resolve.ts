import "server-only";
import { db } from "@/db";
import { fantasyMatchups, fantasyRounds, groupStandings } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export type ParsedSeedSource =
  | { type: "standing"; rank: number; groupLetter: string }
  | { type: "bye" }
  | { type: "winner"; round: string; matchIndex: number }
  | { type: "unknown" };

export function parseSeedSource(source: string): ParsedSeedSource {
  if (source === "BYE") return { type: "bye" };

  // Matches like '1A', '2B', '3C' — one or more digits followed by one uppercase letter
  const standingMatch = source.match(/^(\d+)([A-Z])$/);
  if (standingMatch) {
    return {
      type: "standing",
      rank: parseInt(standingMatch[1], 10),
      groupLetter: standingMatch[2],
    };
  }

  // Matches like 'winner_qf_1', 'winner_sf_2', 'winner_final_1'
  const winnerMatch = source.match(/^winner_(qf|sf|final)_(\d+)$/);
  if (winnerMatch) {
    return {
      type: "winner",
      round: winnerMatch[1],
      matchIndex: parseInt(winnerMatch[2], 10),
    };
  }

  return { type: "unknown" };
}

const KNOCKOUT_ROUNDS = ["qf", "sf", "final"] as const;

export async function resolveBracket(leagueId: string): Promise<void> {
  // 1. Load all knockout fantasy rounds for this league
  const knockoutRoundRows = await db
    .select({ id: fantasyRounds.id, round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(
      and(
        eq(fantasyRounds.leagueId, leagueId),
        inArray(fantasyRounds.round, [...KNOCKOUT_ROUNDS]),
      ),
    );

  const roundIdByName = new Map<string, string>();
  for (const r of knockoutRoundRows) {
    roundIdByName.set(r.round, r.id);
  }

  const knockoutRoundIds = knockoutRoundRows.map((r) => r.id);

  if (knockoutRoundIds.length === 0) return;

  // 2. Load all knockout matchups
  const allMatchups = await db
    .select()
    .from(fantasyMatchups)
    .where(
      and(
        eq(fantasyMatchups.leagueId, leagueId),
        inArray(fantasyMatchups.fantasyRoundId, knockoutRoundIds),
      ),
    );

  // 3. Load group standings
  const standingRows = await db
    .select({
      managerId: groupStandings.managerId,
      groupLetter: groupStandings.groupLetter,
      rank: groupStandings.rank,
    })
    .from(groupStandings)
    .where(eq(groupStandings.leagueId, leagueId));

  // Build lookup: rank + groupLetter → managerId
  const standingsByKey = new Map<string, string>();
  for (const row of standingRows) {
    standingsByKey.set(`${row.rank}${row.groupLetter}`, row.managerId);
  }

  // Build lookup: roundName + matchIndex → matchup
  const matchupByRoundAndIndex = new Map<string, (typeof allMatchups)[number]>();
  for (const m of allMatchups) {
    const roundRow = knockoutRoundRows.find((r) => r.id === m.fantasyRoundId);
    if (roundRow) {
      matchupByRoundAndIndex.set(`${roundRow.round}_${m.matchIndex}`, m);
    }
  }

  await db.transaction(async (tx) => {
    for (const matchup of allMatchups) {
      const updates: {
        homeManagerId?: string | null;
        awayManagerId?: string | null;
        winnerManagerId?: string | null;
      } = {};

      // Resolve home seed if not yet set
      if (matchup.homeManagerId == null && matchup.homeSeedSource) {
        const parsed = parseSeedSource(matchup.homeSeedSource);
        if (parsed.type === "standing") {
          const managerId = standingsByKey.get(`${parsed.rank}${parsed.groupLetter}`);
          if (managerId) updates.homeManagerId = managerId;
        } else if (parsed.type === "bye") {
          // BYE on home side shouldn't normally happen per templates, but handle gracefully
          updates.homeManagerId = null;
        } else if (parsed.type === "winner") {
          const refMatchup = matchupByRoundAndIndex.get(`${parsed.round}_${parsed.matchIndex}`);
          if (refMatchup?.winnerManagerId) {
            updates.homeManagerId = refMatchup.winnerManagerId;
          }
        }
      }

      // Resolve away seed if not yet set
      if (matchup.awayManagerId == null && matchup.awaySeedSource) {
        const parsed = parseSeedSource(matchup.awaySeedSource);
        if (parsed.type === "bye") {
          // BYE away: auto-win for home
          const resolvedHomeId = updates.homeManagerId ?? matchup.homeManagerId;
          if (resolvedHomeId) {
            updates.winnerManagerId = resolvedHomeId;
          }
          // awayManagerId stays null
        } else if (parsed.type === "standing") {
          const managerId = standingsByKey.get(`${parsed.rank}${parsed.groupLetter}`);
          if (managerId) updates.awayManagerId = managerId;
        } else if (parsed.type === "winner") {
          const refMatchup = matchupByRoundAndIndex.get(`${parsed.round}_${parsed.matchIndex}`);
          if (refMatchup?.winnerManagerId) {
            updates.awayManagerId = refMatchup.winnerManagerId;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await tx
          .update(fantasyMatchups)
          .set(updates)
          .where(eq(fantasyMatchups.id, matchup.id));
      }
    }
  });
}
