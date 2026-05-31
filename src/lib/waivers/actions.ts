import "server-only";
import { db } from "@/db";
import {
  rosters,
  waiverClaims,
  waiverPlayerStatus,
  waiverPriority,
  leagues,
  leagueMemberships,
  players,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function requireActiveLeague(leagueId: string) {
  const [league] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) throw new Error(`League ${leagueId} not found`);
  if (league.status === "setup" || league.status === "drafting") {
    throw new Error(`Waivers not open in league status: ${league.status}`);
  }
  return league;
}

async function requireRosterMembership(leagueId: string, managerId: string) {
  const [membership] = await db
    .select({ id: leagueMemberships.id })
    .from(leagueMemberships)
    .where(
      and(
        eq(leagueMemberships.id, managerId),
        eq(leagueMemberships.leagueId, leagueId)
      )
    )
    .limit(1);
  if (!membership) {
    throw new Error(`Manager ${managerId} not in league ${leagueId}`);
  }
}

function getManagerPriority(leagueId: string, managerId: string, phase: "group_stage" | "knockouts") {
  return db
    .select({ priority: waiverPriority.priority })
    .from(waiverPriority)
    .where(
      and(
        eq(waiverPriority.leagueId, leagueId),
        eq(waiverPriority.managerId, managerId),
        eq(waiverPriority.phase, phase)
      )
    )
    .limit(1);
}

// ── submitWaiverClaim ──────────────────────────────────────────────────────────

export type SubmitWaiverClaimArgs = {
  leagueId: string;
  managerId: string;
  playerId: string;
  dropPlayerId?: string;
  rank: number;
  phase: "group_stage" | "knockouts";
};

export type SubmitWaiverClaimResult = {
  claimId: string;
  playerId: string;
  dropPlayerId: string | null;
  rank: number;
  priorityAtSubmit: number;
};

export async function submitWaiverClaim(
  args: SubmitWaiverClaimArgs
): Promise<SubmitWaiverClaimResult> {
  const { leagueId, managerId, playerId, dropPlayerId, rank, phase } = args;

  await requireActiveLeague(leagueId);
  await requireRosterMembership(leagueId, managerId);

  // Player must be on waivers
  const [playerStatus] = await db
    .select({ status: waiverPlayerStatus.status })
    .from(waiverPlayerStatus)
    .where(
      and(
        eq(waiverPlayerStatus.leagueId, leagueId),
        eq(waiverPlayerStatus.playerId, playerId)
      )
    )
    .limit(1);

  if (!playerStatus || playerStatus.status !== "on_waivers") {
    throw new Error(
      `Player ${playerId} is not on waivers in league ${leagueId}`
    );
  }

  // Conditional drop: must be on manager's roster
  if (dropPlayerId) {
    const [dropRoster] = await db
      .select({ id: rosters.id })
      .from(rosters)
      .where(
        and(
          eq(rosters.leagueId, leagueId),
          eq(rosters.managerId, managerId),
          eq(rosters.playerId, dropPlayerId)
        )
      )
      .limit(1);
    if (!dropRoster) {
      throw new Error(
        `Drop player ${dropPlayerId} is not on manager ${managerId}'s roster`
      );
    }
  }

  // Get manager's current waiver priority for audit
  const [priorityRow] = await getManagerPriority(leagueId, managerId, phase);
  if (!priorityRow) {
    throw new Error(
      `No waiver priority found for manager ${managerId} in phase ${phase}`
    );
  }

  const [claim] = await db
    .insert(waiverClaims)
    .values({
      leagueId,
      managerId,
      playerId,
      dropPlayerId: dropPlayerId ?? null,
      rank,
      priorityAtSubmit: priorityRow.priority,
      status: "pending",
    })
    .returning({
      id: waiverClaims.id,
      playerId: waiverClaims.playerId,
      dropPlayerId: waiverClaims.dropPlayerId,
      rank: waiverClaims.rank,
      priorityAtSubmit: waiverClaims.priorityAtSubmit,
    });

  return {
    claimId: claim.id,
    playerId: claim.playerId,
    dropPlayerId: claim.dropPlayerId,
    rank: claim.rank,
    priorityAtSubmit: claim.priorityAtSubmit,
  };
}

// ── dropPlayer ────────────────────────────────────────────────────────────────

export type DropPlayerArgs = {
  leagueId: string;
  managerId: string;
  playerId: string;
};

export async function dropPlayer(args: DropPlayerArgs): Promise<void> {
  const { leagueId, managerId, playerId } = args;

  await requireActiveLeague(leagueId);
  await requireRosterMembership(leagueId, managerId);

  await db.transaction(async (tx) => {
    // Verify player is on this manager's roster
    const [rosterRow] = await tx
      .select({ id: rosters.id })
      .from(rosters)
      .where(
        and(
          eq(rosters.leagueId, leagueId),
          eq(rosters.managerId, managerId),
          eq(rosters.playerId, playerId)
        )
      )
      .limit(1);

    if (!rosterRow) {
      throw new Error(
        `Player ${playerId} is not on manager ${managerId}'s roster`
      );
    }

    // Remove from roster
    await tx
      .delete(rosters)
      .where(
        and(
          eq(rosters.leagueId, leagueId),
          eq(rosters.managerId, managerId),
          eq(rosters.playerId, playerId)
        )
      );

    const now = new Date();
    const eligibleAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h minimum

    // Upsert waiver status: player goes on waivers with 24h window
    await tx
      .insert(waiverPlayerStatus)
      .values({
        leagueId,
        playerId,
        status: "on_waivers",
        eligibleAt,
      })
      .onConflictDoUpdate({
        target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
        set: {
          status: "on_waivers",
          eligibleAt,
          updatedAt: now,
        },
      });
  });
}

// ── pickupFreeAgent ───────────────────────────────────────────────────────────

export type PickupFreeAgentArgs = {
  leagueId: string;
  managerId: string;
  playerId: string;
  dropPlayerId?: string; // required if roster is full
};

export async function pickupFreeAgent(
  args: PickupFreeAgentArgs
): Promise<void> {
  const { leagueId, managerId, playerId, dropPlayerId } = args;

  await requireActiveLeague(leagueId);
  await requireRosterMembership(leagueId, managerId);

  await db.transaction(async (tx) => {
    // Player must be a free agent
    const [status] = await tx
      .select({ status: waiverPlayerStatus.status })
      .from(waiverPlayerStatus)
      .where(
        and(
          eq(waiverPlayerStatus.leagueId, leagueId),
          eq(waiverPlayerStatus.playerId, playerId)
        )
      )
      .limit(1);

    if (!status || status.status !== "free_agent") {
      throw new Error(
        `Player ${playerId} is not a free agent in league ${leagueId}`
      );
    }

    // Roster size check
    const rosterRows = await tx
      .select({ id: rosters.id })
      .from(rosters)
      .where(
        and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId))
      );

    const rosterSize = rosterRows.length;

    if (rosterSize >= 14 && !dropPlayerId) {
      throw new Error(
        `Roster is full (14). Specify a drop player for FCFS pickup.`
      );
    }

    // Conditional drop first
    if (dropPlayerId) {
      const [dropRow] = await tx
        .select({ id: rosters.id })
        .from(rosters)
        .where(
          and(
            eq(rosters.leagueId, leagueId),
            eq(rosters.managerId, managerId),
            eq(rosters.playerId, dropPlayerId)
          )
        )
        .limit(1);

      if (!dropRow) {
        throw new Error(
          `Drop player ${dropPlayerId} is not on manager ${managerId}'s roster`
        );
      }

      await tx
        .delete(rosters)
        .where(
          and(
            eq(rosters.leagueId, leagueId),
            eq(rosters.managerId, managerId),
            eq(rosters.playerId, dropPlayerId)
          )
        );

      // Put dropped player on waivers (24h window)
      const now = new Date();
      await tx
        .insert(waiverPlayerStatus)
        .values({
          leagueId,
          playerId: dropPlayerId,
          status: "on_waivers",
          eligibleAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        })
        .onConflictDoUpdate({
          target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
          set: {
            status: "on_waivers",
            eligibleAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            updatedAt: now,
          },
        });
    }

    // Add to roster
    await tx.insert(rosters).values({
      leagueId,
      managerId,
      playerId,
      acquiredVia: "free_agent",
    });

    // Update player status to rostered
    const now = new Date();
    await tx
      .insert(waiverPlayerStatus)
      .values({
        leagueId,
        playerId,
        status: "rostered",
      })
      .onConflictDoUpdate({
        target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
        set: {
          status: "rostered",
          eligibleAt: null,
          updatedAt: now,
        },
      });
  });
}
