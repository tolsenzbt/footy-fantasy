/**
 * Populates waiver_player_status for an initial draft that has completed.
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   npm run db:init-draft-ownership -- <leagueId>
 *
 * What it writes:
 *   - status='rostered'   for every player in rosters (this league) with no existing row
 *   - status='on_waivers' for every active player not on any roster (this league) with no existing row
 *     eligible_at = draft.completedAt + 24h  (§8 initial-draft aftermath)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import { waiverPlayerStatus } from "../src/db/schema";
import { eq, count } from "drizzle-orm";
import { initDraftOwnership } from "../src/lib/draft/init-ownership";

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) {
    console.error("Usage: init-draft-ownership.ts <leagueId>");
    process.exit(1);
  }

  const [before] = await db
    .select({ c: count() })
    .from(waiverPlayerStatus)
    .where(eq(waiverPlayerStatus.leagueId, leagueId));
  const rowsBefore = Number(before.c);

  console.log(`\nInitialising draft ownership for league: ${leagueId}`);
  console.log(`  waiver_player_status rows before : ${rowsBefore}`);

  const result = await initDraftOwnership(leagueId);

  console.log(`  rostered rows inserted           : ${result.rosteredInserted}`);
  console.log(`  on_waivers rows inserted         : ${result.onWaiversInserted}`);
  console.log(`  waiver_player_status rows after  : ${result.totalRows}`);
  console.log();

  if (result.rosteredInserted === 0 && result.onWaiversInserted === 0) {
    console.log("Nothing to do — already fully initialised (idempotency confirmed).");
  } else {
    console.log("Done.");
  }
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error("\nFATAL:", err.message ?? err); await client.end(); process.exit(1); });
