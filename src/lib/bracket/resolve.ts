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

  const standingMatch = source.match(/^(\d+)([A-Z])$/);
  if (standingMatch) {
    return {
      type: "standing",
      rank: parseInt(standingMatch[1], 10),
      groupLetter: standingMatch[2],
    };
  }

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

// Ordered: each round's seeds come from the prior round's winners.
const ROUND_ORDER = ["qf", "sf", "final"] as const;

export async function resolveBracket(leagueId: string): Promise<void> {
  // 1. Load knockout fantasy rounds
  const knockoutRoundRows = await db
    .select({ id: fantasyRounds.id, round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(
      and(
        eq(fantasyRounds.leagueId, leagueId),
        inArray(fantasyRounds.round, [...ROUND_ORDER]),
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

  // 3. Load group standings for seed-code resolution
  const standingRows = await db
    .select({
      managerId: groupStandings.managerId,
      groupLetter: groupStandings.groupLetter,
      rank: groupStandings.rank,
    })
    .from(groupStandings)
    .where(eq(groupStandings.leagueId, leagueId));

  const standingsByKey = new Map<string, string>();
  for (const row of standingRows) {
    standingsByKey.set(`${row.rank}${row.groupLetter}`, row.managerId);
  }

  // Working state: roundName_matchIndex → mutable copy of the matchup.
  // Updated in-memory after each write so later rounds see resolved winners
  // without needing a second DB call.
  type WorkingMatchup = {
    id: string;
    homeManagerId: string | null;
    awayManagerId: string | null;
    winnerManagerId: string | null;
    homeSeedSource: string | null;
    awaySeedSource: string | null;
  };
  const workingByKey = new Map<string, WorkingMatchup>();
  for (const m of allMatchups) {
    const roundRow = knockoutRoundRows.find((r) => r.id === m.fantasyRoundId);
    if (roundRow) {
      workingByKey.set(`${roundRow.round}_${m.matchIndex}`, {
        id: m.id,
        homeManagerId: m.homeManagerId ?? null,
        awayManagerId: m.awayManagerId ?? null,
        winnerManagerId: m.winnerManagerId ?? null,
        homeSeedSource: m.homeSeedSource ?? null,
        awaySeedSource: m.awaySeedSource ?? null,
      });
    }
  }

  await db.transaction(async (tx) => {
    // Process rounds in dependency order: qf → sf → final.
    // After writing a matchup, update workingByKey so the next layer can see it.
    for (const roundName of ROUND_ORDER) {
      const roundId = roundIdByName.get(roundName);
      if (!roundId) continue;

      for (const matchup of allMatchups.filter((m) => m.fantasyRoundId === roundId)) {
        const working = workingByKey.get(`${roundName}_${matchup.matchIndex}`)!;
        const updates: {
          homeManagerId?: string;
          awayManagerId?: string;
          winnerManagerId?: string;
        } = {};

        // Resolve home seed.
        // Standing-type: always re-resolve (standings update each matchday).
        // Winner-type: only set once (match winners are final once written).
        if (working.homeSeedSource) {
          const parsed = parseSeedSource(working.homeSeedSource);
          if (parsed.type === "standing") {
            const mgr = standingsByKey.get(`${parsed.rank}${parsed.groupLetter}`);
            if (mgr) updates.homeManagerId = mgr;
          } else if (parsed.type === "winner" && working.homeManagerId == null) {
            const ref = workingByKey.get(`${parsed.round}_${parsed.matchIndex}`);
            if (ref?.winnerManagerId) updates.homeManagerId = ref.winnerManagerId;
          }
        }

        // Resolve away seed.
        if (working.awaySeedSource) {
          const parsed = parseSeedSource(working.awaySeedSource);
          if (parsed.type === "bye") {
            // BYE: home manager auto-wins; winnerManagerId set at seed-resolution time
            const homeId = updates.homeManagerId ?? working.homeManagerId;
            if (homeId) updates.winnerManagerId = homeId;
          } else if (parsed.type === "standing") {
            const mgr = standingsByKey.get(`${parsed.rank}${parsed.groupLetter}`);
            if (mgr) updates.awayManagerId = mgr;
          } else if (parsed.type === "winner" && working.awayManagerId == null) {
            const ref = workingByKey.get(`${parsed.round}_${parsed.matchIndex}`);
            if (ref?.winnerManagerId) updates.awayManagerId = ref.winnerManagerId;
          }
        }

        if (Object.keys(updates).length > 0) {
          await tx
            .update(fantasyMatchups)
            .set(updates)
            .where(eq(fantasyMatchups.id, matchup.id));
          // Thread resolved values forward so dependent rounds see them in this pass
          Object.assign(working, updates);
        }
      }
    }
  });
}
