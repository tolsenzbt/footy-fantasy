import "server-only";
import { db } from "@/db";
import { leagues, groupStandings, leagueMemberships } from "@/db/schema";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";

// Advancement cutoff by league format: the highest rank that still advances.
// Managers with rank > cutoff are eliminated at group_md3.
//   eight   → top 3 of 4 advance per group (§3: "Top 3 from each group → 6 advance")
//   twelve  → top 2 of 3 advance per group
//   sixteen → top 2 of 4 advance per group
function advancingCutoff(format: "eight" | "twelve" | "sixteen"): number {
  return format === "eight" ? 3 : 2;
}

// Sets leagueMemberships.eliminatedAtRound = 'group_md3' for all managers whose
// final group standing rank exceeds the format's advancement cutoff.
// Called by resolveRound immediately after computeStandings for group_md3.
// Idempotent: the WHERE eliminatedAtRound IS NULL guard makes re-runs safe.
export async function setManagerEliminations(leagueId: string, now: Date): Promise<void> {
  const [league] = await db
    .select({ format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) return;

  const cutoff = advancingCutoff(league.format);

  const eliminatedRows = await db
    .select({ managerId: groupStandings.managerId })
    .from(groupStandings)
    .where(and(
      eq(groupStandings.leagueId, leagueId),
      gt(groupStandings.rank, cutoff),
    ));

  if (eliminatedRows.length === 0) return;

  const managerIds = eliminatedRows.map((r) => r.managerId);

  await db
    .update(leagueMemberships)
    .set({ eliminatedAtRound: "group_md3", updatedAt: now })
    .where(and(
      inArray(leagueMemberships.id, managerIds),
      isNull(leagueMemberships.eliminatedAtRound),
    ));
}
