import { db } from "@/db";
import { nations, realFixtures } from "@/db/schema";
import { eq, gt, and, or, isNull } from "drizzle-orm";

// API-Football status codes that mean "not yet started"
const UNPLAYED_STATUSES = new Set(["NS", "TBD"]);

export async function recomputeAllNationStatus(): Promise<{
  set: number;
  cleared: number;
  total: number;
}> {
  const allNations = await db.select().from(nations);
  const now = new Date();

  let set = 0;
  let cleared = 0;

  for (const nation of allNations) {
    // Find the earliest unplayed fixture for this nation
    const upcomingFixtures = await db
      .select({ id: realFixtures.id, kickoffAt: realFixtures.kickoffAt })
      .from(realFixtures)
      .where(
        and(
          or(
            eq(realFixtures.homeNationId, nation.id),
            eq(realFixtures.awayNationId, nation.id)
          ),
          gt(realFixtures.kickoffAt, now)
        )
      )
      .orderBy(realFixtures.kickoffAt)
      .limit(1);

    const nextFixture = upcomingFixtures[0] ?? null;

    await db
      .update(nations)
      .set({ nextFixtureId: nextFixture?.id ?? null, updatedAt: new Date() })
      .where(eq(nations.id, nation.id));

    if (nextFixture) {
      set++;
    } else {
      cleared++;
    }
  }

  return { set, cleared, total: allNations.length };
}
