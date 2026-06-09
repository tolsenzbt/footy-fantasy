import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import { sql } from "drizzle-orm";

const DEV = "16a4ac0d-67e6-46a0-8c66-74119485f68a";

async function main() {
  const [roster] = await db.execute(sql`SELECT COUNT(*)::int as c FROM rosters WHERE league_id = ${DEV}`);
  const [wps] = await db.execute(sql`SELECT COUNT(*)::int as c FROM waiver_player_status WHERE league_id = ${DEV}`);
  const [fr] = await db.execute(sql`SELECT COUNT(*)::int as c FROM fantasy_rounds WHERE league_id = ${DEV}`);
  const [fm] = await db.execute(sql`SELECT COUNT(*)::int as c FROM fantasy_matchups WHERE league_id = ${DEV}`);
  const [ss] = await db.execute(sql`SELECT COUNT(*)::int as c FROM schedule_slots WHERE league_id = ${DEV}`);
  const [draft] = await db.execute(sql`SELECT status, completed_at FROM drafts WHERE league_id = ${DEV} LIMIT 1`);
  const [withId] = await db.execute(sql`SELECT COUNT(*)::int as c FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.league_id = ${DEV} AND p.api_football_id IS NOT NULL`);
  const [withoutId] = await db.execute(sql`SELECT COUNT(*)::int as c FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.league_id = ${DEV} AND p.api_football_id IS NULL`);
  console.log(`rosters: ${roster.c}  wps: ${wps.c}  fantasy_rounds: ${fr.c}  fantasy_matchups: ${fm.c}  schedule_slots: ${ss.c}`);
  console.log(`draft: ${JSON.stringify(draft)}`);
  console.log(`players with api_football_id: ${withId.c}  without: ${withoutId.c}`);
  
  // Check real_fixtures counts by round
  const rfRounds = await db.execute(sql`SELECT round, COUNT(*)::int as c FROM real_fixtures GROUP BY round ORDER BY round`);
  console.log("real_fixtures by round:");
  for (const r of rfRounds) console.log(`  ${JSON.stringify(r)}`);
  
  await client.end();
}

main().catch(async e => { console.error(e); await client.end(); process.exit(1); });
