import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import {
  waiverProcessingEvents,
  waiverClaims,
  waiverPlayerStatus,
  waiverPriority,
  rosters,
  leagues,
  players,
  nations,
} from "@/db/schema";
import { eq, and, lte, inArray } from "drizzle-orm";
import {
  processWaivers,
  type WaiverSnapshot,
  type WaiverTransaction,
} from "@/lib/waivers/resolver";

// Vercel Cron: scheduled daily at 5am ET (10:00 UTC)
// vercel.json: { "crons": [{ "path": "/api/cron/process-waivers", "schedule": "0 10 * * *" }] }

export async function GET(req: NextRequest) {
  // Verify Vercel Cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Find all pending processing events due now
  const pendingEvents = await db
    .select({
      id: waiverProcessingEvents.id,
      leagueId: waiverProcessingEvents.leagueId,
      fantasyRoundId: waiverProcessingEvents.fantasyRoundId,
      scheduledAt: waiverProcessingEvents.scheduledAt,
    })
    .from(waiverProcessingEvents)
    .where(
      and(
        eq(waiverProcessingEvents.status, "pending"),
        lte(waiverProcessingEvents.scheduledAt, now)
      )
    );

  const results: Array<{
    eventId: string;
    leagueId: string;
    processed: boolean;
    awards: number;
    error?: string;
  }> = [];

  for (const event of pendingEvents) {
    try {
      const stats = await processLeagueWaivers(event.leagueId, event.id, event.fantasyRoundId, now);
      results.push({ eventId: event.id, leagueId: event.leagueId, processed: true, awards: stats.awards });
    } catch (err) {
      console.error(`Error processing waivers for league ${event.leagueId}:`, err);
      results.push({
        eventId: event.id,
        leagueId: event.leagueId,
        processed: false,
        awards: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}

async function processLeagueWaivers(
  leagueId: string,
  eventId: string,
  fantasyRoundId: string,
  now: Date
): Promise<{ awards: number }> {
  // Get league phase for priority lookup
  const [league] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) throw new Error(`League ${leagueId} not found`);

  const phase: "group_stage" | "knockouts" =
    league.status === "knockouts" ? "knockouts" : "group_stage";

  // Build snapshot
  const [priorityRows, claimRows, rosterRows, availableRows] =
    await Promise.all([
      db
        .select({ managerId: waiverPriority.managerId, priority: waiverPriority.priority })
        .from(waiverPriority)
        .where(
          and(
            eq(waiverPriority.leagueId, leagueId),
            eq(waiverPriority.phase, phase)
          )
        ),
      db
        .select({
          id: waiverClaims.id,
          managerId: waiverClaims.managerId,
          playerId: waiverClaims.playerId,
          dropPlayerId: waiverClaims.dropPlayerId,
          rank: waiverClaims.rank,
        })
        .from(waiverClaims)
        .where(
          and(
            eq(waiverClaims.leagueId, leagueId),
            eq(waiverClaims.status, "pending")
          )
        ),
      db
        .select({ managerId: rosters.managerId, playerId: rosters.playerId })
        .from(rosters)
        .where(eq(rosters.leagueId, leagueId)),
      db
        .select({ playerId: waiverPlayerStatus.playerId })
        .from(waiverPlayerStatus)
        .where(
          and(
            eq(waiverPlayerStatus.leagueId, leagueId),
            eq(waiverPlayerStatus.status, "on_waivers"),
            lte(waiverPlayerStatus.eligibleAt, now)
          )
        ),
    ]);

  // Build rosters map
  const rostersByManager = new Map<string, Set<string>>();
  for (const { managerId, playerId } of rosterRows) {
    if (!rostersByManager.has(managerId)) {
      rostersByManager.set(managerId, new Set());
    }
    rostersByManager.get(managerId)!.add(playerId);
  }

  const snapshot: WaiverSnapshot = {
    priorityOrder: priorityRows,
    claims: claimRows,
    rosters: rostersByManager,
    availablePlayers: new Set(availableRows.map((r) => r.playerId)),
    maxRosterSize: 14,
  };

  const { transactions, finalPriorityOrder } = processWaivers(snapshot);

  // Apply results in a transaction
  await db.transaction(async (tx) => {
    const awardTxs = transactions.filter(
      (t): t is Extract<WaiverTransaction, { type: "award" }> => t.type === "award"
    );
    const nonAwardClaimIds = transactions
      .filter((t) => t.type !== "award")
      .map((t) => t.claimId);

    // 1. Apply awards
    for (const award of awardTxs) {
      // Add awarded player to roster
      await tx.insert(rosters).values({
        leagueId,
        managerId: award.managerId,
        playerId: award.playerId,
        acquiredVia: "waiver",
      });

      // Mark player as rostered
      await tx
        .insert(waiverPlayerStatus)
        .values({ leagueId, playerId: award.playerId, status: "rostered" })
        .onConflictDoUpdate({
          target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
          set: { status: "rostered", eligibleAt: null, updatedAt: now },
        });

      // Execute conditional drop
      if (award.dropPlayerId) {
        await tx
          .delete(rosters)
          .where(
            and(
              eq(rosters.leagueId, leagueId),
              eq(rosters.managerId, award.managerId),
              eq(rosters.playerId, award.dropPlayerId)
            )
          );

        // Dropped player goes on waivers
        const eligibleAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        await tx
          .insert(waiverPlayerStatus)
          .values({
            leagueId,
            playerId: award.dropPlayerId,
            status: "on_waivers",
            eligibleAt,
          })
          .onConflictDoUpdate({
            target: [waiverPlayerStatus.leagueId, waiverPlayerStatus.playerId],
            set: { status: "on_waivers", eligibleAt, updatedAt: now },
          });
      }

      // Mark claim as processed_success
      await tx
        .update(waiverClaims)
        .set({
          status: "processed_success",
          processedAt: now,
          processingEventId: eventId,
          updatedAt: now,
        })
        .where(eq(waiverClaims.id, award.claimId));
    }

    // 2. Mark non-award claims
    if (nonAwardClaimIds.length > 0) {
      // fail/invalid → processed_failed; void → voided
      const failedIds = transactions
        .filter((t) => t.type === "fail" || t.type === "invalid")
        .map((t) => t.claimId);
      const voidedIds = transactions
        .filter((t) => t.type === "void")
        .map((t) => t.claimId);

      if (failedIds.length > 0) {
        await tx
          .update(waiverClaims)
          .set({
            status: "processed_failed",
            processedAt: now,
            processingEventId: eventId,
            failureReason: "not_available_or_invalid",
            updatedAt: now,
          })
          .where(inArray(waiverClaims.id, failedIds));
      }

      if (voidedIds.length > 0) {
        await tx
          .update(waiverClaims)
          .set({
            status: "voided",
            processedAt: now,
            processingEventId: eventId,
            failureReason: "drop_already_used",
            updatedAt: now,
          })
          .where(inArray(waiverClaims.id, voidedIds));
      }
    }

    // 3. Update priority order
    for (const entry of finalPriorityOrder) {
      await tx
        .update(waiverPriority)
        .set({ priority: entry.priority, updatedAt: now })
        .where(
          and(
            eq(waiverPriority.leagueId, leagueId),
            eq(waiverPriority.managerId, entry.managerId),
            eq(waiverPriority.phase, phase)
          )
        );
    }

    // 4. Resolve remaining on-waivers players (no claims this round)
    await resolveRemainingWaivers(tx, leagueId, now, availableRows.map(r => r.playerId), awardTxs.map(t => t.playerId));

    // 5. Mark processing event as done
    await tx
      .update(waiverProcessingEvents)
      .set({ status: "processed", processedAt: now, updatedAt: now })
      .where(eq(waiverProcessingEvents.id, eventId));
  });

  return { awards: transactions.filter((t) => t.type === "award").length };
}

async function resolveRemainingWaivers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  leagueId: string,
  now: Date,
  eligiblePlayerIds: string[],
  awardedPlayerIds: string[]
) {
  const awardedSet = new Set(awardedPlayerIds);
  const unclaimed = eligiblePlayerIds.filter((id) => !awardedSet.has(id));
  if (unclaimed.length === 0) return;

  // Check nation status for unclaimed players
  const nationRows = await tx
    .select({
      playerId: players.id,
      nextFixtureId: nations.nextFixtureId,
      eliminatedAtRound: nations.eliminatedAtRound,
    })
    .from(players)
    .innerJoin(nations, eq(players.nationId, nations.id))
    .where(inArray(players.id, unclaimed));

  const freeAgentIds: string[] = [];
  const reWaiverIds: string[] = [];

  for (const row of nationRows) {
    if (row.nextFixtureId && !row.eliminatedAtRound) {
      // Nation has another match: player re-enters waivers for next round
      reWaiverIds.push(row.playerId);
    } else {
      // Nation eliminated or no more matches: player becomes free agent
      freeAgentIds.push(row.playerId);
    }
  }

  // Players not found in nationRows (data issue): default to free agent
  const foundIds = new Set(nationRows.map((r: { playerId: string }) => r.playerId));
  for (const id of unclaimed) {
    if (!foundIds.has(id)) freeAgentIds.push(id);
  }

  if (freeAgentIds.length > 0) {
    await tx
      .update(waiverPlayerStatus)
      .set({ status: "free_agent", eligibleAt: null, updatedAt: now })
      .where(
        and(
          eq(waiverPlayerStatus.leagueId, leagueId),
          inArray(waiverPlayerStatus.playerId, freeAgentIds)
        )
      );
  }

  // For re-waiver players: leave status as on_waivers; eligibleAt will be set
  // when the next processing event is scheduled. No-op here.
}
