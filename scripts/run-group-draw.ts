/**
 * Run the group draw for a league that has a completed initial draft.
 * Safe to call manually for recovery if the automatic post-draft trigger failed.
 *
 * Usage:
 *   npm run db:run-group-draw -- <leagueId>
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { client } from "../src/db";
import { runGroupDraw } from "../src/lib/schedule/group-draw";

async function main() {
  const [, , leagueId] = process.argv;

  if (!leagueId) {
    console.error("Usage: npm run db:run-group-draw -- <leagueId>");
    process.exit(1);
  }

  console.log(`\nRunning group draw for league: ${leagueId}\n`);

  const result = await runGroupDraw(leagueId);

  console.log("Group draw completed successfully.");
  console.log(`  Schedule slots assigned : ${result.slotsAssigned}`);
  console.log(`  Group matchups created  : ${result.groupMatchupsCreated}`);
  console.log(`  Knockout matchups created: ${result.knockoutMatchupsCreated}`);
  console.log(`  Fantasy rounds created  : ${result.fantasyRoundsCreated}`);
  console.log();
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err.message ?? err); await client.end(); process.exit(1); });
