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
  fantasyRounds,
} from "@/db/schema";
import { eq, and, lte, inArray } from "drizzle-orm";
import {
  processWaivers,
  type WaiverSnapshot,
  type WaiverTransaction,
} from "@/lib/waivers/resolver";
import { applyOwnershipTransition } from "@/lib/waivers/ownership";
import { runMassRelease } from "@/lib/waivers/mass-release";

// Vercel Cron: scheduled daily at 5am ET (10:00 UTC)
// vercel.json: { "crons": [{ "path": "/api/cron/process-waivers", "schedule": "0 10 * * *" }] }

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

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
    massReleaseDropped?: number;
    error?: string;
  }> = [];

  for (const event of pendingEvents) {
    try {
      const stats = await processLeagueWaivers(event.leagueId, event.id, event.fantasyRoundId, now);
      results.push({
        eventId: event.id,
        leagueId: event.leagueId,
        processed: true,
        awards: stats.awards,
        massReleaseDropped: stats.massReleaseDropped,
      });
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
): Promise<{ awards: number; massReleaseDropped?: number }> {
  const [league] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) throw new Error(`League ${leagueId} not found`);

  const phase: "group_stage" | "knockouts" =
    league.status === "knockouts" ? "knockouts" : "group_stage";

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

  await db.transaction(async (tx) => {
    const awardTxs = transactions.filter(
      (t): t is Extract<WaiverTransaction, { type: "award" }> => t.type === "award"
    );
    const failedIds = transactions
      .filter((t) => t.type === "fail" || t.type === "invalid")
      .map((t) => t.claimId);
    const voidedIds = transactions
      .filter((t) => t.type === "void")
      .map((t) => t.claimId);

    // Apply awards via shared ownership helper
    for (const award of awardTxs) {
      await applyOwnershipTransition(
        tx,
        leagueId,
        award.playerId,
        { to: "rostered", managerId: award.managerId, acquiredVia: "waiver" },
        now
      );

      if (award.dropPlayerId) {
        await applyOwnershipTransition(
          tx,
          leagueId,
          award.dropPlayerId,
          {
            to: "on_waivers",
            dropReason: "manager_drop",
            droppedByManagerId: award.managerId,
            eligibleAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
          now
        );
      }

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

    // Update priority order
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

    await resolveRemainingWaivers(
      tx,
      leagueId,
      now,
      availableRows.map((r) => r.playerId),
      awardTxs.map((t) => t.playerId)
    );

    await tx
      .update(waiverProcessingEvents)
      .set({ status: "processed", processedAt: now, updatedAt: now })
      .where(eq(waiverProcessingEvents.id, eventId));
  });

  // Phase 2: mass-release runs after group_md3 normal processing (§8)
  let massReleaseDropped: number | undefined;
  if (league.status === "group_stage") {
    const [roundRow] = await db
      .select({ round: fantasyRounds.round })
      .from(fantasyRounds)
      .where(eq(fantasyRounds.id, fantasyRoundId))
      .limit(1);

    if (roundRow?.round === "group_md3") {
      const result = await runMassRelease(leagueId);
      massReleaseDropped = result.dropped;
    }
  }

  return { awards: transactions.filter((t) => t.type === "award").length, massReleaseDropped };
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

  for (const row of nationRows) {
    if (!row.nextFixtureId || row.eliminatedAtRound) {
      freeAgentIds.push(row.playerId);
    }
    // Nation has another match → leave on_waivers, no change needed
  }

  const foundIds = new Set(nationRows.map((r: { playerId: string }) => r.playerId));
  for (const id of unclaimed) {
    if (!foundIds.has(id)) freeAgentIds.push(id);
  }

  if (freeAgentIds.length > 0) {
    await tx
      .update(waiverPlayerStatus)
      .set({
        status: "free_agent",
        eligibleAt: null,
        dropReason: null,
        droppedByManagerId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(waiverPlayerStatus.leagueId, leagueId),
          inArray(waiverPlayerStatus.playerId, freeAgentIds)
        )
      );
  }
}
