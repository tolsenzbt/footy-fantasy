import "server-only";
import { db } from "@/db";
import { leagues, leagueMemberships, rosters, players, nations } from "@/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { applyOwnershipTransition } from "./ownership";

export type MassReleaseResult = {
  dropped: number;
};

// Runs as the second phase of the final group-stage waiver cron (§8).
// Auto-drops players from non-advancing nations on ADVANCING managers' rosters only.
// Eliminated managers' rosters are untouched.
// Idempotent: guarded by leagues.mass_release_completed_at.
export async function runMassRelease(leagueId: string): Promise<MassReleaseResult> {
  const [league] = await db
    .select({ massReleaseCompletedAt: leagues.massReleaseCompletedAt })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) throw new Error(`League ${leagueId} not found`);
  if (league.massReleaseCompletedAt !== null) return { dropped: 0 };

  const now = new Date();
  let dropped = 0;

  await db.transaction(async (tx) => {
    // Re-read inside transaction to guard against concurrent invocations
    const [lockedLeague] = await tx
      .select({ massReleaseCompletedAt: leagues.massReleaseCompletedAt })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for("update")
      .limit(1);

    if (!lockedLeague || lockedLeague.massReleaseCompletedAt !== null) return;

    // Advancing managers: not eliminated
    const advancingManagers = await tx
      .select({ id: leagueMemberships.id })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, leagueId),
          isNull(leagueMemberships.eliminatedAtRound)
        )
      );

    if (advancingManagers.length === 0) {
      await tx
        .update(leagues)
        .set({ massReleaseCompletedAt: now, updatedAt: now })
        .where(eq(leagues.id, leagueId));
      return;
    }

    const advancingIds = advancingManagers.map((m) => m.id);

    // Rostered players from eliminated nations on advancing managers
    const dropsNeeded = await tx
      .select({
        managerId: rosters.managerId,
        playerId: rosters.playerId,
      })
      .from(rosters)
      .innerJoin(players, eq(rosters.playerId, players.id))
      .innerJoin(nations, eq(players.nationId, nations.id))
      .where(
        and(
          eq(rosters.leagueId, leagueId),
          inArray(rosters.managerId, advancingIds),
          isNotNull(nations.eliminatedAtRound)
        )
      );

    for (const { managerId, playerId } of dropsNeeded) {
      await applyOwnershipTransition(
        tx,
        leagueId,
        playerId,
        {
          to: "on_waivers",
          dropReason: "mass_release",
          droppedByManagerId: managerId,
          eligibleAt: now,
        },
        now
      );
      dropped++;
    }

    await tx
      .update(leagues)
      .set({ massReleaseCompletedAt: now, updatedAt: now })
      .where(eq(leagues.id, leagueId));
  });

  return { dropped };
}
