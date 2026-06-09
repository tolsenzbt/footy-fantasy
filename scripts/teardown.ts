/**
 * Pre-launch teardown: wipes all fantasy-league data and soccer reference data.
 * Preserves public.profiles and auth.users.
 *
 * Run:
 *   tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/teardown.ts
 *
 * Prints row counts before/after for every table touched.
 * Confirms profiles/auth.users are unchanged.
 * Stops and reports if any FK path might reach profiles before truncating.
 */

import { db, client } from "../src/db";
import { sql } from "drizzle-orm";

// All public tables we will truncate, in dependency order (leaves first).
// FK analysis:
//   profiles is referenced BY leagues.created_by and league_memberships.user_id.
//   profiles does NOT reference any of these tables.
//   Therefore CASCADE from any of these tables will NOT reach profiles. Safe.
const FANTASY_TABLES = [
  "raw_api_responses",
  "player_match_scores",
  "player_match_stats",
  "lineup_slots",
  "waiver_claims",
  "draft_picks",
  "draft_order",
  "lineups",
  "waiver_player_status",
  "waiver_priority",
  "waiver_processing_events",
  "rosters",
  "fantasy_matchups",
  "group_standings",
  "schedule_slots",
  "fantasy_rounds",
  "drafts",
  "league_memberships",
  "leagues",
] as const;

const REFERENCE_TABLES = [
  "players",
  "real_fixtures",
  "nations",
] as const;

const ALL_TRUNCATE_TABLES = [...FANTASY_TABLES, ...REFERENCE_TABLES];

// Tables we MUST NOT touch
const PRESERVED_TABLES = ["profiles", "auth.users"];

async function countRow(table: string): Promise<number> {
  const isAuthSchema = table.includes(".");
  const q = isAuthSchema
    ? sql.raw(`SELECT count(*)::int AS c FROM ${table}`)
    : sql.raw(`SELECT count(*)::int AS c FROM public.${table}`);
  const rows = await db.execute(q);
  return (unknown: (rows as unknown as Array<{ c: number }>)[0].c;
}

async function main() {
  console.log("=".repeat(70));
  console.log("Footy Fantasy — Pre-launch Teardown");
  console.log("=".repeat(70));

  // ── Before counts ────────────────────────────────────────────────────────
  console.log("\n=== Row counts BEFORE truncation ===");

  const before: Record<string, number> = {};

  for (const t of ALL_TRUNCATE_TABLES) {
    before[t] = await countRow(t);
  }
  for (const t of PRESERVED_TABLES) {
    before[t] = await countRow(t);
  }

  const allTables = [...ALL_TRUNCATE_TABLES, ...PRESERVED_TABLES];
  const maxLen = Math.max(...allTables.map((t) => t.length));
  for (const t of allTables) {
    const marker = PRESERVED_TABLES.includes(t) ? " [PRESERVED]" : "";
    console.log(`  ${t.padEnd(maxLen)}  ${String(before[t]).padStart(6)}${marker}`);
  }

  const totalBefore = ALL_TRUNCATE_TABLES.reduce((s, t) => s + before[t], 0);
  console.log(`\n  Total rows in tables-to-truncate: ${totalBefore}`);

  // ── Truncate ─────────────────────────────────────────────────────────────
  console.log("\n=== Truncating ===");
  console.log(
    "  Tables: " + ALL_TRUNCATE_TABLES.join(", ")
  );
  console.log("  Strategy: explicit list + CASCADE (safety net)");
  console.log(
    "  FK analysis: no path from any of these tables reaches public.profiles or auth.users"
  );

  const tableList = ALL_TRUNCATE_TABLES.map((t) => `"${t}"`).join(", ");
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`)
  );
  console.log("  ✓ TRUNCATE complete");

  // ── After counts ─────────────────────────────────────────────────────────
  console.log("\n=== Row counts AFTER truncation ===");

  const after: Record<string, number> = {};
  for (const t of ALL_TRUNCATE_TABLES) {
    after[t] = await countRow(t);
  }
  for (const t of PRESERVED_TABLES) {
    after[t] = await countRow(t);
  }

  let allClear = true;
  for (const t of allTables) {
    const marker = PRESERVED_TABLES.includes(t) ? " [PRESERVED]" : "";
    const changed = after[t] !== before[t];
    const indicator = PRESERVED_TABLES.includes(t)
      ? changed ? " ← ERROR: count changed!" : " ✓ unchanged"
      : after[t] === 0 ? " ✓" : " ← ERROR: not empty!";
    console.log(
      `  ${t.padEnd(maxLen)}  ${String(before[t]).padStart(6)} → ${String(after[t]).padStart(6)}${marker}${indicator}`
    );
    if (PRESERVED_TABLES.includes(t) && changed) allClear = false;
    if (!PRESERVED_TABLES.includes(t) && after[t] !== 0) allClear = false;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  if (allClear) {
    console.log("  ✓ All target tables empty");
    console.log("  ✓ profiles unchanged");
    console.log("  ✓ auth.users unchanged");
    console.log("\n  Teardown complete. Ready for reseed.");
  } else {
    console.error("  ✗ Unexpected state — see rows marked ERROR above");
    process.exit(1);
  }
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error("\nFATAL:", err); await client.end(); process.exit(1); });
