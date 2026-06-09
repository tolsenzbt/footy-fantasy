import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  // Find the new dev league
  const [league] = await db.execute(sql`SELECT id, name, status FROM leagues WHERE name = 'Dev League 2026' LIMIT 1`);
  const leagueId = (league as Record<string, unknown>).id as string;
  console.log(`League: ${leagueId}  status=${(league as Record<string, unknown>).status}`);

  const [lm_total] = await db.execute(sql`SELECT COUNT(*)::int as c FROM league_memberships WHERE league_id = ${leagueId}`);
  const [lm_mgr] = await db.execute(sql`SELECT COUNT(*)::int as c FROM league_memberships WHERE league_id = ${leagueId} AND role = 'manager'`);
  const [lm_comm] = await db.execute(sql`SELECT COUNT(*)::int as c FROM league_memberships WHERE league_id = ${leagueId} AND role = 'commissioner'`);
  const [rosters_total] = await db.execute(sql`SELECT COUNT(*)::int as c FROM rosters WHERE league_id = ${leagueId}`);
  const [rosters_distinct] = await db.execute(sql`SELECT COUNT(DISTINCT manager_id)::int as c FROM rosters WHERE league_id = ${leagueId}`);
  const [ss] = await db.execute(sql`SELECT COUNT(*)::int as c FROM schedule_slots WHERE league_id = ${leagueId}`);
  const [fr] = await db.execute(sql`SELECT COUNT(*)::int as c FROM fantasy_rounds WHERE league_id = ${leagueId}`);

  console.log(`memberships total: ${lm_total.c}  (role=manager: ${lm_mgr.c}, role=commissioner: ${lm_comm.c})`);
  console.log(`rosters total: ${rosters_total.c}  distinct manager_id: ${rosters_distinct.c}`);
  console.log(`schedule_slots: ${ss.c}  fantasy_rounds: ${fr.c}`);

  const allMgr16 = Number(lm_mgr.c) === 16;
  const noComm = Number(lm_comm.c) === 0;
  const rosters224 = Number(rosters_total.c) === 224;
  const distinctMgr16 = Number(rosters_distinct.c) === 16;

  console.log(`\nChecks:`);
  console.log(`  16 managers:            ${allMgr16 ? "✓" : "✗"}`);
  console.log(`  0 commissioners:        ${noComm ? "✓" : "✗"}`);
  console.log(`  224 rosters:            ${rosters224 ? "✓" : "✗"}`);
  console.log(`  16 distinct manager_id: ${distinctMgr16 ? "✓" : "✗"}`);
  console.log(`  ready for group-stage:  ${allMgr16 && noComm && rosters224 && distinctMgr16 ? "✓" : "✗"}`);

  await client.end();
}
main().catch(async e => { console.error(e); await client.end(); process.exit(1); });
