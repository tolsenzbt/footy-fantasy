import "server-only";
import { db } from "@/db";
import { scheduleSlots, leagueMemberships } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export type SlotAssignment = {
  slotCode: string;
  groupLetter: string;
  positionInGroup: number;
  managerId: string | null;
  displayName: string | null;
};

export type ScheduleGroup = {
  groupLetter: string;
  slots: SlotAssignment[];
};

export type ScheduleSlotsData = {
  groups: ScheduleGroup[];
  /** true if all slots have a managerId assigned */
  isComplete: boolean;
};

export async function getScheduleSlots(leagueId: string): Promise<ScheduleSlotsData> {
  const slotRows = await db
    .select({
      slotCode: scheduleSlots.slotCode,
      groupLetter: scheduleSlots.groupLetter,
      positionInGroup: scheduleSlots.positionInGroup,
      managerId: scheduleSlots.managerId,
    })
    .from(scheduleSlots)
    .where(eq(scheduleSlots.leagueId, leagueId))
    .orderBy(asc(scheduleSlots.groupLetter), asc(scheduleSlots.positionInGroup));

  if (slotRows.length === 0) {
    return { groups: [], isComplete: false };
  }

  // Fetch display names for assigned managers
  const managerIds = slotRows
    .map(r => r.managerId)
    .filter((id): id is string => id !== null);

  const nameMap = new Map<string, string>();
  if (managerIds.length > 0) {
    const memberRows = await db
      .select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, leagueId));
    for (const m of memberRows) {
      nameMap.set(m.id, m.displayName ?? m.id.slice(0, 8));
    }
  }

  const groupMap = new Map<string, SlotAssignment[]>();
  for (const row of slotRows) {
    if (!groupMap.has(row.groupLetter)) groupMap.set(row.groupLetter, []);
    groupMap.get(row.groupLetter)!.push({
      slotCode: row.slotCode,
      groupLetter: row.groupLetter,
      positionInGroup: row.positionInGroup,
      managerId: row.managerId ?? null,
      displayName: row.managerId ? (nameMap.get(row.managerId) ?? null) : null,
    });
  }

  const groups: ScheduleGroup[] = Array.from(groupMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupLetter, slots]) => ({ groupLetter, slots }));

  const isComplete = slotRows.every(r => r.managerId !== null);

  return { groups, isComplete };
}
