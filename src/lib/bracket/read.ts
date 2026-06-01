import "server-only";
import { db } from "@/db";
import { fantasyMatchups, fantasyRounds } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export type BracketMatchup = {
  matchupId: string;
  round: string;
  matchIndex: number;
  homeManagerId: string | null;
  homeSeedSource: string | null;
  awayManagerId: string | null;
  awaySeedSource: string | null;
  homeScore: string | null;
  awayScore: string | null;
  winnerManagerId: string | null;
  isBye: boolean;
};

export type BracketData = {
  qf: BracketMatchup[];
  sf: BracketMatchup[];
  final: BracketMatchup[];
};

const KNOCKOUT_ROUNDS = ["qf", "sf", "final"] as const;

export async function getBracket(leagueId: string): Promise<BracketData> {
  // Load knockout fantasy rounds for this league
  const roundRows = await db
    .select({ id: fantasyRounds.id, round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(
      and(
        eq(fantasyRounds.leagueId, leagueId),
        inArray(fantasyRounds.round, [...KNOCKOUT_ROUNDS]),
      ),
    );

  const roundNameById = new Map<string, string>();
  for (const r of roundRows) {
    roundNameById.set(r.id, r.round);
  }

  const roundIds = roundRows.map((r) => r.id);

  const matchups =
    roundIds.length > 0
      ? await db
          .select()
          .from(fantasyMatchups)
          .where(
            and(
              eq(fantasyMatchups.leagueId, leagueId),
              inArray(fantasyMatchups.fantasyRoundId, roundIds),
            ),
          )
      : [];

  const result: BracketData = { qf: [], sf: [], final: [] };

  for (const m of matchups) {
    const round = roundNameById.get(m.fantasyRoundId);
    if (!round) continue;

    const bracketMatchup: BracketMatchup = {
      matchupId: m.id,
      round,
      matchIndex: m.matchIndex,
      homeManagerId: m.homeManagerId ?? null,
      homeSeedSource: m.homeSeedSource ?? null,
      awayManagerId: m.awayManagerId ?? null,
      awaySeedSource: m.awaySeedSource ?? null,
      homeScore: m.homeScore ?? null,
      awayScore: m.awayScore ?? null,
      winnerManagerId: m.winnerManagerId ?? null,
      isBye: m.awaySeedSource === "BYE",
    };

    if (round === "qf") result.qf.push(bracketMatchup);
    else if (round === "sf") result.sf.push(bracketMatchup);
    else if (round === "final") result.final.push(bracketMatchup);
  }

  return result;
}
