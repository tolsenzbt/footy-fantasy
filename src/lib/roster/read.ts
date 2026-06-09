import "server-only";
import { db } from "@/db";
import { rosters, players, nations } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const POSITION_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 } as const;

export type RosterPlayer = {
  playerId: string;
  playerName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  nationId: string;
  nationFifaCode: string;
  nationIsoCode: string | null;
  nationName: string;
  acquiredVia: "initial_draft" | "redraft" | "waiver" | "free_agent";
};

export type RosterData = {
  managerId: string;
  players: RosterPlayer[];
};

export async function getRoster(
  leagueId: string,
  managerId: string
): Promise<RosterData> {
  const rows = await db
    .select({
      playerId: players.id,
      playerName: players.name,
      position: players.position,
      nationId: players.nationId,
      nationFifaCode: nations.fifaCode,
      nationIsoCode: nations.isoCode,
      nationName: nations.name,
      acquiredVia: rosters.acquiredVia,
    })
    .from(rosters)
    .innerJoin(players, eq(players.id, rosters.playerId))
    .innerJoin(nations, eq(nations.id, players.nationId))
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId)));

  const sorted = rows
    .map(r => ({
      playerId: r.playerId,
      playerName: r.playerName,
      position: r.position as "GK" | "DEF" | "MID" | "FWD",
      nationId: r.nationId,
      nationFifaCode: r.nationFifaCode,
      nationIsoCode: r.nationIsoCode ?? null,
      nationName: r.nationName,
      acquiredVia: r.acquiredVia as RosterPlayer["acquiredVia"],
    }))
    .sort((a, b) => POSITION_ORDER[a.position] - POSITION_ORDER[b.position]);

  return { managerId, players: sorted };
}
