import "server-only";
import { db } from "@/db";
import { drafts, draftPicks, rosters, leagues } from "@/db/schema";
import { players } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDraftState } from "./state";
import { leagueSizeFromFormat } from "./snake";
import { runGroupDraw } from "@/lib/schedule/group-draw";
import { submitRedraftPick } from "./redraft";
import { applyOwnershipTransition } from "@/lib/waivers/ownership";

const INITIAL_DRAFT_ROUNDS = 14;

const POSITION_MAX: Record<string, number> = {
  GK: 2,
  DEF: 5,
  MID: 5,
  FWD: 3,
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export async function submitPick(args: {
  leagueId: string;
  draftType: "initial" | "redraft";
  managerId: string;
  playerId: string;
  droppedPlayerId?: string;
}): Promise<{ pickNumber: number; isFinalPick: boolean }> {
  if (args.draftType === "redraft") {
    const result = await submitRedraftPick({
      leagueId: args.leagueId,
      managerId: args.managerId,
      playerId: args.playerId,
      dropPlayerId: args.droppedPlayerId,
    });
    return result;
  }

  const now = new Date();

  // 1. Draft must be active
  const state = await getDraftState(args.leagueId, "initial");
  if (state.draft.status !== "active") {
    throw new Error(`Draft is not active (status: ${state.draft.status}).`);
  }

  // 2. Caller must be on the clock
  if (args.managerId !== state.onTheClockManagerId) {
    throw new Error(
      `Manager ${args.managerId} is not on the clock (expected ${state.onTheClockManagerId}).`
    );
  }

  // 3. Player must exist and be active
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, args.playerId))
    .limit(1);

  if (!player) {
    throw new Error(`Player ${args.playerId} does not exist.`);
  }
  if (!player.active) {
    throw new Error(`Player ${args.playerId} is inactive and cannot be drafted.`);
  }

  // 4. Player must not already be rostered
  const [existingRoster] = await db
    .select()
    .from(rosters)
    .where(and(eq(rosters.leagueId, args.leagueId), eq(rosters.playerId, args.playerId)))
    .limit(1);

  if (existingRoster) {
    throw new Error(`Player ${args.playerId} is already on a roster in this league.`);
  }

  // 5. Position-max check
  const currentRosterRows = await db
    .select({ fantasyPosition: players.fantasyPosition })
    .from(rosters)
    .innerJoin(players, eq(rosters.playerId, players.id))
    .where(and(eq(rosters.leagueId, args.leagueId), eq(rosters.managerId, args.managerId)));

  const positionCounts: Record<string, number> = {};
  for (const row of currentRosterRows) {
    positionCounts[row.fantasyPosition] = (positionCounts[row.fantasyPosition] ?? 0) + 1;
  }
  const newPositionCount = (positionCounts[player.fantasyPosition] ?? 0) + 1;
  const positionMax = POSITION_MAX[player.fantasyPosition];
  if (newPositionCount > positionMax) {
    throw new Error(
      `Picking ${player.name} would give manager ${args.managerId} ${newPositionCount} ${player.fantasyPosition}s, exceeding the maximum of ${positionMax}.`
    );
  }

  // 6. Clock expired is a flag, not a rejection
  const clockExpired =
    state.draft.currentPickStartedAt !== null &&
    now > new Date(state.draft.currentPickStartedAt.getTime() + state.draft.pickClockSeconds * 1000);

  // 7. droppedPlayerId is ignored for initial drafts
  if (args.droppedPlayerId) {
    console.warn(
      `submitPick: droppedPlayerId ignored for initial draft (pick ${state.draft.currentPickNumber}).`
    );
  }

  // Compute total picks from league format
  const [league] = await db
    .select({ format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, args.leagueId))
    .limit(1);

  if (!league) throw new Error(`League ${args.leagueId} not found.`);

  const leagueSize = leagueSizeFromFormat(league.format);
  const totalPicks = INITIAL_DRAFT_ROUNDS * leagueSize;
  const pickNumber = state.draft.currentPickNumber!;
  const isFinalPick = pickNumber === totalPicks;

  // 8. Transactional write — FOR UPDATE on drafts prevents concurrent double-picks
  let alreadyTaken = false;
  try {
    await db.transaction(async (tx) => {
      const [lockedDraft] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.leagueId, args.leagueId), eq(drafts.type, "initial")))
        .for("update")
        .limit(1);

      if (!lockedDraft || lockedDraft.status !== "active") {
        throw new Error("Draft is no longer active.");
      }
      if (lockedDraft.currentPickNumber !== pickNumber) {
        alreadyTaken = true;
        return; // concurrent pick won — don't throw, let caller see pickNumber=0
      }

      await tx.insert(draftPicks).values({
        draftId: lockedDraft.id,
        pickNumber,
        managerId: args.managerId,
        playerId: args.playerId,
        droppedPlayerId: null,
        clockExpired,
      });

      await applyOwnershipTransition(
        tx,
        args.leagueId,
        args.playerId,
        { to: "rostered", managerId: args.managerId, acquiredVia: "initial_draft" },
        now,
      );

      if (isFinalPick) {
        await tx
          .update(drafts)
          .set({
            status: "complete",
            currentPickNumber: null,
            currentPickStartedAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(drafts.id, lockedDraft.id));
        // leagues.status stays 'drafting' — it advances to 'group_stage' via a
        // separate cron/event when the group stage actually begins.
      } else {
        await tx
          .update(drafts)
          .set({
            currentPickNumber: pickNumber + 1,
            currentPickStartedAt: now,
            updatedAt: now,
          })
          .where(eq(drafts.id, lockedDraft.id));
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { pickNumber: 0, isFinalPick: false };
    throw err;
  }

  if (alreadyTaken) return { pickNumber: 0, isFinalPick: false };

  if (isFinalPick) {
    runGroupDraw(args.leagueId).catch((err) => {
      console.error("runGroupDraw failed after final pick:", err);
    });
  }

  return { pickNumber, isFinalPick };
}
