import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  const leagues = await db.execute(sql`SELECT id, name, status FROM leagues ORDER BY created_at DESC LIMIT 5`);
  console.log("=== leagues ===");
  for (const r of leagues) console.log(JSON.stringify(r));
  
  const [sc] = await db.execute(sql`SELECT COUNT(*)::int as c FROM player_match_scores`);
  const [gc] = await db.execute(sql`SELECT COUNT(*)::int as c FROM group_standings`);
  const [rc] = await db.execute(sql`SELECT COUNT(*)::int as c FROM real_fixtures`);
  const [pc] = await db.execute(sql`SELECT COUNT(*)::int as c FROM players`);
  console.log(`player_match_scores: ${sc.c}  group_standings: ${gc.c}  real_fixtures: ${rc.c}  players: ${pc.c}`);
  
  const valLeague = await db.execute(sql`SELECT id, name, status FROM leagues WHERE id = '081cbd82-7287-47d3-a701-77c0cc8d9c35'`);
  console.log("val league 081cbd82:", Array.from(valLeague).length > 0 ? "EXISTS" : "NOT FOUND");
  
  await client.end();
}

main().catch(async e => { console.error(e); await client.end(); process.exit(1); });
