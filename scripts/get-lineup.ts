/**
 * Print the current lineup for a manager/round, with automatic fallback to
 * the most recent prior round if no lineup exists for the requested round.
 *
 * Usage:
 *   npm run db:get-lineup -- <leagueId> <managerId> <fantasyRoundId>
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { client } from "../src/db";
import { getLineup } from "../src/lib/lineup/read";

async function main() {
  const [, , leagueId, managerId, fantasyRoundId] = process.argv;

  if (!leagueId || !managerId || !fantasyRoundId) {
    console.error("Usage: npm run db:get-lineup -- <leagueId> <managerId> <fantasyRoundId>");
    process.exit(1);
  }

  const lineup = await getLineup(leagueId, managerId, fantasyRoundId);

  if (!lineup) {
    console.log("\nNo lineup found (no lineup set for this round or any prior round).\n");
    return;
  }

  const fallbackNote = lineup.isFallback ? " (fallback)" : "";

  console.log(`\nLineup — round: ${lineup.round}${fallbackNote}`);
  console.log(`  Lineup ID    : ${lineup.lineupId}`);
  console.log(`  Formation    : ${lineup.formation}`);
  console.log(`  Captain      : ${lineup.captainPlayerId}${lineup.captainLockedAt ? " [LOCKED]" : ""}`);
  console.log(`  Vice-captain : ${lineup.vcPlayerId}${lineup.vcLockedAt ? " [LOCKED]" : ""}`);

  console.log("\n  Starting XI:");
  const starters = lineup.slots.filter(s => s.slotType === "starter");
  for (const s of starters) {
    const lock = s.lockedAt ? " [LOCKED]" : "";
    console.log(`    ${s.position.padEnd(4)} ${s.playerName}${lock}`);
  }

  console.log("\n  Bench:");
  const bench = lineup.slots.filter(s => s.slotType === "bench");
  for (const s of bench) {
    const lock = s.lockedAt ? " [LOCKED]" : "";
    console.log(`    ${s.position.padEnd(4)} ${s.playerName}${lock}`);
  }

  console.log();
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err.message ?? err); await client.end(); process.exit(1); });
