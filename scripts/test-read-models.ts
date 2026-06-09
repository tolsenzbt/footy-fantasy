/**
 * Quick sanity check for the 3 new read-model getters.
 * Usage: npm run db:test-read-models -- <leagueId>
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { db, client } from "../src/db";
import { leagueMemberships } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { getDraftBoard } from "../src/lib/draft/board";
import { getScheduleSlots } from "../src/lib/schedule/read";
import { getRoster } from "../src/lib/roster/read";

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) { console.error("Usage: test-read-models.ts <leagueId>"); process.exit(1); }

  // ── getDraftBoard ────────────────────────────────────────────────────────────
  console.log("\n── getDraftBoard ──");
  const board = await getDraftBoard(leagueId, "initial");
  if (!board) { console.log("  null (no draft)"); } else {
    console.log(`  status: ${board.status}`);
    console.log(`  leagueSize: ${board.leagueSize}, totalRounds: ${board.totalRounds}`);
    console.log(`  managers: ${board.managers.length}`);
    console.log(`  picks: ${board.picks.length} across ${new Set(board.picks.map(p => p.roundNumber)).size} rounds`);
    console.log(`  onTheClock: ${board.onTheClockManagerId ?? "(none — complete)"}`);
    const sample = board.picks[0];
    if (sample) {
      console.log(`  sample pick #1: ${sample.player.name} (${sample.player.position}) [${sample.player.nationFifaCode}] by ${board.managers.find(m => m.membershipId === sample.managerId)?.displayName}`);
    }
  }

  // ── getScheduleSlots ────────────────────────────────────────────────────────
  console.log("\n── getScheduleSlots ──");
  const slots = await getScheduleSlots(leagueId);
  if (slots.groups.length === 0) {
    console.log("  no slots assigned yet (group draw not run)");
  } else {
    console.log(`  groups: ${slots.groups.length}, isComplete: ${slots.isComplete}`);
    for (const g of slots.groups) {
      const names = g.slots.map(s => s.displayName ?? "(unassigned)").join(", ");
      console.log(`  Group ${g.groupLetter}: ${names}`);
    }
  }

  // ── getRoster ────────────────────────────────────────────────────────────────
  console.log("\n── getRoster ──");
  const [firstMember] = await db
    .select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
    .from(leagueMemberships)
    .where(eq(leagueMemberships.leagueId, leagueId))
    .limit(1);
  if (!firstMember) { console.log("  no members"); } else {
    const roster = await getRoster(leagueId, firstMember.id);
    console.log(`  manager: ${firstMember.displayName} — ${roster.players.length} players`);
    for (const p of roster.players) {
      console.log(`    ${p.position.padEnd(3)} ${p.playerName.padEnd(25)} ${p.nationFifaCode}`);
    }
  }

  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
