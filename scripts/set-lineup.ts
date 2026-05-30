/**
 * Auto-set a lineup for a manager by greedily assigning roster players to
 * starter/bench slots based on the given formation.
 *
 * Usage:
 *   npm run db:set-lineup -- <leagueId> <managerId> <fantasyRoundId> --formation <f>
 *
 * Example:
 *   npm run db:set-lineup -- <leagueId> <managerId> <roundId> --formation 4-4-2
 *
 * Player assignment: fills GK, DEF, MID, FWD starter slots in that order
 * (alphabetically within each position), then bench with the remainder.
 * Captain = first GK starter. VC = first DEF starter (or second overall starter).
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import { rosters, players } from "../src/db/schema";
import { eq, and } from "drizzle-orm";
import { parseFormation } from "../src/lib/lineup/formations";
import { setLineup } from "../src/lib/lineup/actions";

async function main() {
  const args = process.argv.slice(2);
  const leagueId = args[0];
  const managerId = args[1];
  const fantasyRoundId = args[2];
  const fmtIdx = args.indexOf("--formation");
  const formation = fmtIdx !== -1 ? args[fmtIdx + 1] : undefined;

  if (!leagueId || !managerId || !fantasyRoundId || !formation) {
    console.error(
      "Usage: npm run db:set-lineup -- <leagueId> <managerId> <fantasyRoundId> --formation <f>"
    );
    process.exit(1);
  }

  let breakdown: { gk: 1; def: number; mid: number; fwd: number };
  try {
    breakdown = parseFormation(formation);
  } catch (err: unknown) {
    console.error(`Invalid formation "${formation}": ${(err as Error).message}`);
    process.exit(1);
  }

  // Fetch roster sorted alphabetically within each position
  const rosterRows = await db
    .select({ playerId: players.id, name: players.name, fantasyPosition: players.fantasyPosition })
    .from(rosters)
    .innerJoin(players, eq(players.id, rosters.playerId))
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId)))
    .orderBy(players.fantasyPosition, players.name);

  if (rosterRows.length !== 14) {
    console.error(`Expected 14 roster players, found ${rosterRows.length}.`);
    process.exit(1);
  }

  const byPos: Record<string, string[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of rosterRows) byPos[p.fantasyPosition].push(p.playerId);

  const starterIds = [
    ...byPos.GK.slice(0, breakdown.gk),
    ...byPos.DEF.slice(0, breakdown.def),
    ...byPos.MID.slice(0, breakdown.mid),
    ...byPos.FWD.slice(0, breakdown.fwd),
  ];

  if (starterIds.length !== 11) {
    console.error(
      `Not enough players to fill ${formation}: ` +
      `need GK=${breakdown.gk} DEF=${breakdown.def} MID=${breakdown.mid} FWD=${breakdown.fwd}, ` +
      `have GK=${byPos.GK.length} DEF=${byPos.DEF.length} MID=${byPos.MID.length} FWD=${byPos.FWD.length}`
    );
    process.exit(1);
  }

  const starterSet = new Set(starterIds);
  const benchIds = rosterRows
    .filter(p => !starterSet.has(p.playerId))
    .map(p => p.playerId)
    .slice(0, 3);

  if (benchIds.length !== 3) {
    console.error(`Expected 3 bench players, got ${benchIds.length}.`);
    process.exit(1);
  }

  const captainPlayerId = starterIds[0]; // first GK
  const vcPlayerId = starterIds[1];      // first DEF (or second starter)

  console.log(`\nSetting lineup for manager ${managerId}`);
  console.log(`  League       : ${leagueId}`);
  console.log(`  Round        : ${fantasyRoundId}`);
  console.log(`  Formation    : ${formation}`);
  console.log(`  Captain      : ${captainPlayerId}`);
  console.log(`  Vice-captain : ${vcPlayerId}`);
  console.log(`  Starters     : ${starterIds.join(", ")}`);
  console.log(`  Bench        : ${benchIds.join(", ")}`);
  console.log();

  const result = await setLineup({
    leagueId,
    managerId,
    fantasyRoundId,
    formation,
    starterPlayerIds: starterIds,
    benchPlayerIds: benchIds,
    captainPlayerId,
    vcPlayerId,
  });

  console.log("Lineup set successfully.");
  console.log(`  Lineup ID : ${result.lineupId}`);
  console.log(`  Starters  : ${result.starters.map(s => s.playerId).join(", ")}`);
  console.log(`  Bench     : ${result.bench.map(s => s.playerId).join(", ")}`);
  console.log();
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err.message ?? err); await client.end(); process.exit(1); });
