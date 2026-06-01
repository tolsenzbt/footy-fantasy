import "server-only";
import { db } from "@/db";
import {
  leagues,
  drafts,
  draftOrder,
  waiverPriority,
  waiverProcessingEvents,
  fantasyRounds,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";

// ── Pure helper ────────────────────────────────────────────────────────────────

// Knockout waiver priority = reverse of the start-of-redraft by-need order (§8).
// Position 1 (most need, picked first in redraft) → lowest knockout priority (N).
// Position N (least need, picked last) → highest knockout priority (1).
// Opted-out managers are included unchanged — their draft slot is preserved per §8.
export function computeKnockoutPriorities(
  orderRows: Array<{ managerId: string; position: number }>
): Array<{ managerId: string; priority: number }> {
  const N = orderRows.length;
  return orderRows.map((row) => ({
    managerId: row.managerId,
    priority: N + 1 - row.position,
  }));
}

// ── completeRedraft ────────────────────────────────────────────────────────────

// Admin action: redrafting → knockouts.
// Fires steps 3–5 of §8 in order within one transaction:
//   3. Record completion (status transition)
//   4. Priority reset (immediately, guarded by priority_reset_completed_at)
//   5. Schedule first knockout waiver processing event at completedAt + 1h
//      (guarded by knockout_first_event_scheduled_at)
//
// All steps are idempotent no-ops on re-entry. Admin corrects errors via direct DB (§13).
export async function completeRedraft(leagueId: string): Promise<void> {
  const [league] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) throw new Error(`League ${leagueId} not found`);
  if (league.status !== "redrafting")
    throw new Error(
      `League must be in redrafting status to complete redraft (got: ${league.status})`
    );

  const [redraft] = await db
    .select({ id: drafts.id, status: drafts.status, completedAt: drafts.completedAt })
    .from(drafts)
    .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "redraft")))
    .limit(1);

  if (!redraft) throw new Error(`No redraft found for league ${leagueId}`);
  if (redraft.status !== "complete")
    throw new Error(`Redraft is not yet complete (status: ${redraft.status})`);

  const now = new Date();
  const completedAt = redraft.completedAt ?? now;

  await db.transaction(async (tx) => {
    const [lockedLeague] = await tx
      .select({
        status: leagues.status,
        priorityResetCompletedAt: leagues.priorityResetCompletedAt,
        knockoutFirstEventScheduledAt: leagues.knockoutFirstEventScheduledAt,
      })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for("update")
      .limit(1);

    if (!lockedLeague || lockedLeague.status !== "redrafting") return;

    // Step 3: transition league to knockouts
    await tx
      .update(leagues)
      .set({ status: "knockouts", updatedAt: now })
      .where(eq(leagues.id, leagueId));

    // Step 4: priority reset — MUST run before step 5
    if (!lockedLeague.priorityResetCompletedAt) {
      const orderRows = await tx
        .select({ managerId: draftOrder.managerId, position: draftOrder.position })
        .from(draftOrder)
        .where(eq(draftOrder.draftId, redraft.id));

      const priorities = computeKnockoutPriorities(orderRows);

      // Delete existing knockout rows first to avoid unique-constraint conflicts
      // on the (leagueId, priority, phase) constraint during bulk insert.
      await tx
        .delete(waiverPriority)
        .where(
          and(
            eq(waiverPriority.leagueId, leagueId),
            eq(waiverPriority.phase, "knockouts")
          )
        );

      for (const { managerId, priority } of priorities) {
        await tx.insert(waiverPriority).values({
          leagueId,
          managerId,
          priority,
          phase: "knockouts",
        });
      }

      await tx
        .update(leagues)
        .set({ priorityResetCompletedAt: now, updatedAt: now })
        .where(eq(leagues.id, leagueId));
    }

    // Step 5: schedule first knockout waiver processing event at completedAt + 1h
    if (!lockedLeague.knockoutFirstEventScheduledAt) {
      const [qfRound] = await tx
        .select({ id: fantasyRounds.id })
        .from(fantasyRounds)
        .where(
          and(
            eq(fantasyRounds.leagueId, leagueId),
            eq(fantasyRounds.round, "qf")
          )
        )
        .limit(1);

      if (!qfRound)
        throw new Error(`QF fantasy round not found for league ${leagueId}`);

      const scheduledAt = new Date(completedAt.getTime() + 60 * 60 * 1000);

      await tx
        .insert(waiverProcessingEvents)
        .values({ leagueId, fantasyRoundId: qfRound.id, scheduledAt, status: "pending" })
        .onConflictDoNothing();

      await tx
        .update(leagues)
        .set({ knockoutFirstEventScheduledAt: now, updatedAt: now })
        .where(eq(leagues.id, leagueId));
    }
  });
}
