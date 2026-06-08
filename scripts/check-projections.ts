import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import { playerProjections, playerRankings, players, nations } from "../src/db/schema";
import { eq, isNotNull, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";

async function main() {
  const projCount = await db.select({ c: sql<number>`count(*)::int` }).from(playerProjections);
  const rankCount = await db.select({ c: sql<number>`count(*)::int` }).from(playerRankings).where(isNotNull(playerRankings.oRank));

  console.log(`player_projections rows: ${projCount[0].c}`);
  console.log(`player_rankings rows with o_rank: ${rankCount[0].c}`);

  const top5 = await db
    .select({
      rank: playerRankings.oRank,
      pts: playerRankings.projectedPoints,
      name: players.name,
      nation: nations.name,
      position: players.position,
    })
    .from(playerRankings)
    .innerJoin(players, eq(playerRankings.playerId, players.id))
    .innerJoin(nations, eq(players.nationId, nations.id))
    .where(isNotNull(playerRankings.oRank))
    .orderBy(asc(playerRankings.oRank))
    .limit(5);

  console.log("\nTop 5 in DB:");
  for (const r of top5) {
    console.log(`  ${r.rank}. ${r.name} (${r.nation}, ${r.position}) — ${r.pts} pts`);
  }
}
main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (e) => { console.error(e); await client.end(); process.exit(1); });
