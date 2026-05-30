import "server-only";
import { randomInt } from "crypto";
import { db } from "@/db";
import {
  leagues,
  leagueMemberships,
  scheduleSlots,
  fantasyRounds,
  fantasyMatchups,
  drafts,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { SCHEDULE_TEMPLATES } from "./templates";

export async function runGroupDraw(leagueId: string): Promise<{
  slotsAssigned: number;
  groupMatchupsCreated: number;
  knockoutMatchupsCreated: number;
  fantasyRoundsCreated: number;
}> {
  const [league] = await db
    .select()
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) throw new Error(`League ${leagueId} not found.`);
  if (league.status !== "drafting") {
    throw new Error(`League status must be 'drafting', got '${league.status}'.`);
  }

  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "initial")))
    .limit(1);
  if (!draft || draft.status !== "complete") {
    throw new Error("Initial draft must be complete before running the group draw.");
  }

  const [existingSlot] = await db
    .select({ id: scheduleSlots.id })
    .from(scheduleSlots)
    .where(eq(scheduleSlots.leagueId, leagueId))
    .limit(1);
  if (existingSlot) {
    throw new Error(`Group draw already run for league ${leagueId}.`);
  }

  const template = SCHEDULE_TEMPLATES[league.format];

  const memberships = await db
    .select()
    .from(leagueMemberships)
    .where(
      and(
        eq(leagueMemberships.leagueId, leagueId),
        eq(leagueMemberships.role, "manager")
      )
    );

  if (memberships.length !== template.slots.length) {
    throw new Error(
      `Expected ${template.slots.length} managers for format '${league.format}', found ${memberships.length}.`
    );
  }

  // Fisher-Yates shuffle using crypto.randomInt
  const shuffled = [...memberships];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return await db.transaction(async (tx) => {
    await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for("update")
      .limit(1);

    const slotValues = template.slots.map((slotCode, idx) => ({
      leagueId,
      slotCode,
      groupLetter: slotCode[0],
      positionInGroup: parseInt(slotCode.slice(1), 10),
      managerId: shuffled[idx].id,
    }));
    await tx.insert(scheduleSlots).values(slotValues);

    const slotMap = new Map<string, string>(
      slotValues.map(({ slotCode, managerId }) => [slotCode, managerId!])
    );

    const roundIdentifiers = [
      "group_md1",
      "group_md2",
      "group_md3",
      "qf",
      "sf",
      "final",
    ] as const;
    const roundRows = await tx
      .insert(fantasyRounds)
      .values(roundIdentifiers.map((round) => ({ leagueId, round })))
      .returning();

    const roundIdMap = new Map<string, string>(
      roundRows.map((r) => [r.round, r.id])
    );

    const groupMatchupValues = template.groupMatchups.map((m) => ({
      leagueId,
      fantasyRoundId: roundIdMap.get(m.round)!,
      homeManagerId: slotMap.get(m.homeSlot)!,
      awayManagerId: slotMap.get(m.awaySlot)!,
      homeSeedSource: null,
      awaySeedSource: null,
      matchIndex: m.matchIndex,
    }));
    await tx.insert(fantasyMatchups).values(groupMatchupValues);

    const knockoutMatchupValues = template.knockoutMatchups.map((m) => ({
      leagueId,
      fantasyRoundId: roundIdMap.get(m.round)!,
      homeManagerId: null,
      awayManagerId: null,
      homeSeedSource: m.homeSeedSource,
      awaySeedSource: m.awaySeedSource,
      matchIndex: m.matchIndex,
    }));
    await tx.insert(fantasyMatchups).values(knockoutMatchupValues);

    return {
      slotsAssigned: slotValues.length,
      groupMatchupsCreated: groupMatchupValues.length,
      knockoutMatchupsCreated: knockoutMatchupValues.length,
      fantasyRoundsCreated: roundRows.length,
    };
  });
}
