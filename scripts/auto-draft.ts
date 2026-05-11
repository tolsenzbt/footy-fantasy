/**
 * Auto-fills an initial draft by calling submitPick for each pick in sequence.
 * Validation/testing tool only — not a production feature.
 *
 * Usage: npm run db:auto-draft -- <leagueId>
 *
 * Position-aware pick logic ensures each manager's final roster is legal:
 *   GK 1–2, DEF 3–5, MID 3–5, FWD 1–3, total 14.
 * When picks remaining for a manager equal mandatory slots not yet filled,
 * the picker restricts to only those forced positions.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import { leagues, leagueMemberships, players, nations, rosters, drafts } from "../src/db/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { getDraftState } from "../src/lib/draft/state";
import { submitPick } from "../src/lib/draft/picks";
import { leagueSizeFromFormat, pickToRound, resolveDraftPosition } from "../src/lib/draft/snake";

type Position = "GK" | "DEF" | "MID" | "FWD";
const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const POSITION_MAX: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const POSITION_MIN: Record<Position, number> = { GK: 1, DEF: 3, MID: 3, FWD: 1 };

async function getRosterCounts(
  leagueId: string,
  managerId: string
): Promise<Record<Position, number>> {
  const rows = await db
    .select({ fantasyPosition: players.fantasyPosition })
    .from(rosters)
    .innerJoin(players, eq(rosters.playerId, players.id))
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId)));

  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const row of rows) counts[row.fantasyPosition as Position]++;
  return counts;
}

// Returns the positions a manager may legally pick at this point.
// If picks remaining equals total mandatory slots still unfilled, restricts to
// only those forced positions so the manager can always finish legally.
function legalPositions(counts: Record<Position, number>): Position[] {
  const total = POSITIONS.reduce((s, p) => s + counts[p], 0);
  const remaining = 14 - total;

  const forced = POSITIONS.filter(p => counts[p] < POSITION_MIN[p]);
  const totalForced = forced.reduce((s, p) => s + (POSITION_MIN[p] - counts[p]), 0);

  if (totalForced === remaining) return forced;
  return POSITIONS.filter(p => counts[p] < POSITION_MAX[p]);
}

async function findPlayer(leagueId: string, positions: Position[]) {
  const result = await db
    .select({
      id: players.id,
      name: players.name,
      fantasyPosition: players.fantasyPosition,
      nationName: nations.name,
    })
    .from(players)
    .innerJoin(nations, eq(players.nationId, nations.id))
    .leftJoin(
      rosters,
      and(eq(rosters.playerId, players.id), eq(rosters.leagueId, leagueId))
    )
    .where(
      and(
        eq(players.active, true),
        isNull(rosters.id),
        inArray(players.fantasyPosition, positions)
      )
    )
    .orderBy(players.name)
    .limit(1);

  return result[0] ?? null;
}

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) {
    console.error("Usage: npm run db:auto-draft -- <leagueId>");
    process.exit(1);
  }

  const startTime = Date.now();

  // Load league
  const [league] = await db
    .select({ name: leagues.name, format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) {
    console.error(`Error: league '${leagueId}' not found.`);
    process.exit(1);
  }

  const leagueSize = leagueSizeFromFormat(league.format);
  const totalPicks = 14 * leagueSize;

  // Load memberships for display names
  const members = await db
    .select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
    .from(leagueMemberships)
    .where(eq(leagueMemberships.leagueId, leagueId));

  const memberName = new Map(members.map(m => [m.id, m.displayName ?? m.id.slice(0, 8)]));

  // Load initial state
  let state = await getDraftState(leagueId, "initial");

  if (state.draft.status !== "active") {
    console.error(`Error: draft is not active (status: ${state.draft.status}).`);
    process.exit(1);
  }

  console.log(
    `\nAuto-draft: ${league.name} (${league.format}, ${leagueSize} managers, ${totalPicks} total picks)`
  );
  console.log(`Resuming at pick ${state.draft.currentPickNumber}.\n`);

  let picksMade = 0;

  // Main loop
  while (state.draft.status === "active") {
    const managerId = state.onTheClockManagerId!;
    const pickNumber = state.draft.currentPickNumber!;
    const { round } = pickToRound(pickNumber, leagueSize);
    const slot = resolveDraftPosition(pickNumber, leagueSize);

    const counts = await getRosterCounts(leagueId, managerId);
    const legal = legalPositions(counts);

    if (legal.length === 0) {
      console.error(
        `Error: no legal positions for manager ${managerId} at pick ${pickNumber} ` +
        `(counts: GK=${counts.GK} DEF=${counts.DEF} MID=${counts.MID} FWD=${counts.FWD}). ` +
        `This indicates a bug in the position logic.`
      );
      process.exit(1);
    }

    const player = await findPlayer(leagueId, legal);

    if (!player) {
      console.error(
        `Error: no eligible player found for positions [${legal.join(", ")}] at pick ${pickNumber}. ` +
        `Player pool may be exhausted.`
      );
      process.exit(1);
    }

    await submitPick({ leagueId, draftType: "initial", managerId, playerId: player.id });
    picksMade++;

    const managerLabel = (memberName.get(managerId) ?? managerId).padEnd(20);
    const pickLabel = String(pickNumber).padStart(3);
    const roundLabel = String(round).padStart(2);
    const slotLabel = String(slot).padStart(2);
    console.log(
      `Pick ${pickLabel} (R${roundLabel} S${slotLabel}): ${managerLabel} picks ${player.name} (${player.fantasyPosition}, ${player.nationName})`
    );

    state = await getDraftState(leagueId, "initial");
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Auto-draft complete.`);
  console.log(`  Picks made   : ${picksMade}`);
  console.log(`  Draft status : ${state.draft.status}`);
  console.log(`  Completed at : ${state.draft.completedAt?.toISOString() ?? "(null)"}`);
  console.log(`  Elapsed      : ${elapsedSec}s`);

  // ── Final state verification ──────────────────────────────────────────────
  console.log(`\n── Final state verification ──`);

  const [finalDraft] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.id, state.draft.id))
    .limit(1);

  const [finalLeague] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  const checks = [
    { label: "drafts.status='complete'      ", ok: finalDraft.status === "complete" },
    { label: "drafts.completedAt set        ", ok: finalDraft.completedAt !== null },
    { label: "drafts.currentPickNumber null ", ok: finalDraft.currentPickNumber === null },
    { label: "leagues.status='drafting'     ", ok: finalLeague.status === "drafting" },
  ];

  let stateOk = true;
  for (const c of checks) {
    console.log(`  ${c.label}: ${c.ok ? "✓" : "✗"}`);
    if (!c.ok) stateOk = false;
  }

  // ── Roster legality per manager ───────────────────────────────────────────
  console.log(`\n── Roster legality ──`);

  let rostersOk = true;
  for (const member of members) {
    const counts = await getRosterCounts(leagueId, member.id);
    const total = POSITIONS.reduce((s, p) => s + counts[p], 0);

    const issues: string[] = [];
    if (counts.GK < 1 || counts.GK > 2) issues.push(`GK=${counts.GK} (want 1–2)`);
    if (counts.DEF < 3 || counts.DEF > 5) issues.push(`DEF=${counts.DEF} (want 3–5)`);
    if (counts.MID < 3 || counts.MID > 5) issues.push(`MID=${counts.MID} (want 3–5)`);
    if (counts.FWD < 1 || counts.FWD > 3) issues.push(`FWD=${counts.FWD} (want 1–3)`);
    if (total !== 14) issues.push(`total=${total} (want 14)`);

    const name = (memberName.get(member.id) ?? member.id).padEnd(22);
    if (issues.length === 0) {
      console.log(
        `  ${name}: ROSTER OK  (GK=${counts.GK} DEF=${counts.DEF} MID=${counts.MID} FWD=${counts.FWD})`
      );
    } else {
      console.log(`  ${name}: ROSTER INVALID: ${issues.join(", ")}`);
      rostersOk = false;
    }
  }

  if (!stateOk || !rostersOk) {
    console.error("\nVerification FAILED — see details above.");
    process.exit(1);
  }

  console.log("\nAll checks passed.");
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err.message ?? err); await client.end(); process.exit(1); });
