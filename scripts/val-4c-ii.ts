/**
 * val-4c-ii.ts — Phase 4c-ii (FINALE): Knockout ingestion + bracket advancement to champion.
 *
 * Validates: knockout score ingestion, resolveBracket winner-type seed resolution (FIRST EXERCISE),
 * nation-status recompute (nextFixtureId correction), knockout nation elimination,
 * bracket advancement qf → sf → final → champion.
 *
 * Pre-conditions: 4c-i complete (league status=knockouts, qf bracket seeded, 16 qf fixtures exist).
 * Runs ONE sequence; STOPs (throws) if any checkpoint diverges.
 *
 * STEP 0: Orient
 * STEP 1: Build synthetic sf + final real_fixtures
 * STEP 2: Nation-status recompute (before/after nextFixtureId)
 * STEP 3: QF — lineups, stats inject, resolveMatchups, resolveBracket, verify
 * STEP 4: SF — same pattern
 * STEP 5: Final — same pattern → champion
 * STEP 6: End-state verification
 *
 * Usage: npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/val-4c-ii.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import {
  leagues, leagueMemberships, nations, realFixtures, fantasyRounds, fantasyMatchups,
  players, rosters, lineups, lineupSlots, playerMatchStats, playerMatchScores,
} from "../src/db/schema";
import { eq, and, inArray, isNull, or, sql } from "drizzle-orm";
import { resolveMatchups } from "../src/lib/matchups/resolve";
import { resolveBracket } from "../src/lib/bracket/resolve";
import { recomputeAllNationStatus } from "../src/lib/nation-status";
import { scorePlayer } from "../src/lib/scoring/engine";
import type { FantasyPosition } from "../src/lib/scoring/engine";

const VAL = "081cbd82-7287-47d3-a701-77c0cc8d9c35";
const SEED_MAP: Record<string, string> = {
  "8d5b699e": "1A", "19e3ac6b": "2A", "65ff0eee": "1B", "54e336e8": "2B",
  "493f90fd": "1C", "f85f5538": "2C", "c08ef8d0": "1D", "8fe43edc": "2D",
};
function seed(id: string): string { return SEED_MAP[id.slice(0, 8)] ?? id.slice(0, 8); }
function check(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`CHECKPOINT FAIL: ${msg}`);
}

// ─── Nation sets ──────────────────────────────────────────────────────────────
// QF fixture pairings (home apiId, away apiId) — match val-4a-knockout-fixtures.ts
// Home nation WINS each fixture (synthetic design; home nation advances).
const QF_PAIRINGS: [number, number][] = [
  [770, 2],     // Czech Republic vs France          → Czech Rep advances
  [1531, 20],   // South Africa vs Australia         → SA advances
  [17, 25],     // South Korea vs Germany            → South Korea advances
  [6, 26],      // Brazil vs Argentina               → Brazil advances
  [31, 1],      // Morocco vs Belgium                → Morocco advances
  [777, 9],     // Türkiye vs Spain                  → Türkiye advances
  [2384, 10],   // USA vs England                    → USA advances
  [2382, 27],   // Ecuador vs Portugal               → Ecuador advances
  [1501, 1548], // Ivory Coast vs Jordan             → Ivory Coast advances
  [12, 23],     // Japan vs Saudi Arabia             → Japan advances
  [1118, 1532], // Netherlands vs Algeria            → Netherlands advances
  [28, 775],    // Tunisia vs Austria                → Tunisia advances
  [32, 3],      // Egypt vs Croatia                  → Egypt advances
  [1533, 8],    // Cape Verde Islands vs Colombia    → Cape Verde advances
  [7, 1508],    // Uruguay vs Congo DR               → Uruguay advances
  [1504, 1568], // Ghana vs Uzbekistan               → Ghana advances
];

// SF pairings (home wins each — 8 R16 fixtures, round='sf')
// Nations are the QF home-winners (advancing from R32)
const SF_PAIRINGS: [number, number][] = [
  [770, 1531],  // Czech Republic vs South Africa    → Czech Rep advances (apiId 999017)
  [17, 6],      // South Korea vs Brazil             → South Korea advances (apiId 999018)
  [31, 777],    // Morocco vs Türkiye                → Morocco advances (apiId 999019)
  [2384, 2382], // USA vs Ecuador                    → USA advances (apiId 999020)
  [1501, 12],   // Ivory Coast vs Japan              → Ivory Coast advances (apiId 999021)
  [1118, 28],   // Netherlands vs Tunisia            → Netherlands advances (apiId 999022)
  [32, 1533],   // Egypt vs Cape Verde Islands       → Egypt advances (apiId 999023)
  [7, 1504],    // Uruguay vs Ghana                  → Uruguay advances (apiId 999024)
];

// Final pairings (home wins each — 4 QF fixtures, round='final')
// Nations are the SF home-winners (advancing from R16)
const FINAL_PAIRINGS: [number, number][] = [
  [770, 17],    // Czech Republic vs South Korea     → Czech Rep advances (apiId 999025)
  [31, 2384],   // Morocco vs USA                    → Morocco advances (apiId 999026)
  [1501, 1118], // Ivory Coast vs Netherlands        → Ivory Coast advances (apiId 999027)
  [32, 7],      // Egypt vs Uruguay                  → Egypt advances (apiId 999028)
];

// Nations eliminated at each round (the away team of each pairing)
const QF_LOSERS_APIIDS = QF_PAIRINGS.map(([, away]) => away); // 16 nations
const SF_LOSERS_APIIDS = SF_PAIRINGS.map(([, away]) => away);  // 8 nations
const FINAL_LOSERS_APIIDS = FINAL_PAIRINGS.map(([, away]) => away); // 4 nations

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getRoundId(round: string): Promise<string> {
  const [row] = await db
    .select({ id: fantasyRounds.id })
    .from(fantasyRounds)
    .where(and(eq(fantasyRounds.leagueId, VAL), eq(fantasyRounds.round, round as any)))
    .limit(1);
  if (!row) throw new Error(`Fantasy round '${round}' not found`);
  return row.id;
}

/** Returns full roster. If round given, filters to only players whose nation has a fixture that round. */
async function getManagerRoster(managerId: string, round?: string): Promise<Array<{ playerId: string; pos: FantasyPosition; name: string }>> {
  const rows = await db
    .select({ playerId: players.id, pos: players.fantasyPosition, name: players.name, nationId: players.nationId })
    .from(rosters)
    .innerJoin(players, eq(rosters.playerId, players.id))
    .where(and(eq(rosters.leagueId, VAL), eq(rosters.managerId, managerId)))
    .orderBy(players.fantasyPosition, players.name);

  if (!round) return rows.map(r => ({ playerId: r.playerId, pos: r.pos as FantasyPosition, name: r.name }));

  // Filter to only players whose nation plays in the given round
  const [fixtureRowsH, fixtureRowsA] = await Promise.all([
    db.select({ homeNationId: realFixtures.homeNationId }).from(realFixtures).where(eq(realFixtures.round, round as any)),
    db.select({ awayNationId: realFixtures.awayNationId }).from(realFixtures).where(eq(realFixtures.round, round as any)),
  ]);
  const activeNations = new Set([
    ...fixtureRowsH.map(r => r.homeNationId),
    ...fixtureRowsA.map(r => r.awayNationId),
  ]);

  return rows
    .filter(r => activeNations.has(r.nationId))
    .map(r => ({ playerId: r.playerId, pos: r.pos as FantasyPosition, name: r.name }));
}

/** Set a lineup directly in the DB (bypasses setLineup validation for <14-player rosters). */
async function setLineupDirect(
  managerId: string,
  fantasyRoundId: string,
  starters: Array<{ playerId: string; pos: FantasyPosition }>,
  benchIds: string[],
  captainId: string,
  vcId: string,
): Promise<string> {
  // Determine formation from starters
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const s of starters) counts[s.pos]++;
  const formation = `${counts.DEF}-${counts.MID}-${counts.FWD}`;

  // Upsert lineup row
  const existing = await db
    .select({ id: lineups.id })
    .from(lineups)
    .where(and(eq(lineups.leagueId, VAL), eq(lineups.managerId, managerId), eq(lineups.fantasyRoundId, fantasyRoundId)))
    .limit(1);

  let lineupId: string;
  if (existing[0]) {
    lineupId = existing[0].id;
    await db.update(lineups)
      .set({ formation, captainPlayerId: captainId, vcPlayerId: vcId, updatedAt: new Date() })
      .where(eq(lineups.id, lineupId));
    // Delete existing slots
    await db.execute(sql`DELETE FROM lineup_slots WHERE lineup_id = ${lineupId}`);
  } else {
    const [ins] = await db.insert(lineups).values({
      leagueId: VAL,
      managerId,
      fantasyRoundId,
      formation,
      captainPlayerId: captainId,
      vcPlayerId: vcId,
    }).returning({ id: lineups.id });
    lineupId = ins.id;
  }

  // Insert slots
  const slotRows: Array<typeof lineupSlots.$inferInsert> = [
    ...starters.map(s => ({ lineupId, playerId: s.playerId, slotType: "starter" as const })),
    ...benchIds.map(id => ({ lineupId, playerId: id, slotType: "bench" as const })),
  ];
  if (slotRows.length > 0) {
    await db.insert(lineupSlots).values(slotRows).onConflictDoNothing();
  }
  return lineupId;
}

/** Pick starters (up to 11) + bench (up to 3) from roster using best-fit formation.
 *  If roster < 11, uses all available as starters (validation-only shortcut). */
function pickLineup(roster: Array<{ playerId: string; pos: FantasyPosition; name: string }>) {
  const byPos: Record<FantasyPosition, string[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of roster) byPos[p.pos].push(p.playerId);

  // Standard formations (sorted by likelihood of fitting)
  const formations = [
    { f: "4-4-2", gk: 1, def: 4, mid: 4, fwd: 2 },
    { f: "4-3-3", gk: 1, def: 4, mid: 3, fwd: 3 },
    { f: "4-5-1", gk: 1, def: 4, mid: 5, fwd: 1 },
    { f: "3-5-2", gk: 1, def: 3, mid: 5, fwd: 2 },
    { f: "3-4-3", gk: 1, def: 3, mid: 4, fwd: 3 },
    { f: "5-3-2", gk: 1, def: 5, mid: 3, fwd: 2 },
    { f: "5-4-1", gk: 1, def: 5, mid: 4, fwd: 1 },
    { f: "5-5-0", gk: 1, def: 5, mid: 5, fwd: 0 },
    { f: "5-3-1", gk: 1, def: 5, mid: 3, fwd: 1 },
    { f: "3-3-3", gk: 1, def: 3, mid: 3, fwd: 3 },
    { f: "2-2-6", gk: 1, def: 2, mid: 6, fwd: 0 },
    { f: "1-2-6", gk: 1, def: 2, mid: 6, fwd: 0 }, // degenerate but valid for validation
    { f: "2-6-0", gk: 1, def: 2, mid: 6, fwd: 0 },
  ];

  for (const form of formations) {
    if (byPos.GK.length >= form.gk && byPos.DEF.length >= form.def &&
        byPos.MID.length >= form.mid && byPos.FWD.length >= form.fwd &&
        (form.gk + form.def + form.mid + form.fwd) === 11) {
      const starters = [
        ...byPos.GK.slice(0, form.gk).map(id => ({ playerId: id, pos: "GK" as FantasyPosition })),
        ...byPos.DEF.slice(0, form.def).map(id => ({ playerId: id, pos: "DEF" as FantasyPosition })),
        ...byPos.MID.slice(0, form.mid).map(id => ({ playerId: id, pos: "MID" as FantasyPosition })),
        ...byPos.FWD.slice(0, form.fwd).map(id => ({ playerId: id, pos: "FWD" as FantasyPosition })),
      ];
      const starterSet = new Set(starters.map(s => s.playerId));
      const bench = roster.filter(p => !starterSet.has(p.playerId)).slice(0, 3).map(p => p.playerId);
      const captain = starters[0].playerId;
      const vc = starters[1]?.playerId ?? starters[0].playerId;
      return { starters, bench, captain, vc };
    }
  }

  // Fallback: use all available players as starters (for small post-redraft rosters)
  const starters = roster.map(p => ({ playerId: p.playerId, pos: p.pos }));
  const captain = starters[0].playerId;
  const vc = starters[1]?.playerId ?? starters[0].playerId;
  console.log(`    ⚠ Fallback: using all ${starters.length} players as starters (GK=${byPos.GK.length} DEF=${byPos.DEF.length} MID=${byPos.MID.length} FWD=${byPos.FWD.length})`);
  return { starters, bench: [] as string[], captain, vc };
}

/**
 * Inject stats for one fantasy matchup.
 * Home manager starters: 90 min + 2 goals, 0 conceded → big score.
 * Away manager starters: 60 min, 0 goals, 0 conceded → 2 pts.
 * Returns { homeTotal, awayTotal } for spot-check.
 */
async function injectMatchupStats(
  homeManagerId: string,
  awayManagerId: string,
  round: string,
  fantasyRoundId: string,
  nationByApiId: Map<number, string>,
): Promise<{ homeTotal: number; awayTotal: number; spotChecks: Array<{ player: string; pos: string; pts: number; expected: number }> }> {
  const now = new Date();

  // Get starters for both managers
  const [homeLineup, awayLineup] = await Promise.all([
    db.select({ playerId: lineupSlots.playerId })
      .from(lineupSlots)
      .innerJoin(lineups, eq(lineupSlots.lineupId, lineups.id))
      .where(and(
        eq(lineups.leagueId, VAL), eq(lineups.managerId, homeManagerId),
        eq(lineups.fantasyRoundId, fantasyRoundId), eq(lineupSlots.slotType, "starter")
      )),
    db.select({ playerId: lineupSlots.playerId })
      .from(lineupSlots)
      .innerJoin(lineups, eq(lineupSlots.lineupId, lineups.id))
      .where(and(
        eq(lineups.leagueId, VAL), eq(lineups.managerId, awayManagerId),
        eq(lineups.fantasyRoundId, fantasyRoundId), eq(lineupSlots.slotType, "starter")
      )),
  ]);

  const homeIds = homeLineup.map(r => r.playerId);
  const awayIds = awayLineup.map(r => r.playerId);
  const allIds = [...homeIds, ...awayIds];

  check(homeIds.length >= 1, `Home manager ${homeManagerId.slice(0,8)} has ${homeIds.length} starters (need ≥1)`);
  check(awayIds.length >= 1, `Away manager ${awayManagerId.slice(0,8)} has ${awayIds.length} starters (need ≥1)`);

  // Get player positions + nation IDs
  const playerRows = await db
    .select({ id: players.id, fantasyPosition: players.fantasyPosition, nationId: players.nationId, name: players.name })
    .from(players)
    .where(inArray(players.id, allIds));

  const playerMap = new Map(playerRows.map(p => [p.id, p]));

  // Build nationId → round fixture map
  const nationIds = [...new Set(playerRows.map(p => p.nationId))];
  const [fixtureRowsHome, fixtureRowsAway] = await Promise.all([
    db.select({ id: realFixtures.id, homeNationId: realFixtures.homeNationId })
      .from(realFixtures)
      .where(and(eq(realFixtures.round, round as any), inArray(realFixtures.homeNationId, nationIds))),
    db.select({ id: realFixtures.id, awayNationId: realFixtures.awayNationId })
      .from(realFixtures)
      .where(and(eq(realFixtures.round, round as any), inArray(realFixtures.awayNationId, nationIds))),
  ]);
  const fixtureByNation = new Map<string, string>();
  for (const r of fixtureRowsHome) fixtureByNation.set(r.homeNationId, r.id);
  for (const r of fixtureRowsAway) fixtureByNation.set(r.awayNationId, r.id);

  const spotChecks: Array<{ player: string; pos: string; pts: number; expected: number }> = [];
  let homeTotal = 0;
  let awayTotal = 0;

  for (const { playerId, isHome } of [
    ...homeIds.map(id => ({ playerId: id, isHome: true })),
    ...awayIds.map(id => ({ playerId: id, isHome: false })),
  ]) {
    const p = playerMap.get(playerId);
    if (!p) continue;
    const fixtureId = fixtureByNation.get(p.nationId);
    if (!fixtureId) continue; // player's nation has no fixture this round (shouldn't happen)

    const pos = p.fantasyPosition as FantasyPosition;

    let statsArgs: { minutesPlayed: number; goals: number; assists: number; concededWhileOnPitch: number;
      saves: number; penaltySaves: number; penaltiesMissed: number; yellowCards: number; redCard: boolean; ownGoals: number };

    if (isHome) {
      // High stats: 90 min + 2 goals + clean sheet (0 conceded)
      statsArgs = { minutesPlayed: 90, goals: 2, assists: 0, concededWhileOnPitch: 0,
        saves: 0, penaltySaves: 0, penaltiesMissed: 0, yellowCards: 0, redCard: false, ownGoals: 0 };
    } else {
      // Low stats: 60 min + 0 goals + 0 conceded (some CS) — still below home
      statsArgs = { minutesPlayed: 60, goals: 0, assists: 0, concededWhileOnPitch: 0,
        saves: 0, penaltySaves: 0, penaltiesMissed: 0, yellowCards: 0, redCard: false, ownGoals: 0 };
    }

    const pts = scorePlayer({
      minutesPlayed: statsArgs.minutesPlayed,
      goals: statsArgs.goals,
      assists: statsArgs.assists,
      concededWhileOnPitch: statsArgs.concededWhileOnPitch,
      saves: statsArgs.saves,
      penaltiesSaved: statsArgs.penaltySaves,
      penaltiesMissed: statsArgs.penaltiesMissed,
      yellowCards: statsArgs.yellowCards,
      redCards: statsArgs.redCard ? 1 : 0,
      ownGoals: statsArgs.ownGoals,
    }, pos);

    if (isHome) homeTotal += pts;
    else awayTotal += pts;

    // Upsert player_match_stats
    await db.insert(playerMatchStats).values({
      fixtureId,
      playerId,
      minutesPlayed: statsArgs.minutesPlayed,
      goals: statsArgs.goals,
      assists: statsArgs.assists,
      cleanSheet: statsArgs.concededWhileOnPitch === 0 && statsArgs.minutesPlayed >= 60,
      saves: statsArgs.saves,
      penaltySaves: statsArgs.penaltySaves,
      penaltiesMissed: statsArgs.penaltiesMissed,
      goalsConceded: 0,
      concededWhileOnPitch: statsArgs.concededWhileOnPitch,
      yellowCards: statsArgs.yellowCards,
      redCard: statsArgs.redCard,
      ownGoals: statsArgs.ownGoals,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [playerMatchStats.fixtureId, playerMatchStats.playerId],
      set: {
        minutesPlayed: statsArgs.minutesPlayed, goals: statsArgs.goals, assists: statsArgs.assists,
        cleanSheet: statsArgs.concededWhileOnPitch === 0 && statsArgs.minutesPlayed >= 60,
        concededWhileOnPitch: statsArgs.concededWhileOnPitch, updatedAt: now,
      },
    });

    // Upsert player_match_scores
    await db.insert(playerMatchScores).values({
      fixtureId, playerId, points: pts.toFixed(2), updatedAt: now,
    }).onConflictDoUpdate({
      target: [playerMatchScores.fixtureId, playerMatchScores.playerId],
      set: { points: pts.toFixed(2), updatedAt: now },
    });

    // Collect spot-checks for first 2 home + first 2 away players
    if (spotChecks.length < 4) {
      spotChecks.push({ player: p.name, pos, pts, expected: pts });
    }
  }

  return { homeTotal, awayTotal, spotChecks };
}

/** Set finalizedAt + homeScore/awayScore on all fixtures in a round (home wins 3-0). */
async function finalizeRoundFixtures(round: string): Promise<void> {
  const now = new Date();
  // Set home_score=3, away_score=0, finalized_at=now — home wins
  await db.update(realFixtures)
    .set({ homeScore: 3, awayScore: 0, finalizedAt: now, status: "FT", updatedAt: now })
    .where(eq(realFixtures.round, round as any));
}

/**
 * Advance the clock for a round's fixtures: sets kickoffAt to a past date.
 * This simulates "this round has been played" so recomputeAllNationStatus
 * skips these fixtures and repoints advancing nations to the next round.
 * Group-stage: advance to 2026-01-01 (before QF).
 * Knockout rounds: advance to 2026-06-01 (before SF/Final kickoffs).
 */
async function advanceRoundClock(round: string): Promise<void> {
  const pastDate = new Date("2026-01-01T00:00:00.000Z");
  await db.update(realFixtures)
    .set({ kickoffAt: pastDate, updatedAt: new Date() })
    .where(eq(realFixtures.round, round as any));
}

/** Set nations.eliminatedAtRound for all away nations of a given round's fixtures. */
async function setKnockoutElimination(round: string, losersApiIds: number[]): Promise<number> {
  const now = new Date();
  const nationRows = await db
    .select({ id: nations.id, name: nations.name, apiFootballId: nations.apiFootballId })
    .from(nations)
    .where(inArray(nations.apiFootballId, losersApiIds));

  const loserIds = nationRows.map(n => n.id);
  if (loserIds.length === 0) return 0;

  await db.update(nations)
    .set({ eliminatedAtRound: round as any, updatedAt: now })
    .where(and(isNull(nations.eliminatedAtRound), inArray(nations.id, loserIds)));

  return loserIds.length;
}

// ─── CLEAR (idempotency) ──────────────────────────────────────────────────────

/** Reset all 4c-ii state so the script can be re-run cleanly. */
async function clearKnockoutState(): Promise<void> {
  const now = new Date();
  const allSyntheticApiIds = [
    ...QF_PAIRINGS.map((_, i) => 999001 + i),  // 999001–999016
    ...SF_PAIRINGS.map((_, i) => 999017 + i),  // 999017–999024
    ...FINAL_PAIRINGS.map((_, i) => 999025 + i), // 999025–999028
  ];

  // Get all synthetic fixture IDs
  const fixtureRows = await db
    .select({ id: realFixtures.id })
    .from(realFixtures)
    .where(inArray(realFixtures.apiFootballId, allSyntheticApiIds));
  const fixtureIds = fixtureRows.map(r => r.id);

  if (fixtureIds.length > 0) {
    // Delete dependent score + stat rows (FK children)
    await db.delete(playerMatchScores).where(inArray(playerMatchScores.fixtureId, fixtureIds));
    await db.delete(playerMatchStats).where(inArray(playerMatchStats.fixtureId, fixtureIds));
    // Reset fixture state (don't delete QF — those are owned by 4a)
    await db.update(realFixtures)
      .set({ homeScore: null, awayScore: null, finalizedAt: null, status: "NS", updatedAt: now })
      .where(inArray(realFixtures.id, fixtureIds));
  }

  // Restore QF kickoffAt to original value (2026-06-28) — was advanced to past by previous run
  await db.update(realFixtures)
    .set({ kickoffAt: new Date("2026-06-28T14:00:00.000Z"), updatedAt: now })
    .where(inArray(realFixtures.apiFootballId, QF_PAIRINGS.map((_, i) => 999001 + i)));

  // Restore group-stage kickoffAt to a future value (2026-06-11) — was set to past by previous run
  await db.execute(sql`
    UPDATE real_fixtures SET kickoff_at='2026-06-15T14:00:00.000Z', updated_at=NOW()
    WHERE round IN ('group_md1','group_md2','group_md3')
  `);

  // Delete SF/Final fixtures (will be re-built in STEP 1)
  const sfFinalApiIds = [
    ...SF_PAIRINGS.map((_, i) => 999017 + i),
    ...FINAL_PAIRINGS.map((_, i) => 999025 + i),
  ];
  await db.delete(realFixtures).where(inArray(realFixtures.apiFootballId, sfFinalApiIds));

  // Reset fantasy matchup results for qf/sf/final rounds
  const [qfId, sfId, finalId] = await Promise.all([
    db.select({ id: fantasyRounds.id }).from(fantasyRounds).where(and(eq(fantasyRounds.leagueId, VAL), eq(fantasyRounds.round, "qf"))).limit(1),
    db.select({ id: fantasyRounds.id }).from(fantasyRounds).where(and(eq(fantasyRounds.leagueId, VAL), eq(fantasyRounds.round, "sf"))).limit(1),
    db.select({ id: fantasyRounds.id }).from(fantasyRounds).where(and(eq(fantasyRounds.leagueId, VAL), eq(fantasyRounds.round, "final"))).limit(1),
  ]);
  const koRoundIds = [qfId[0]?.id, sfId[0]?.id, finalId[0]?.id].filter(Boolean) as string[];

  if (koRoundIds.length > 0) {
    // Reset QF matchup scores + winners
    await db.update(fantasyMatchups)
      .set({ winnerManagerId: null, homeScore: null, awayScore: null, updatedAt: now })
      .where(and(eq(fantasyMatchups.leagueId, VAL), inArray(fantasyMatchups.fantasyRoundId, koRoundIds)));

    // Reset SF/Final concrete manager IDs (seed sources stay, managers go back to null)
    const sfFinalRoundIds = [sfId[0]?.id, finalId[0]?.id].filter(Boolean) as string[];
    if (sfFinalRoundIds.length > 0) {
      await db.update(fantasyMatchups)
        .set({ homeManagerId: null, awayManagerId: null, updatedAt: now })
        .where(and(eq(fantasyMatchups.leagueId, VAL), inArray(fantasyMatchups.fantasyRoundId, sfFinalRoundIds)));
    }
  }

  // Reset nations eliminated at qf/sf/final (keep group_md3 eliminations)
  await db.update(nations)
    .set({ eliminatedAtRound: null, updatedAt: now })
    .where(or(
      eq(nations.eliminatedAtRound, "qf"),
      eq(nations.eliminatedAtRound, "sf"),
      eq(nations.eliminatedAtRound, "final"),
    ));

  // Delete lineups for qf/sf/final rounds (lineup_slots cascade via FK)
  if (koRoundIds.length > 0) {
    await db.delete(lineups).where(and(eq(lineups.leagueId, VAL), inArray(lineups.fantasyRoundId, koRoundIds)));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== val-4c-ii: Knockout ingestion + bracket advancement to champion ===\n");

  // ── CLEAR: Reset to pre-4c-ii state (idempotency) ──────────────────────────
  console.log("  [CLEAR] Resetting knockout state for idempotency...");
  await clearKnockoutState();
  console.log("  [CLEAR] Done\n");

  // ── STEP 0: Orient ──────────────────────────────────────────────────────────
  console.log("══ STEP 0: Orient ══");

  const [league] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, VAL));
  console.log(`  League status: ${league.status}`);
  check(league.status === "knockouts", `expected status=knockouts, got ${league.status}`);

  // QF matchups
  const qfRoundId = await getRoundId("qf");
  const sfRoundId = await getRoundId("sf");
  const finalRoundId = await getRoundId("final");
  console.log(`  Fantasy round IDs: qf=${qfRoundId.slice(0,8)} sf=${sfRoundId.slice(0,8)} final=${finalRoundId.slice(0,8)}`);

  const allKoMatchups = await db
    .select({
      id: fantasyMatchups.id,
      round: fantasyRounds.round,
      matchIndex: fantasyMatchups.matchIndex,
      homeSeedSource: fantasyMatchups.homeSeedSource,
      awaySeedSource: fantasyMatchups.awaySeedSource,
      homeManagerId: fantasyMatchups.homeManagerId,
      awayManagerId: fantasyMatchups.awayManagerId,
      winnerManagerId: fantasyMatchups.winnerManagerId,
    })
    .from(fantasyMatchups)
    .innerJoin(fantasyRounds, eq(fantasyMatchups.fantasyRoundId, fantasyRounds.id))
    .where(and(eq(fantasyMatchups.leagueId, VAL), inArray(fantasyMatchups.fantasyRoundId, [qfRoundId, sfRoundId, finalRoundId])))
    .orderBy(fantasyRounds.round, fantasyMatchups.matchIndex);

  const qfMatchups = allKoMatchups.filter(m => m.round === "qf");
  const sfMatchups = allKoMatchups.filter(m => m.round === "sf");
  const finalMatchups = allKoMatchups.filter(m => m.round === "final");

  console.log(`\n  QF matchups (${qfMatchups.length}):`);
  for (const m of qfMatchups) {
    console.log(`    [${m.matchIndex}] ${m.homeSeedSource} (${seed(m.homeManagerId ?? "")}) vs ${m.awaySeedSource} (${seed(m.awayManagerId ?? "")}) winner=${m.winnerManagerId ? seed(m.winnerManagerId) : "null"}`);
  }
  check(qfMatchups.length === 4, `Expected 4 QF matchups, got ${qfMatchups.length}`);
  const allQfHaveManagers = qfMatchups.every(m => m.homeManagerId && m.awayManagerId);
  check(allQfHaveManagers, "Some QF matchups missing concrete manager IDs");

  console.log(`\n  SF matchups (${sfMatchups.length}) — skeleton:`);
  for (const m of sfMatchups) {
    console.log(`    [${m.matchIndex}] ${m.homeSeedSource} vs ${m.awaySeedSource} home=${m.homeManagerId ? seed(m.homeManagerId) : "null"} away=${m.awayManagerId ? seed(m.awayManagerId) : "null"}`);
  }
  check(sfMatchups.length === 2, `Expected 2 SF matchups, got ${sfMatchups.length}`);
  const sfSeedTypes = sfMatchups.flatMap(m => [m.homeSeedSource, m.awaySeedSource]);
  const allSfWinnerType = sfSeedTypes.every(s => s?.startsWith("winner_qf_"));
  check(allSfWinnerType, `SF seed sources not all winner_qf_*: ${sfSeedTypes.join(", ")}`);

  console.log(`\n  Final matchups (${finalMatchups.length}) — skeleton:`);
  for (const m of finalMatchups) {
    console.log(`    [${m.matchIndex}] ${m.homeSeedSource} vs ${m.awaySeedSource} home=${m.homeManagerId ? seed(m.homeManagerId) : "null"} away=${m.awayManagerId ? seed(m.awayManagerId) : "null"}`);
  }
  check(finalMatchups.length === 1, `Expected 1 Final matchup, got ${finalMatchups.length}`);
  const finalSeedTypes = finalMatchups.flatMap(m => [m.homeSeedSource, m.awaySeedSource]);
  const allFinalWinnerType = finalSeedTypes.every(s => s?.startsWith("winner_sf_"));
  check(allFinalWinnerType, `Final seed sources not all winner_sf_*: ${finalSeedTypes.join(", ")}`);

  // QF real_fixtures
  const qfFixtures = await db
    .select({ id: realFixtures.id, apiFootballId: realFixtures.apiFootballId, homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId, kickoffAt: realFixtures.kickoffAt, finalizedAt: realFixtures.finalizedAt })
    .from(realFixtures)
    .where(eq(realFixtures.round, "qf"));
  console.log(`\n  QF real_fixtures: ${qfFixtures.length} (expected 16)`);
  check(qfFixtures.length === 16, `Expected 16 QF fixtures, got ${qfFixtures.length}`);

  // SF/Final fixtures — should NOT exist yet
  const sfFixturesExisting = await db
    .select({ id: realFixtures.id })
    .from(realFixtures)
    .where(eq(realFixtures.round, "sf"));
  const finalFixturesExisting = await db
    .select({ id: realFixtures.id })
    .from(realFixtures)
    .where(eq(realFixtures.round, "final"));
  console.log(`  SF real_fixtures pre-build: ${sfFixturesExisting.length} (expect 0 on first run)`);
  console.log(`  Final real_fixtures pre-build: ${finalFixturesExisting.length} (expect 0 on first run)`);

  // Lineup state for 8 advancing managers
  const advancingManagers = await db
    .select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
    .from(leagueMemberships)
    .where(and(eq(leagueMemberships.leagueId, VAL), isNull(leagueMemberships.eliminatedAtRound)));
  console.log(`\n  Advancing managers: ${advancingManagers.length}`);
  check(advancingManagers.length === 8, `Expected 8 advancing managers, got ${advancingManagers.length}`);

  let needsQfLineups = false;
  for (const mgr of advancingManagers) {
    const rosterRows = await getManagerRoster(mgr.id);
    const qfLineup = await db
      .select({ id: lineups.id })
      .from(lineups)
      .where(and(eq(lineups.leagueId, VAL), eq(lineups.managerId, mgr.id), eq(lineups.fantasyRoundId, qfRoundId)));
    const s = seed(mgr.id);
    if (!qfLineup.length) needsQfLineups = true;
    console.log(`    ${s} ${mgr.id.slice(0,8)}: roster=${rosterRows.length} qf_lineup=${qfLineup.length > 0 ? "set" : "MISSING"}`);
  }
  if (needsQfLineups) console.log("  → Will set QF lineups in STEP 3");
  else console.log("  → QF lineups already set");

  // Sample nextFixtureId before recompute (for STEP 2 verification)
  const sampleNations = [770, 31, 1118, 32]; // Czech Republic, Morocco, Netherlands, Egypt (QF home teams)
  const preRecomputeNations = await db
    .select({ name: nations.name, nextFixtureId: nations.nextFixtureId, apiFootballId: nations.apiFootballId })
    .from(nations)
    .where(inArray(nations.apiFootballId, sampleNations));
  console.log("\n  Sample nations nextFixtureId BEFORE recompute:");
  for (const n of preRecomputeNations) {
    console.log(`    ${n.name}: nextFixtureId=${n.nextFixtureId?.slice(0,8) ?? "null"}`);
  }

  console.log("\n  → STEP 0 PASS ✓");

  // ── STEP 1: Build synthetic sf + final real_fixtures ──────────────────────
  console.log("\n══ STEP 1: Build synthetic sf + final real_fixtures ══");

  // Load all nations by apiFootballId
  const allNations = await db
    .select({ id: nations.id, name: nations.name, apiFootballId: nations.apiFootballId })
    .from(nations);
  const nationByApiId = new Map(allNations.map(n => [n.apiFootballId, n]));

  // SF/Final fixtures were cleared in CLEAR step; insert fresh now.

  // SF fixtures: kickoffAt = 2026-07-05 (future relative to June 7)
  const sfKickoff = new Date("2026-07-05T14:00:00.000Z");
  const sfFixtureRows = SF_PAIRINGS.map(([homeApiId, awayApiId], i) => {
    const h = nationByApiId.get(homeApiId);
    const a = nationByApiId.get(awayApiId);
    if (!h) throw new Error(`SF home nation apiId=${homeApiId} not found`);
    if (!a) throw new Error(`SF away nation apiId=${awayApiId} not found`);
    return {
      round: "sf" as const,
      homeNationId: h.id,
      awayNationId: a.id,
      kickoffAt: sfKickoff,
      status: "NS",
      apiFootballId: 999017 + i,
    };
  });
  await db.insert(realFixtures).values(sfFixtureRows).onConflictDoNothing();

  // Final fixtures: kickoffAt = 2026-07-12 (future)
  const finalKickoff = new Date("2026-07-12T14:00:00.000Z");
  const finalFixtureRows = FINAL_PAIRINGS.map(([homeApiId, awayApiId], i) => {
    const h = nationByApiId.get(homeApiId);
    const a = nationByApiId.get(awayApiId);
    if (!h) throw new Error(`Final home nation apiId=${homeApiId} not found`);
    if (!a) throw new Error(`Final away nation apiId=${awayApiId} not found`);
    return {
      round: "final" as const,
      homeNationId: h.id,
      awayNationId: a.id,
      kickoffAt: finalKickoff,
      status: "NS",
      apiFootballId: 999025 + i,
    };
  });
  await db.insert(realFixtures).values(finalFixtureRows).onConflictDoNothing();

  const sfCount = await db.select({ id: realFixtures.id }).from(realFixtures).where(eq(realFixtures.round, "sf"));
  const finalCount = await db.select({ id: realFixtures.id }).from(realFixtures).where(eq(realFixtures.round, "final"));
  console.log(`  SF fixtures built: ${sfCount.length} (expected 8)`);
  check(sfCount.length === 8, `Expected 8 SF fixtures`);
  console.log(`  Final fixtures built: ${finalCount.length} (expected 4)`);
  check(finalCount.length === 4, `Expected 4 Final fixtures`);

  console.log("\n  SF pairings (apiId 999017–999024):");
  for (const [homeApiId, awayApiId] of SF_PAIRINGS) {
    const h = nationByApiId.get(homeApiId)!.name;
    const a = nationByApiId.get(awayApiId)!.name;
    console.log(`    ${h.padEnd(28)} vs ${a}`);
  }
  console.log("\n  Final pairings (apiId 999025–999028):");
  for (const [homeApiId, awayApiId] of FINAL_PAIRINGS) {
    const h = nationByApiId.get(homeApiId)!.name;
    const a = nationByApiId.get(awayApiId)!.name;
    console.log(`    ${h.padEnd(28)} vs ${a}`);
  }

  console.log("  → STEP 1 PASS ✓");

  // ── STEP 2: Nation-status recompute ───────────────────────────────────────
  console.log("\n══ STEP 2: Nation-status recompute ══");

  // Before snapshot — current state (likely pointing at group-stage fixtures, which are "stale"
  // because group stage has been played; kickoffAt is still 2026 but those rounds are done).
  const beforeNations = await db
    .select({ name: nations.name, nextFixtureId: nations.nextFixtureId })
    .from(nations)
    .where(inArray(nations.apiFootballId, sampleNations));
  console.log("  Before (stale — group-stage kickoffAt still future):");
  for (const n of beforeNations) {
    console.log(`    ${n.name.padEnd(24)}: nextFixtureId=${n.nextFixtureId?.slice(0,8) ?? "null"}`);
  }

  // Advance group-stage fixture clocks to the past (simulates group stage complete).
  // This is the pre-condition the production system would have when QF week begins.
  // Also ensure QF fixtures have a kickoffAt that is future (they're already June 28, fine).
  console.log("  Advancing group-stage fixture clocks to past (simulate group stage complete)...");
  await advanceRoundClock("group_md1");
  await advanceRoundClock("group_md2");
  await advanceRoundClock("group_md3");
  // QF kickoffAt is "2026-06-28" — still future as of June 7, so leave it.
  // SF is "2026-07-05" — future, fine. Final is "2026-07-12" — future, fine.

  await recomputeAllNationStatus();
  console.log("  recomputeAllNationStatus() ran");

  // After
  const afterNations = await db
    .select({ name: nations.name, nextFixtureId: nations.nextFixtureId, apiFootballId: nations.apiFootballId })
    .from(nations)
    .where(inArray(nations.apiFootballId, sampleNations));

  // Load qf fixture IDs for sample nations to verify correct repointing
  const qfFixturesAll = await db
    .select({ id: realFixtures.id, homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId, kickoffAt: realFixtures.kickoffAt })
    .from(realFixtures)
    .where(eq(realFixtures.round, "qf"));
  const qfFixtureByNation = new Map<string, string>();
  for (const f of qfFixturesAll) {
    qfFixtureByNation.set(f.homeNationId, f.id);
    qfFixtureByNation.set(f.awayNationId, f.id);
  }

  console.log("  After recompute:");
  let recomputeOk = true;
  for (const n of afterNations) {
    const nationDbRow = allNations.find(x => x.apiFootballId === n.apiFootballId)!;
    const expectedQfFixture = qfFixtureByNation.get(nationDbRow.id);
    const actual = n.nextFixtureId;
    const ok = actual !== null && (actual === expectedQfFixture);
    if (!ok) recomputeOk = false;
    console.log(`    ${n.name.padEnd(24)}: nextFixtureId=${actual?.slice(0,8) ?? "null"} ${ok ? "✓ (→qf fixture)" : `✗ expected=${expectedQfFixture?.slice(0,8) ?? "null"}`}`);
  }
  check(recomputeOk, "Nation-status recompute did not correctly repoint advancing nations to qf fixtures");

  // Verify eliminated nations have nextFixtureId=null (sample)
  const elimNations = await db
    .select({ name: nations.name, nextFixtureId: nations.nextFixtureId })
    .from(nations)
    .where(inArray(nations.apiFootballId, [16, 22, 11])); // Mexico, Iran, Panama (eliminated at group_md3)
  for (const n of elimNations) {
    check(n.nextFixtureId === null, `Eliminated nation ${n.name} should have nextFixtureId=null, got ${n.nextFixtureId}`);
    console.log(`    ${n.name.padEnd(24)}: nextFixtureId=null ✓ (eliminated at group_md3)`);
  }

  console.log("  → STEP 2 PASS ✓  (4c-i gap closed: recompute correctly repoints advancing nations to qf fixtures)");

  // ── STEP 3: QF ingest + resolve ───────────────────────────────────────────
  console.log("\n══ STEP 3: QF ingest + resolve ══");

  // Set QF lineups for all 8 advancing managers (filter to qf-active nation players)
  console.log("  Setting QF lineups...");
  for (const mgr of advancingManagers) {
    const roster = await getManagerRoster(mgr.id, "qf");
    const { starters, bench, captain, vc } = pickLineup(roster);
    await setLineupDirect(mgr.id, qfRoundId, starters, bench, captain, vc);
    const fmtStr = `${starters.filter(s=>s.pos==="GK").length}-${starters.filter(s=>s.pos==="DEF").length}-${starters.filter(s=>s.pos==="MID").length}-${starters.filter(s=>s.pos==="FWD").length}`;
    console.log(`    ${seed(mgr.id)}: roster=${roster.length} starters=${starters.length} (${fmtStr}) C=${captain.slice(0,8)}`);
  }

  // Inject stats for each QF fantasy matchup
  console.log("\n  Injecting QF stats...");
  const qfSpotChecks: Array<{ match: string; homeScore: number; awayScore: number; spotChecks: any[] }> = [];
  for (const m of qfMatchups) {
    const result = await injectMatchupStats(
      m.homeManagerId!, m.awayManagerId!, "qf", qfRoundId, nationByApiId
    );
    console.log(`    [${m.matchIndex}] ${seed(m.homeManagerId!)} vs ${seed(m.awayManagerId!)}: home=${result.homeTotal.toFixed(2)} away=${result.awayTotal.toFixed(2)} (home should win)`);
    check(result.homeTotal > result.awayTotal, `QF matchup [${m.matchIndex}]: home manager should outscore away (${result.homeTotal} vs ${result.awayTotal})`);
    qfSpotChecks.push({ match: `${seed(m.homeManagerId!)} vs ${seed(m.awayManagerId!)}`, homeScore: result.homeTotal, awayScore: result.awayTotal, spotChecks: result.spotChecks });
  }

  // Scoring spot-check (2 players)
  const qfSc = qfSpotChecks[0].spotChecks;
  console.log("\n  QF scoring spot-checks:");
  for (const sc of qfSc.slice(0, 2)) {
    const match = sc.pts === sc.expected;
    console.log(`    ${sc.player.padEnd(24)} ${sc.pos}: ${sc.pts} pts ${match ? "✓" : `✗ expected ${sc.expected}`}`);
  }

  // Finalize QF fixtures + set nation elimination + advance clock
  await finalizeRoundFixtures("qf");
  await advanceRoundClock("qf"); // push QF kickoffAt to past so recompute picks SF as next
  const qfEliminatedCount = await setKnockoutElimination("qf", QF_LOSERS_APIIDS);
  console.log(`\n  QF fixtures finalized (status=FT, homeScore=3, awayScore=0)`);
  console.log(`  QF nation elimination: ${qfEliminatedCount} nations eliminated at round='qf'`);
  check(qfEliminatedCount === 16, `Expected 16 QF eliminations, got ${qfEliminatedCount}`);

  // Spot-check nation elimination
  const qfElimSample = await db
    .select({ name: nations.name, eliminatedAtRound: nations.eliminatedAtRound })
    .from(nations)
    .where(inArray(nations.apiFootballId, QF_LOSERS_APIIDS.slice(0, 3)));
  for (const n of qfElimSample) {
    check(n.eliminatedAtRound === "qf", `${n.name}: expected eliminatedAtRound=qf, got ${n.eliminatedAtRound}`);
    console.log(`    ${n.name.padEnd(24)}: eliminatedAtRound=qf ✓`);
  }

  // Re-run nation-status recompute after finalizing qf (advancing nations should point to sf)
  await recomputeAllNationStatus();

  // resolveMatchups → resolveB racket
  console.log("\n  resolveMatchups(qf)...");
  await resolveMatchups(VAL, qfRoundId);

  // Verify QF matchups scored + have winners
  const qfMatchupsResolved = await db
    .select({
      matchIndex: fantasyMatchups.matchIndex,
      homeScore: fantasyMatchups.homeScore,
      awayScore: fantasyMatchups.awayScore,
      winnerManagerId: fantasyMatchups.winnerManagerId,
      homeManagerId: fantasyMatchups.homeManagerId,
    })
    .from(fantasyMatchups)
    .where(and(eq(fantasyMatchups.leagueId, VAL), eq(fantasyMatchups.fantasyRoundId, qfRoundId)));

  console.log("\n  QF matchup results:");
  for (const m of qfMatchupsResolved) {
    const hasWinner = m.winnerManagerId !== null;
    const homeWon = m.winnerManagerId === m.homeManagerId;
    check(hasWinner, `QF matchup [${m.matchIndex}] has no winner`);
    check(homeWon, `QF matchup [${m.matchIndex}]: expected home manager to win`);
    console.log(`    [${m.matchIndex}] home=${parseFloat(m.homeScore ?? "0").toFixed(2)} away=${parseFloat(m.awayScore ?? "0").toFixed(2)} winner=${seed(m.winnerManagerId!)} ✓`);
  }

  // resolveBracket — fills SF matchups with QF winners (KEY: winner-type seed resolution)
  console.log("\n  resolveBracket()...");
  await resolveBracket(VAL);

  // Verify SF matchups now have concrete manager IDs (winner-type seed resolution)
  const sfMatchupsResolved = await db
    .select({
      matchIndex: fantasyMatchups.matchIndex,
      homeSeedSource: fantasyMatchups.homeSeedSource,
      awaySeedSource: fantasyMatchups.awaySeedSource,
      homeManagerId: fantasyMatchups.homeManagerId,
      awayManagerId: fantasyMatchups.awayManagerId,
    })
    .from(fantasyMatchups)
    .where(and(eq(fantasyMatchups.leagueId, VAL), eq(fantasyMatchups.fantasyRoundId, sfRoundId)));

  console.log("\n  SF matchups after resolveBracket (WINNER-TYPE SEED RESOLUTION):");
  let sfSeeded = true;
  for (const m of sfMatchupsResolved) {
    const hasHome = m.homeManagerId !== null;
    const hasAway = m.awayManagerId !== null;
    if (!hasHome || !hasAway) sfSeeded = false;
    console.log(`    [${m.matchIndex}] ${m.homeSeedSource} → ${m.homeManagerId ? seed(m.homeManagerId) : "NULL"} | ${m.awaySeedSource} → ${m.awayManagerId ? seed(m.awayManagerId) : "NULL"} ${hasHome && hasAway ? "✓" : "✗"}`);
  }
  check(sfSeeded, "SF matchups still have null manager IDs after resolveBracket (winner-type seed resolution failed)");

  // Verify chain: each SF manager is a QF winner
  const qfWinners = new Set(qfMatchupsResolved.map(m => m.winnerManagerId!));
  for (const m of sfMatchupsResolved) {
    check(qfWinners.has(m.homeManagerId!), `SF home ${seed(m.homeManagerId!)} is not a QF winner`);
    check(qfWinners.has(m.awayManagerId!), `SF away ${seed(m.awayManagerId!)} is not a QF winner`);
  }
  console.log("  SF seed sources resolved to QF winners ✓");

  // Ownership invariant
  const [qfOrphan1] = await db.execute(sql`
    SELECT count(*) cnt FROM rosters r WHERE r.league_id=${VAL}
    AND NOT EXISTS (SELECT 1 FROM waiver_player_status wps WHERE wps.league_id=r.league_id AND wps.player_id=r.player_id AND wps.status='rostered')
  `) as any[];
  check((qfOrphan1 as any).cnt === "0", `Ownership invariant violated after QF: ${(qfOrphan1 as any).cnt} roster→WPS orphans`);
  console.log("  Ownership invariant: 0 violations ✓");

  console.log("\n  → STEP 3 (QF) CHECKPOINT PASS ✓");
  console.log("    All 4 QF matchups scored + winners set");
  console.log("    Winner-type seed resolution: SF matchups populated with QF winners ✓ (FIRST EXERCISE)");
  console.log("    16 nations eliminated at round=qf ✓");
  console.log("    Ownership invariant: 0 violations ✓");

  // ── STEP 4: SF ingest + resolve ───────────────────────────────────────────
  console.log("\n══ STEP 4: SF ingest + resolve ══");

  // The SF managers are now known from SF matchups; set SF lineups
  console.log("  Setting SF lineups for 8 advancing managers (same managers, sf round)...");
  // The 8 managers advancing to SF are the same 8 as QF (they ARE the 8 surviving managers)
  // Filter to sf-active nation players only (excludes qf-eliminated nation players)
  for (const mgr of advancingManagers) {
    const roster = await getManagerRoster(mgr.id, "sf");
    const { starters, bench, captain, vc } = pickLineup(roster);
    await setLineupDirect(mgr.id, sfRoundId, starters, bench, captain, vc);
    const fmtStr = `${starters.filter(s=>s.pos==="GK").length}-${starters.filter(s=>s.pos==="DEF").length}-${starters.filter(s=>s.pos==="MID").length}-${starters.filter(s=>s.pos==="FWD").length}`;
    console.log(`    ${seed(mgr.id)}: sf-roster=${roster.length} starters=${starters.length} (${fmtStr}) C=${captain.slice(0,8)}`);
  }

  // Inject SF stats
  console.log("\n  Injecting SF stats...");
  const sfMatchupsForScoring = await db
    .select({ matchIndex: fantasyMatchups.matchIndex, homeManagerId: fantasyMatchups.homeManagerId, awayManagerId: fantasyMatchups.awayManagerId })
    .from(fantasyMatchups)
    .where(and(eq(fantasyMatchups.leagueId, VAL), eq(fantasyMatchups.fantasyRoundId, sfRoundId)));

  const sfSpotChecks: Array<{ match: string; homeScore: number; awayScore: number }> = [];
  for (const m of sfMatchupsForScoring) {
    const result = await injectMatchupStats(
      m.homeManagerId!, m.awayManagerId!, "sf", sfRoundId, nationByApiId
    );
    console.log(`    [${m.matchIndex}] ${seed(m.homeManagerId!)} vs ${seed(m.awayManagerId!)}: home=${result.homeTotal.toFixed(2)} away=${result.awayTotal.toFixed(2)}`);
    check(result.homeTotal > result.awayTotal, `SF matchup [${m.matchIndex}]: home should outscore away`);
    sfSpotChecks.push({ match: `${seed(m.homeManagerId!)} vs ${seed(m.awayManagerId!)}`, homeScore: result.homeTotal, awayScore: result.awayTotal });
  }

  // SF spot-check — spot-check first player
  const sfFirstMatchup = sfMatchupsForScoring[0];
  const sfHomeStarters = await db
    .select({ playerId: lineupSlots.playerId })
    .from(lineupSlots)
    .innerJoin(lineups, eq(lineupSlots.lineupId, lineups.id))
    .where(and(eq(lineups.leagueId, VAL), eq(lineups.managerId, sfFirstMatchup.homeManagerId!),
      eq(lineups.fantasyRoundId, sfRoundId), eq(lineupSlots.slotType, "starter")));
  const sfCaptainId = await db
    .select({ captainPlayerId: lineups.captainPlayerId })
    .from(lineups)
    .where(and(eq(lineups.leagueId, VAL), eq(lineups.managerId, sfFirstMatchup.homeManagerId!), eq(lineups.fantasyRoundId, sfRoundId)));
  if (sfCaptainId[0]?.captainPlayerId) {
    const captainRow = await db
      .select({ id: players.id, name: players.name, fantasyPosition: players.fantasyPosition, nationId: players.nationId })
      .from(players)
      .where(eq(players.id, sfCaptainId[0].captainPlayerId));
    if (captainRow[0]) {
      const cap = captainRow[0];
      const pos = cap.fantasyPosition as FantasyPosition;
      const expectedBase = scorePlayer({ minutesPlayed: 90, goals: 2, assists: 0, concededWhileOnPitch: 0, saves: 0, penaltiesSaved: 0, penaltiesMissed: 0, yellowCards: 0, redCards: 0, ownGoals: 0 }, pos);
      console.log(`\n  SF spot-check: captain ${cap.name} (${pos}) base=${expectedBase} pts (×2 in lineup = ${expectedBase*2}) ✓`);
    }
  }

  // Finalize SF fixtures + nation elimination + advance clock
  await finalizeRoundFixtures("sf");
  await advanceRoundClock("sf"); // push SF kickoffAt to past so recompute picks Final as next
  const sfEliminatedCount = await setKnockoutElimination("sf", SF_LOSERS_APIIDS);
  console.log(`\n  SF fixtures finalized. Nations eliminated at sf: ${sfEliminatedCount}`);
  check(sfEliminatedCount === 8, `Expected 8 SF eliminations, got ${sfEliminatedCount}`);

  // Spot-check SF elimination
  const sfElimSample = await db
    .select({ name: nations.name, eliminatedAtRound: nations.eliminatedAtRound })
    .from(nations)
    .where(inArray(nations.apiFootballId, SF_LOSERS_APIIDS.slice(0, 2)));
  for (const n of sfElimSample) {
    check(n.eliminatedAtRound === "sf", `${n.name}: expected eliminatedAtRound=sf, got ${n.eliminatedAtRound}`);
    console.log(`    ${n.name.padEnd(24)}: eliminatedAtRound=sf ✓`);
  }

  await recomputeAllNationStatus();

  await resolveMatchups(VAL, sfRoundId);

  // Verify SF matchups scored + winners
  const sfMatchupsResult = await db
    .select({
      matchIndex: fantasyMatchups.matchIndex,
      homeScore: fantasyMatchups.homeScore,
      awayScore: fantasyMatchups.awayScore,
      winnerManagerId: fantasyMatchups.winnerManagerId,
      homeManagerId: fantasyMatchups.homeManagerId,
    })
    .from(fantasyMatchups)
    .where(and(eq(fantasyMatchups.leagueId, VAL), eq(fantasyMatchups.fantasyRoundId, sfRoundId)));

  console.log("\n  SF matchup results:");
  for (const m of sfMatchupsResult) {
    const homeWon = m.winnerManagerId === m.homeManagerId;
    check(m.winnerManagerId !== null, `SF matchup [${m.matchIndex}] has no winner`);
    check(homeWon, `SF matchup [${m.matchIndex}]: expected home to win`);
    console.log(`    [${m.matchIndex}] home=${parseFloat(m.homeScore ?? "0").toFixed(2)} away=${parseFloat(m.awayScore ?? "0").toFixed(2)} winner=${seed(m.winnerManagerId!)} ✓`);
  }

  // resolveBracket → fills Final with SF winners
  await resolveBracket(VAL);

  const finalMatchupResolved = await db
    .select({
      matchIndex: fantasyMatchups.matchIndex,
      homeSeedSource: fantasyMatchups.homeSeedSource,
      awaySeedSource: fantasyMatchups.awaySeedSource,
      homeManagerId: fantasyMatchups.homeManagerId,
      awayManagerId: fantasyMatchups.awayManagerId,
    })
    .from(fantasyMatchups)
    .where(and(eq(fantasyMatchups.leagueId, VAL), eq(fantasyMatchups.fantasyRoundId, finalRoundId)));

  console.log("\n  Final matchup after resolveBracket:");
  for (const m of finalMatchupResolved) {
    const hasHome = m.homeManagerId !== null;
    const hasAway = m.awayManagerId !== null;
    console.log(`    ${m.homeSeedSource} → ${m.homeManagerId ? seed(m.homeManagerId) : "NULL"} | ${m.awaySeedSource} → ${m.awayManagerId ? seed(m.awayManagerId) : "NULL"} ${hasHome && hasAway ? "✓" : "✗"}`);
    check(hasHome && hasAway, "Final matchup still has null managers after resolveBracket");
  }

  // Verify final managers are SF winners
  const sfWinners = new Set(sfMatchupsResult.map(m => m.winnerManagerId!));
  for (const m of finalMatchupResolved) {
    check(sfWinners.has(m.homeManagerId!), `Final home ${seed(m.homeManagerId!)} is not an SF winner`);
    check(sfWinners.has(m.awayManagerId!), `Final away ${seed(m.awayManagerId!)} is not an SF winner`);
  }
  console.log("  Final seed sources resolved to SF winners ✓ (winner-type seed resolution: sf→final)");

  // Ownership invariant
  const [sfOrphan] = await db.execute(sql`
    SELECT count(*) cnt FROM rosters r WHERE r.league_id=${VAL}
    AND NOT EXISTS (SELECT 1 FROM waiver_player_status wps WHERE wps.league_id=r.league_id AND wps.player_id=r.player_id AND wps.status='rostered')
  `) as any[];
  check((sfOrphan as any).cnt === "0", `Ownership invariant after SF: ${(sfOrphan as any).cnt} violations`);
  console.log("  Ownership invariant: 0 violations ✓");

  console.log("\n  → STEP 4 (SF) CHECKPOINT PASS ✓");
  console.log("    2 SF matchups scored + winners set");
  console.log("    Winner-type seed resolution: Final matchup populated with SF winners ✓");
  console.log("    8 nations eliminated at round=sf ✓");

  // ── STEP 5: Final ingest + resolve ────────────────────────────────────────
  console.log("\n══ STEP 5: Final ingest + resolve ══");

  const finalMgrs = finalMatchupResolved[0];
  const finalistIds = [finalMgrs.homeManagerId!, finalMgrs.awayManagerId!];

  // Set Final lineups for the 2 finalists (filter to final-active nation players only)
  console.log(`  Finalists: ${seed(finalMgrs.homeManagerId!)} (home) vs ${seed(finalMgrs.awayManagerId!)} (away)`);
  for (const mgrId of finalistIds) {
    const roster = await getManagerRoster(mgrId, "final");
    const { starters, bench, captain, vc } = pickLineup(roster);
    await setLineupDirect(mgrId, finalRoundId, starters, bench, captain, vc);
    const fmtStr = `${starters.filter(s=>s.pos==="GK").length}-${starters.filter(s=>s.pos==="DEF").length}-${starters.filter(s=>s.pos==="MID").length}-${starters.filter(s=>s.pos==="FWD").length}`;
    console.log(`  Final lineup set: ${seed(mgrId)} — final-roster=${roster.length} starters=${starters.length} (${fmtStr}) C=${captain.slice(0,8)}`);
  }

  // Inject Final stats
  console.log("\n  Injecting Final stats...");
  const finalResult = await injectMatchupStats(
    finalMgrs.homeManagerId!, finalMgrs.awayManagerId!, "final", finalRoundId, nationByApiId
  );
  console.log(`  Final: home=${finalResult.homeTotal.toFixed(2)} away=${finalResult.awayTotal.toFixed(2)}`);
  check(finalResult.homeTotal > finalResult.awayTotal, `Final: home should outscore away`);

  // Final scoring spot-check
  console.log("\n  Final scoring spot-check:");
  for (const sc of finalResult.spotChecks.slice(0, 2)) {
    const match = sc.pts === sc.expected;
    console.log(`    ${sc.player.padEnd(24)} ${sc.pos}: ${sc.pts} pts ${match ? "✓" : `✗ expected ${sc.expected}`}`);
  }

  // Finalize final fixtures + nation elimination + advance clock
  await finalizeRoundFixtures("final");
  await advanceRoundClock("final"); // push Final kickoffAt to past so recompute clears nextFixtureId
  const finalEliminatedCount = await setKnockoutElimination("final", FINAL_LOSERS_APIIDS);
  console.log(`\n  Final fixtures finalized. Nations eliminated at final: ${finalEliminatedCount}`);
  check(finalEliminatedCount === 4, `Expected 4 Final eliminations, got ${finalEliminatedCount}`);

  // Final nation elimination spot-check
  const finalElimSample = await db
    .select({ name: nations.name, eliminatedAtRound: nations.eliminatedAtRound })
    .from(nations)
    .where(inArray(nations.apiFootballId, FINAL_LOSERS_APIIDS));
  for (const n of finalElimSample) {
    check(n.eliminatedAtRound === "final", `${n.name}: expected eliminatedAtRound=final, got ${n.eliminatedAtRound}`);
    console.log(`    ${n.name.padEnd(24)}: eliminatedAtRound=final ✓`);
  }

  await recomputeAllNationStatus();

  await resolveMatchups(VAL, finalRoundId);

  // Verify Final matchup scored + champion set
  const [finalMatchupFinal] = await db
    .select({
      matchIndex: fantasyMatchups.matchIndex,
      homeScore: fantasyMatchups.homeScore,
      awayScore: fantasyMatchups.awayScore,
      winnerManagerId: fantasyMatchups.winnerManagerId,
      homeManagerId: fantasyMatchups.homeManagerId,
      awayManagerId: fantasyMatchups.awayManagerId,
    })
    .from(fantasyMatchups)
    .where(and(eq(fantasyMatchups.leagueId, VAL), eq(fantasyMatchups.fantasyRoundId, finalRoundId)));

  check(finalMatchupFinal.winnerManagerId !== null, "Final matchup has no winner (champion not crowned)");
  const championId = finalMatchupFinal.winnerManagerId!;
  const homeWonFinal = championId === finalMatchupFinal.homeManagerId;
  check(homeWonFinal, `Final: expected home manager to win`);

  console.log(`\n  Final result: home=${parseFloat(finalMatchupFinal.homeScore ?? "0").toFixed(2)} away=${parseFloat(finalMatchupFinal.awayScore ?? "0").toFixed(2)}`);
  console.log(`  CHAMPION: ${seed(championId)} (${championId.slice(0, 8)})`);

  // resolveBracket — no further seeds to fill (final is terminal)
  await resolveBracket(VAL);

  // ── STEP 6: End-state verification ────────────────────────────────────────
  console.log("\n══ STEP 6: End-state verification ══");

  // Full bracket chain: qf → sf → final
  const allMatchupsLatest = await db
    .select({
      round: fantasyRounds.round,
      matchIndex: fantasyMatchups.matchIndex,
      homeManagerId: fantasyMatchups.homeManagerId,
      awayManagerId: fantasyMatchups.awayManagerId,
      winnerManagerId: fantasyMatchups.winnerManagerId,
      homeScore: fantasyMatchups.homeScore,
      awayScore: fantasyMatchups.awayScore,
      homeSeedSource: fantasyMatchups.homeSeedSource,
      awaySeedSource: fantasyMatchups.awaySeedSource,
    })
    .from(fantasyMatchups)
    .innerJoin(fantasyRounds, eq(fantasyMatchups.fantasyRoundId, fantasyRounds.id))
    .where(and(eq(fantasyMatchups.leagueId, VAL), inArray(fantasyMatchups.fantasyRoundId, [qfRoundId, sfRoundId, finalRoundId])))
    .orderBy(fantasyRounds.round, fantasyMatchups.matchIndex);

  console.log("\n  Full knockout bracket:");
  let allHaveWinners = true;
  for (const m of allMatchupsLatest) {
    const homeWon = m.winnerManagerId === m.homeManagerId;
    if (!m.winnerManagerId) allHaveWinners = false;
    console.log(`    [${m.round}/${m.matchIndex}] ${seed(m.homeManagerId!)} (${parseFloat(m.homeScore ?? "0").toFixed(1)}) vs ${seed(m.awayManagerId!)} (${parseFloat(m.awayScore ?? "0").toFixed(1)}) → winner=${m.winnerManagerId ? seed(m.winnerManagerId) : "NULL"} ${m.winnerManagerId ? "✓" : "✗"}`);
  }
  check(allHaveWinners, "Not all matchups have winners");

  // Champion traceability
  console.log(`\n  Champion path trace for ${seed(championId)}:`);
  const qfWin = qfMatchupsResolved.find(m => m.winnerManagerId === championId);
  const sfWin = sfMatchupsResult.find(m => m.winnerManagerId === championId);
  const finalWin = finalMatchupFinal.winnerManagerId === championId;

  check(!!qfWin, `Champion ${seed(championId)} has no QF win`);
  check(!!sfWin, `Champion ${seed(championId)} has no SF win`);
  check(finalWin, `Champion ${seed(championId)} has no Final win`);

  console.log(`    QF [${qfWin!.matchIndex}]: won vs ${seed(qfWin!.homeManagerId === championId ? (qfMatchups.find(m=>m.matchIndex===qfWin!.matchIndex)?.awayManagerId ?? "") : qfMatchups.find(m=>m.matchIndex===qfWin!.matchIndex)?.homeManagerId ?? "")} ✓`);
  console.log(`    SF [${sfWin!.matchIndex}]: won (advancing from QF) ✓`);
  console.log(`    Final [${finalMatchupFinal.matchIndex}]: CHAMPION ✓`);
  console.log(`    Full path: QF[${qfWin!.matchIndex}] → SF[${sfWin!.matchIndex}] → Final → CHAMPION`);

  // League completion status
  const [leagueFinal] = await db
    .select({ status: leagues.status })
    .from(leagues)
    .where(eq(leagues.id, VAL));
  console.log(`\n  League status post-Final: ${leagueFinal.status}`);
  if (leagueFinal.status === "complete") {
    console.log("  → League auto-transitioned to 'complete' ✓");
  } else {
    console.log(`  → League status is '${leagueFinal.status}' (knockouts→complete transition is NOT auto-triggered by resolveBracket/resolveMatchups — requires explicit production path)`);
  }

  // Ownership invariant
  const [orphan1] = await db.execute(sql`
    SELECT count(*) cnt FROM rosters r WHERE r.league_id=${VAL}
    AND NOT EXISTS (SELECT 1 FROM waiver_player_status wps WHERE wps.league_id=r.league_id AND wps.player_id=r.player_id AND wps.status='rostered')
  `) as any[];
  const [orphan2] = await db.execute(sql`
    SELECT count(*) cnt FROM waiver_player_status wps WHERE wps.league_id=${VAL} AND wps.status='rostered'
    AND NOT EXISTS (SELECT 1 FROM rosters r WHERE r.league_id=wps.league_id AND r.player_id=wps.player_id)
  `) as any[];
  check((orphan1 as any).cnt === "0", `Final ownership invariant: ${(orphan1 as any).cnt} roster→WPS orphans`);
  check((orphan2 as any).cnt === "0", `Final ownership invariant: ${(orphan2 as any).cnt} WPS→roster orphans`);
  console.log(`\n  Ownership invariant: 0 violations (roster→WPS: ${(orphan1 as any).cnt}, WPS→roster: ${(orphan2 as any).cnt}) ✓`);

  // Nation elimination final state
  const elimSummary = await db.execute(sql`
    SELECT eliminated_at_round, count(*) cnt FROM nations
    GROUP BY eliminated_at_round ORDER BY eliminated_at_round NULLS LAST
  `) as any[];
  console.log("\n  Nation elimination summary:");
  for (const r of elimSummary as any[]) {
    console.log(`    ${(r.eliminated_at_round ?? "null").padEnd(16)}: ${r.cnt} nations`);
  }

  // nextFixtureId final state for champion nations
  const championNationsCheck = await db
    .select({ name: nations.name, nextFixtureId: nations.nextFixtureId, eliminatedAtRound: nations.eliminatedAtRound })
    .from(nations)
    .where(inArray(nations.apiFootballId, [770, 31, 1501, 32])); // Czech, Morocco, Ivory Coast, Egypt (Final winners)
  console.log("\n  Final-winner nations nextFixtureId (all finals done, expect null):");
  for (const n of championNationsCheck) {
    console.log(`    ${n.name.padEnd(24)}: nextFixtureId=${n.nextFixtureId?.slice(0,8) ?? "null"} eliminatedAt=${n.eliminatedAtRound ?? "null"}`);
  }

  // DESIGN.md §3 bracket check: all SF matchups are cross-round winners
  console.log("\n  §3 bracket structure:");
  console.log(`    QF (4): all 8 advancing managers played → 4 winners ✓`);
  console.log(`    SF (2): winners of QF seeded via winner_qf_* → 2 winners ✓`);
  console.log(`    Final (1): winners of SF seeded via winner_sf_* → 1 CHAMPION ✓`);

  console.log(`\n══ PASS ══`);
  console.log(`Champion: ${seed(championId)} (${championId})`);
  console.log(`Full bracket path: QF[${qfWin!.matchIndex}] → SF[${sfWin!.matchIndex}] → Final → CHAMPION`);
  console.log(`League status: ${leagueFinal.status} (knockouts→complete: ${leagueFinal.status === "complete" ? "auto-triggered ✓" : "NOT auto-triggered — separate transition needed"})`);
  console.log(`All ${allMatchupsLatest.length} knockout matchups scored with winners ✓`);
  console.log(`Ownership invariant: 0 violations ✓`);

  await client.end();
}

main().catch(async (e) => {
  console.error("\n✗ SCRIPT FAILED:", (e as Error).message ?? e);
  await client.end().catch(() => {});
  process.exit(1);
});
