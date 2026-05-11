/**
 * Submit a draft pick from the command line — useful for driving a full draft
 * without a UI.
 *
 * Usage:
 *   npm run db:submit-pick -- <leagueId> <managerId> <playerId>
 *   npm run db:submit-pick -- <leagueId> <managerId> --by-position <GK|DEF|MID|FWD>
 *
 * --by-position: picks the first eligible (active, unrostered) player of that
 *   fantasy position, sorted alphabetically by name. Handy for driving a full
 *   draft without hand-copying 112 UUIDs.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import { players, rosters } from "../src/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { submitPick } from "../src/lib/draft/picks";
import { getDraftState } from "../src/lib/draft/state";

async function resolvePlayerId(
  leagueId: string,
  position: string
): Promise<string> {
  const validPositions = ["GK", "DEF", "MID", "FWD"];
  if (!validPositions.includes(position)) {
    console.error(`Error: invalid position '${position}'. Must be one of: ${validPositions.join(", ")}`);
    process.exit(1);
  }

  // First eligible player: active, not already rostered in this league, sorted by name
  const result = await db
    .select({ id: players.id, name: players.name })
    .from(players)
    .leftJoin(
      rosters,
      and(eq(rosters.playerId, players.id), eq(rosters.leagueId, leagueId))
    )
    .where(
      and(
        eq(players.fantasyPosition, position as "GK" | "DEF" | "MID" | "FWD"),
        eq(players.active, true),
        isNull(rosters.id)
      )
    )
    .orderBy(players.name)
    .limit(1);

  if (result.length === 0) {
    console.error(`Error: no eligible ${position} found (all may be rostered or inactive).`);
    process.exit(1);
  }

  console.log(`Resolved --by-position ${position} → ${result[0].name} (${result[0].id})`);
  return result[0].id;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error(
      "Usage:\n" +
      "  tsx scripts/submit-pick.ts <leagueId> <managerId> <playerId>\n" +
      "  tsx scripts/submit-pick.ts <leagueId> <managerId> --by-position <GK|DEF|MID|FWD>"
    );
    process.exit(1);
  }

  const [leagueId, managerId, third, fourth] = args;

  let playerId: string;
  if (third === "--by-position") {
    if (!fourth) {
      console.error("Error: --by-position requires a position argument (GK|DEF|MID|FWD).");
      process.exit(1);
    }
    playerId = await resolvePlayerId(leagueId, fourth);
  } else {
    playerId = third;
  }

  console.log(`\nSubmitting pick:`);
  console.log(`  League   : ${leagueId}`);
  console.log(`  Manager  : ${managerId}`);
  console.log(`  Player   : ${playerId}\n`);

  const result = await submitPick({
    leagueId,
    draftType: "initial",
    managerId,
    playerId,
  });

  console.log(`Pick submitted successfully.`);
  console.log(`  Pick #   : ${result.pickNumber}`);
  console.log(`  Final?   : ${result.isFinalPick}\n`);

  const newState = await getDraftState(leagueId, "initial");
  console.log("Draft state after pick:");
  console.log(JSON.stringify(newState, null, 2));
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err.message ?? err); await client.end(); process.exit(1); });
