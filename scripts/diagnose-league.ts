import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import { sql } from "drizzle-orm";

const LEAGUE = "16a4ac0d-67e6-46a0-8c66-74119485f68a";

async function main() {
  const [lm_all] = await db.execute(sql`SELECT COUNT(*)::int as c FROM league_memberships WHERE league_id = ${LEAGUE}`);
  const [lm_mgr] = await db.execute(sql`SELECT COUNT(*)::int as c FROM league_memberships WHERE league_id = ${LEAGUE} AND role = 'manager'`);
  const [lm_comm] = await db.execute(sql`SELECT COUNT(*)::int as c FROM league_memberships WHERE league_id = ${LEAGUE} AND role = 'commissioner'`);
  const [rosters_distinct] = await db.execute(sql`SELECT COUNT(DISTINCT manager_id)::int as c FROM rosters WHERE league_id = ${LEAGUE}`);
  const [picks_distinct] = await db.execute(sql`SELECT COUNT(DISTINCT manager_id)::int as c FROM draft_picks WHERE draft_id IN (SELECT id FROM drafts WHERE league_id = ${LEAGUE})`);
  const [rosters_total] = await db.execute(sql`SELECT COUNT(*)::int as c FROM rosters WHERE league_id = ${LEAGUE}`);

  console.log(`league_memberships total: ${lm_all.c}`);
  console.log(`league_memberships role=manager: ${lm_mgr.c}`);
  console.log(`league_memberships role=commissioner: ${lm_comm.c}`);
  console.log(`rosters distinct manager_id: ${rosters_distinct.c}`);
  console.log(`rosters total rows: ${rosters_total.c}`);
  console.log(`draft_picks distinct manager_id: ${picks_distinct.c}`);

  // List all memberships
  console.log("\n--- memberships ---");
  const members = await db.execute(sql`
    SELECT lm.id, lm.role, lm.display_name, lm.user_id,
           (SELECT COUNT(*)::int FROM rosters WHERE league_id = ${LEAGUE} AND manager_id = lm.id) AS roster_count
    FROM league_memberships lm WHERE lm.league_id = ${LEAGUE}
    ORDER BY lm.role, lm.display_name
  `);
  for (const r of members) {
    const row = r as Record<string, unknown>;
    console.log(`  [${String(row.role).padEnd(12)}] ${String(row.display_name).padEnd(20)} id=${String(row.id).slice(0,8)} userId=${String(row.user_id).slice(0,8)} rosters=${row.roster_count}`);
  }

  // Check draft_order vs memberships
  console.log("\n--- draft_order manager_ids not in league_memberships ---");
  const orphan_do = await db.execute(sql`
    SELECT DISTINCT do.manager_id
    FROM draft_order do
    JOIN drafts d ON d.id = do.draft_id
    WHERE d.league_id = ${LEAGUE}
      AND do.manager_id NOT IN (SELECT id FROM league_memberships WHERE league_id = ${LEAGUE})
  `);
  console.log(`  orphaned draft_order rows: ${Array.from(orphan_do).length}`);

  // Check rosters manager_ids not in league_memberships
  const orphan_r = await db.execute(sql`
    SELECT DISTINCT r.manager_id
    FROM rosters r
    WHERE r.league_id = ${LEAGUE}
      AND r.manager_id NOT IN (SELECT id FROM league_memberships WHERE league_id = ${LEAGUE})
  `);
  console.log(`  orphaned roster manager_ids: ${Array.from(orphan_r).length}`);
  for (const r of orphan_r) {
    const row = r as Record<string, unknown>;
    console.log(`    manager_id=${row.manager_id}`);
  }

  await client.end();
}
main().catch(async e => { console.error(e); await client.end(); process.exit(1); });
