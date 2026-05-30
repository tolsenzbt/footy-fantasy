import "server-only";
import { db } from "@/db";
import { lineups, lineupSlots } from "@/db/schema/roster";
import { fantasyRounds } from "@/db/schema/schedule";
import { players } from "@/db/schema/tournament";
import { eq, and } from "drizzle-orm";

const ROUND_ORDER = [
  "group_md1",
  "group_md2",
  "group_md3",
  "qf",
  "sf",
  "final",
] as const;
type FantasyRound = (typeof ROUND_ORDER)[number];

export type LineupSlotDetail = {
  playerId: string;
  playerName: string;
  fantasyPosition: "GK" | "DEF" | "MID" | "FWD";
  slotType: "starter" | "bench";
  lockedAt: Date | null;
};

export type LineupReadResult = {
  lineupId: string;
  leagueId: string;
  managerId: string;
  fantasyRoundId: string;
  round: string;
  formation: string;
  captainPlayerId: string | null;
  vcPlayerId: string | null;
  captainLockedAt: Date | null;
  vcLockedAt: Date | null;
  slots: LineupSlotDetail[];
  isFallback: boolean;
  fallbackRound: string | null;
};

export async function getLineup(
  leagueId: string,
  managerId: string,
  fantasyRoundId: string
): Promise<LineupReadResult | null> {
  // Load all fantasy rounds for this league in a single query
  const allRounds = await db
    .select({ id: fantasyRounds.id, round: fantasyRounds.round })
    .from(fantasyRounds)
    .where(eq(fantasyRounds.leagueId, leagueId));

  const roundById = new Map(allRounds.map(r => [r.id, r.round as FantasyRound]));
  const roundIdByName = new Map(allRounds.map(r => [r.round as FantasyRound, r.id]));

  const requestedRound = roundById.get(fantasyRoundId);
  if (!requestedRound) return null;

  const roundIdx = ROUND_ORDER.indexOf(requestedRound);
  if (roundIdx === -1) return null;

  // Walk back from requested round toward group_md1
  const roundsToTry = ROUND_ORDER.slice(0, roundIdx + 1).reverse();

  for (const roundName of roundsToTry) {
    const roundId = roundIdByName.get(roundName);
    if (!roundId) continue;

    const [lineup] = await db
      .select()
      .from(lineups)
      .where(and(
        eq(lineups.leagueId, leagueId),
        eq(lineups.managerId, managerId),
        eq(lineups.fantasyRoundId, roundId),
      ));

    if (!lineup) continue;

    const slots = await db
      .select({
        playerId: lineupSlots.playerId,
        playerName: players.name,
        fantasyPosition: players.fantasyPosition,
        slotType: lineupSlots.slotType,
        lockedAt: lineupSlots.lockedAt,
      })
      .from(lineupSlots)
      .innerJoin(players, eq(players.id, lineupSlots.playerId))
      .where(eq(lineupSlots.lineupId, lineup.id));

    return {
      lineupId: lineup.id,
      leagueId: lineup.leagueId,
      managerId: lineup.managerId,
      fantasyRoundId: lineup.fantasyRoundId,
      round: roundName,
      formation: lineup.formation,
      captainPlayerId: lineup.captainPlayerId,
      vcPlayerId: lineup.vcPlayerId,
      captainLockedAt: lineup.captainLockedAt,
      vcLockedAt: lineup.vcLockedAt,
      slots,
      isFallback: roundId !== fantasyRoundId,
      fallbackRound: roundId !== fantasyRoundId ? roundName : null,
    };
  }

  return null;
}
