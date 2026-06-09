import "server-only";
import { db } from "@/db";
import { rosters, lineups, lineupSlots } from "@/db/schema/roster";
import { players, nations, realFixtures } from "@/db/schema/tournament";
import { eq, and } from "drizzle-orm";
import { validateLineup, type RosterPlayer, type PreviousLineup } from "./validate";

export type SetLineupArgs = {
  leagueId: string;
  managerId: string;
  fantasyRoundId: string;
  formation: string;
  starterPlayerIds: string[];
  benchPlayerIds: string[];
  captainPlayerId: string;
  vcPlayerId: string | null;
};

export type SetLineupResult = {
  lineupId: string;
  formation: string;
  captainPlayerId: string;
  vcPlayerId: string | null;
  starters: Array<{ playerId: string; lockedAt: Date | null }>;
  bench: Array<{ playerId: string; lockedAt: Date | null }>;
};

export async function setLineup(args: SetLineupArgs): Promise<SetLineupResult> {
  return db.transaction(async (tx) => {
    // Fetch roster with nation kickoff times
    const rosterRows = await tx
      .select({
        playerId: players.id,
        position: players.position,
        nationKickoffAt: realFixtures.kickoffAt,
      })
      .from(rosters)
      .innerJoin(players, eq(players.id, rosters.playerId))
      .innerJoin(nations, eq(nations.id, players.nationId))
      .leftJoin(realFixtures, eq(realFixtures.id, nations.nextFixtureId))
      .where(and(eq(rosters.leagueId, args.leagueId), eq(rosters.managerId, args.managerId)));

    const rosterPlayers: RosterPlayer[] = rosterRows.map(r => ({
      playerId: r.playerId,
      position: r.position,
      nationKickoffAt: r.nationKickoffAt ?? null,
    }));

    // Fetch existing lineup with row-level lock
    const existingRows = await tx
      .select()
      .from(lineups)
      .where(and(
        eq(lineups.leagueId, args.leagueId),
        eq(lineups.managerId, args.managerId),
        eq(lineups.fantasyRoundId, args.fantasyRoundId),
      ))
      .for("update");

    const existing = existingRows[0] ?? null;

    let prev: PreviousLineup | null = null;
    if (existing) {
      const slots = await tx
        .select({
          playerId: lineupSlots.playerId,
          slotType: lineupSlots.slotType,
          lockedAt: lineupSlots.lockedAt,
        })
        .from(lineupSlots)
        .where(eq(lineupSlots.lineupId, existing.id));
      prev = {
        captainPlayerId: existing.captainPlayerId,
        vcPlayerId: existing.vcPlayerId,
        captainLockedAt: existing.captainLockedAt,
        vcLockedAt: existing.vcLockedAt,
        slots,
      };
    }

    const result = validateLineup(
      {
        formation: args.formation,
        starterPlayerIds: args.starterPlayerIds,
        benchPlayerIds: args.benchPlayerIds,
        captainPlayerId: args.captainPlayerId,
        vcPlayerId: args.vcPlayerId,
      },
      rosterPlayers,
      prev,
      new Date()
    );

    if (!result.ok) throw new Error(result.error);

    // Upsert lineup row
    let lineupId: string;
    if (existing) {
      const captainChanged = args.captainPlayerId !== existing.captainPlayerId;
      const vcChanged = args.vcPlayerId !== existing.vcPlayerId;
      await tx
        .update(lineups)
        .set({
          formation: args.formation,
          captainPlayerId: args.captainPlayerId,
          vcPlayerId: args.vcPlayerId,
          captainLockedAt: captainChanged ? null : existing.captainLockedAt,
          vcLockedAt: vcChanged ? null : existing.vcLockedAt,
          updatedAt: new Date(),
        })
        .where(eq(lineups.id, existing.id));
      lineupId = existing.id;
    } else {
      const [inserted] = await tx
        .insert(lineups)
        .values({
          leagueId: args.leagueId,
          managerId: args.managerId,
          fantasyRoundId: args.fantasyRoundId,
          formation: args.formation,
          captainPlayerId: args.captainPlayerId,
          vcPlayerId: args.vcPlayerId,
        })
        .returning({ id: lineups.id });
      lineupId = inserted.id;
    }

    // Rebuild slots: delete existing, re-insert preserving lockedAt for locked players
    if (existing) {
      await tx.delete(lineupSlots).where(eq(lineupSlots.lineupId, lineupId));
    }

    const prevSlotMap = new Map(prev?.slots.map(s => [s.playerId, s]) ?? []);
    const allSlots = [
      ...args.starterPlayerIds.map(id => ({ playerId: id, slotType: "starter" as const })),
      ...args.benchPlayerIds.map(id => ({ playerId: id, slotType: "bench" as const })),
    ];

    const insertedSlots = await tx
      .insert(lineupSlots)
      .values(
        allSlots.map(s => ({
          lineupId,
          playerId: s.playerId,
          slotType: s.slotType,
          lockedAt: prevSlotMap.get(s.playerId)?.lockedAt ?? null,
        }))
      )
      .returning({
        playerId: lineupSlots.playerId,
        slotType: lineupSlots.slotType,
        lockedAt: lineupSlots.lockedAt,
      });

    return {
      lineupId,
      formation: args.formation,
      captainPlayerId: args.captainPlayerId,
      vcPlayerId: args.vcPlayerId,
      starters: insertedSlots
        .filter(s => s.slotType === "starter")
        .map(s => ({ playerId: s.playerId, lockedAt: s.lockedAt })),
      bench: insertedSlots
        .filter(s => s.slotType === "bench")
        .map(s => ({ playerId: s.playerId, lockedAt: s.lockedAt })),
    };
  });
}
