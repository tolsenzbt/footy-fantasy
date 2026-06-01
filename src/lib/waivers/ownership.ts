import "server-only";
import { rosters, waiverPlayerStatus } from "@/db/schema";
import { and, eq } from "drizzle-orm";

// Shared helper for the §10 dual-write ownership invariant.
// Every ownership transition — award, drop, FCFS pickup, redraft pick, mass-release —
// MUST flow through here so rosters and waiver_player_status never disagree.

type RosteredTransition = {
  to: "rostered";
  managerId: string;
  acquiredVia: "initial_draft" | "redraft" | "waiver" | "free_agent";
};

type WaiversTransition = {
  to: "on_waivers";
  dropReason: "mass_release" | "manager_drop" | null;
  droppedByManagerId?: string;
  eligibleAt?: Date;
};

type FreeAgentTransition = {
  to: "free_agent";
};

export type OwnershipTransition =
  | RosteredTransition
  | WaiversTransition
  | FreeAgentTransition;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyOwnershipTransition(
  tx: any,
  leagueId: string,
  playerId: string,
  transition: OwnershipTransition,
  now = new Date()
): Promise<void> {
  if (transition.to === "rostered") {
    await tx.insert(rosters).values({
      leagueId,
      managerId: transition.managerId,
      playerId,
      acquiredVia: transition.acquiredVia,
    });

    await tx
      .insert(waiverPlayerStatus)
      .values({ leagueId, playerId, status: "rostered" })
      .onConflictDoUpdate({
        target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
        set: {
          status: "rostered",
          eligibleAt: null,
          dropReason: null,
          droppedByManagerId: null,
          updatedAt: now,
        },
      });
    return;
  }

  if (transition.to === "on_waivers") {
    // Remove any existing roster row for this player in the league (invariant: at most one)
    await tx
      .delete(rosters)
      .where(and(eq(rosters.leagueId, leagueId), eq(rosters.playerId, playerId)));

    await tx
      .insert(waiverPlayerStatus)
      .values({
        leagueId,
        playerId,
        status: "on_waivers",
        eligibleAt: transition.eligibleAt ?? null,
        dropReason: transition.dropReason ?? null,
        droppedByManagerId: transition.droppedByManagerId ?? null,
      })
      .onConflictDoUpdate({
        target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
        set: {
          status: "on_waivers",
          eligibleAt: transition.eligibleAt ?? null,
          dropReason: transition.dropReason ?? null,
          droppedByManagerId: transition.droppedByManagerId ?? null,
          updatedAt: now,
        },
      });
    return;
  }

  // free_agent
  await tx
    .delete(rosters)
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.playerId, playerId)));

  await tx
    .insert(waiverPlayerStatus)
    .values({ leagueId, playerId, status: "free_agent" })
    .onConflictDoUpdate({
      target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
      set: {
        status: "free_agent",
        eligibleAt: null,
        dropReason: null,
        droppedByManagerId: null,
        updatedAt: now,
      },
    });
}
