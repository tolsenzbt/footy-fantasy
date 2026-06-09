/**
 * Deletes a league and all its dependent rows (for dev cleanup).
 * Usage: tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/cleanup-league.ts <leagueId>
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import {
  leagues, drafts, draftOrder, draftPicks, leagueMemberships,
  rosters, waiverPlayerStatus, scheduleSlots, groupStandings,
  fantasyRounds, fantasyMatchups,
} from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) { console.error("Usage: cleanup-league.ts <leagueId>"); process.exit(1); }

  const draftRows = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.leagueId, leagueId));
  const draftIds = draftRows.map(d => d.id);

  if (draftIds.length > 0) {
    await db.delete(draftPicks).where(inArray(draftPicks.draftId, draftIds));
    await db.delete(draftOrder).where(inArray(draftOrder.draftId, draftIds));
  }
  await db.delete(drafts).where(eq(drafts.leagueId, leagueId));
  await db.delete(waiverPlayerStatus).where(eq(waiverPlayerStatus.leagueId, leagueId));
  await db.delete(rosters).where(eq(rosters.leagueId, leagueId));

  const roundRows = await db.select({ id: fantasyRounds.id }).from(fantasyRounds).where(eq(fantasyRounds.leagueId, leagueId));
  const roundIds = roundRows.map(r => r.id);
  if (roundIds.length > 0) {
    await db.delete(fantasyMatchups).where(inArray(fantasyMatchups.fantasyRoundId, roundIds));
  }
  await db.delete(fantasyRounds).where(eq(fantasyRounds.leagueId, leagueId));
  await db.delete(groupStandings).where(eq(groupStandings.leagueId, leagueId));
  await db.delete(scheduleSlots).where(eq(scheduleSlots.leagueId, leagueId));
  await db.delete(leagueMemberships).where(eq(leagueMemberships.leagueId, leagueId));
  await db.delete(leagues).where(eq(leagues.id, leagueId));

  console.log(`Deleted league ${leagueId} and all dependents.`);
  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
