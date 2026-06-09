import "server-only";
import { db } from "@/db";
import {
  drafts, draftOrder, draftPicks, players, nations, leagueMemberships, leagues,
} from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getDraftState } from "./state";
import { leagueSizeFromFormat, pickToRound, resolveDraftPosition } from "./snake";

export type DraftPickDetail = {
  pickNumber: number;
  roundNumber: number;
  /** 1-indexed position within the round (1 = first pick of that round) */
  pickInRound: number;
  /** column index (0-based) in the visual grid — same manager stays in same column */
  colIndex: number;
  managerId: string;
  player: {
    id: string;
    name: string;
    position: "GK" | "DEF" | "MID" | "FWD";
    nationId: string;
    nationFifaCode: string;
    nationName: string;
  };
};

export type DraftManager = {
  membershipId: string;
  displayName: string;
  /** 1-indexed snake-draft position (column header order) */
  draftPosition: number;
};

export type DraftBoardData = {
  draftId: string;
  draftType: "initial" | "redraft";
  status: "pending" | "active" | "paused" | "complete";
  leagueSize: number;
  totalRounds: number;
  totalPicks: number;
  /** Managers in column order (index 0 = position 1 in draft order) */
  managers: DraftManager[];
  picks: DraftPickDetail[];
  onTheClockManagerId: string | null;
  /** null when draft not active */
  expiresAt: Date | null;
  isExpired: boolean;
};

export async function getDraftBoard(
  leagueId: string,
  draftType: "initial" | "redraft"
): Promise<DraftBoardData | null> {
  // Load draft row + clock state (getDraftState handles lazy pending→active)
  let clockState: Awaited<ReturnType<typeof getDraftState>>;
  try {
    clockState = await getDraftState(leagueId, draftType);
  } catch {
    return null; // draft not found
  }

  const { draft, expiresAt, isExpired, onTheClockManagerId } = clockState;

  // League format → size
  const [leagueRow] = await db
    .select({ format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!leagueRow) return null;

  const leagueSize = leagueSizeFromFormat(leagueRow.format);
  const totalRounds = draftType === "initial" ? 14 : 10;
  const totalPicks = totalRounds * leagueSize;

  // Draft order: position → membershipId
  const orderRows = await db
    .select({
      position: draftOrder.position,
      managerId: draftOrder.managerId,
    })
    .from(draftOrder)
    .where(eq(draftOrder.draftId, draft.id))
    .orderBy(asc(draftOrder.position));

  // Membership display names
  const membershipIds = orderRows.map(r => r.managerId);
  const memberRows = await db
    .select({
      id: leagueMemberships.id,
      displayName: leagueMemberships.displayName,
    })
    .from(leagueMemberships)
    .where(eq(leagueMemberships.leagueId, leagueId));

  const displayNameById = new Map(memberRows.map(m => [m.id, m.displayName ?? m.id.slice(0, 8)]));

  const managers: DraftManager[] = orderRows.map(r => ({
    membershipId: r.managerId,
    displayName: displayNameById.get(r.managerId) ?? r.managerId.slice(0, 8),
    draftPosition: r.position,
  }));

  // Position → colIndex (0-based, stable across all rounds)
  const positionToColIndex = new Map(orderRows.map(r => [r.position, r.position - 1]));

  // Pick history with player + nation
  const pickRows = await db
    .select({
      pickNumber: draftPicks.pickNumber,
      managerId: draftPicks.managerId,
      playerId: players.id,
      playerName: players.name,
      position: players.position,
      nationId: players.nationId,
      nationFifaCode: nations.fifaCode,
      nationName: nations.name,
    })
    .from(draftPicks)
    .innerJoin(players, eq(players.id, draftPicks.playerId))
    .innerJoin(nations, eq(nations.id, players.nationId))
    .where(eq(draftPicks.draftId, draft.id))
    .orderBy(asc(draftPicks.pickNumber));

  const picks: DraftPickDetail[] = pickRows.map(r => {
    const { round, pickInRound } = pickToRound(r.pickNumber, leagueSize, totalRounds);
    // resolveDraftPosition returns 1-indexed draft-order position for this pick
    const draftPos = resolveDraftPosition(r.pickNumber, leagueSize, totalRounds);
    const colIndex = positionToColIndex.get(draftPos) ?? draftPos - 1;

    return {
      pickNumber: r.pickNumber,
      roundNumber: round,
      pickInRound,
      colIndex,
      managerId: r.managerId,
      player: {
        id: r.playerId,
        name: r.playerName,
        position: r.position as "GK" | "DEF" | "MID" | "FWD",
        nationId: r.nationId,
        nationFifaCode: r.nationFifaCode,
        nationName: r.nationName,
      },
    };
  });

  return {
    draftId: draft.id,
    draftType: draft.type as "initial" | "redraft",
    status: draft.status as "pending" | "active" | "paused" | "complete",
    leagueSize,
    totalRounds,
    totalPicks,
    managers,
    picks,
    onTheClockManagerId,
    expiresAt,
    isExpired,
  };
}
