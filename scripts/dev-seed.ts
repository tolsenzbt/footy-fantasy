/**
 * Creates a complete 16-team dev league with a fully-completed snake draft.
 * For local/dev testing only. Creates fake Supabase auth users + profiles,
 * a league, memberships, draft order, then auto-drafts all 224 picks.
 *
 * Usage: npm run db:dev-seed
 *
 * Idempotent on user creation (skips existing emails). Outputs league ID at end.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import {
  profiles, leagues, leagueMemberships, drafts, draftOrder,
  players, nations, rosters,
} from "../src/db/schema";
import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { submitPick } from "../src/lib/draft/picks";
import { leagueSizeFromFormat, resolveDraftPosition } from "../src/lib/draft/snake";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const MANAGERS = [
  "Alice Johnson", "Bob Smith", "Carlos Ruiz", "Diana Prince",
  "Eduardo Santos", "Fatima Hassan", "George Wilson", "Hannah Lee",
  "Ivan Petrov", "Julia Martinez", "Kevin O'Brien", "Lily Zhang",
  "Michael Brown", "Nadia Okonkwo", "Oscar Fernandez", "Priya Sharma",
];

type Position = "GK" | "DEF" | "MID" | "FWD";
const POSITION_MAX: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const POSITION_MIN: Record<Position, number> = { GK: 1, DEF: 3, MID: 3, FWD: 1 };

async function getRosterCounts(leagueId: string, managerId: string) {
  const rows = await db.select({ position: players.position })
    .from(rosters)
    .innerJoin(players, eq(rosters.playerId, players.id))
    .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, managerId)));
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const r of rows) counts[r.position as Position]++;
  return counts;
}

function legalPositions(counts: Record<Position, number>): Position[] {
  const total = (["GK","DEF","MID","FWD"] as Position[]).reduce((s, p) => s + counts[p], 0);
  const remaining = 14 - total;
  const forced = (["GK","DEF","MID","FWD"] as Position[]).filter(p => counts[p] < POSITION_MIN[p]);
  const totalForced = forced.reduce((s, p) => s + (POSITION_MIN[p] - counts[p]), 0);
  if (totalForced === remaining) return forced;
  return (["GK","DEF","MID","FWD"] as Position[]).filter(p => counts[p] < POSITION_MAX[p]);
}

async function main() {
  const now = new Date();

  // ── 1. Create/find 16 fake auth users ──────────────────────────────────────
  console.log("Creating managers...");
  const profileIds: string[] = [];

  for (const name of MANAGERS) {
    const email = `dev-${name.toLowerCase().replace(/[^a-z]/g, "-")}@dev.test`;
    const [existing] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.email, email))
      .limit(1);

    if (existing) {
      console.log(`  skip (exists): ${email}`);
      profileIds.push(existing.id);
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password: "devpassword123!",
        email_confirm: true,
        user_metadata: { display_name: name },
      });
      if (error) throw new Error(`Failed to create ${email}: ${error.message}`);

      // Trigger fires synchronously; verify profile exists
      let profile: { id: string } | undefined;
      for (let i = 0; i < 5; i++) {
        const [row] = await db.select({ id: profiles.id })
          .from(profiles)
          .where(eq(profiles.email, email))
          .limit(1);
        if (row) { profile = row; break; }
        await new Promise(r => setTimeout(r, 200));
      }
      if (!profile) throw new Error(`Profile not created for ${email}`);
      profileIds.push(profile.id);
      console.log(`  created: ${email} → ${profile.id.slice(0, 8)}`);
    }
  }

  const adminProfileId = profileIds[0];

  // ── 2. Create league ────────────────────────────────────────────────────────
  const [league] = await db.insert(leagues).values({
    name: "Dev League 2026",
    format: "sixteen",
    status: "drafting",
    createdBy: adminProfileId,
    lockedAt: now,
  }).returning();
  console.log(`\nLeague created: ${league.id}`);

  // ── 3. Create memberships ───────────────────────────────────────────────────
  for (let i = 0; i < 16; i++) {
    await db.insert(leagueMemberships).values({
      leagueId: league.id,
      userId: profileIds[i],
      role: "manager",
      displayName: MANAGERS[i],
    });
  }

  const memberRows = await db
    .select({ id: leagueMemberships.id, userId: leagueMemberships.userId })
    .from(leagueMemberships)
    .where(eq(leagueMemberships.leagueId, league.id));

  if (memberRows.length !== 16) {
    throw new Error(`Expected 16 memberships after insert, got ${memberRows.length}. Aborting.`);
  }

  const memberIdByProfileId = new Map(memberRows.map(m => [m.userId, m.id]));
  const membershipIds = profileIds.map(pid => memberIdByProfileId.get(pid)!);

  // ── 4. Create draft with shuffled order ─────────────────────────────────────
  const shuffled = [...membershipIds].sort(() => Math.random() - 0.5);

  const [draft] = await db.insert(drafts).values({
    leagueId: league.id,
    type: "initial",
    status: "active",
    pickClockSeconds: 28800,
    startsAt: now,
    startedAt: now,
    currentPickNumber: 1,
    currentPickStartedAt: now,
  }).returning();

  for (let i = 0; i < 16; i++) {
    await db.insert(draftOrder).values({
      draftId: draft.id,
      position: i + 1,
      managerId: shuffled[i],
    });
  }
  console.log("Draft created, auto-drafting 224 picks...");

  // ── 5. Auto-draft all 224 picks ─────────────────────────────────────────────
  const leagueSize = 16;
  const totalRounds = 14;
  const totalPicks = totalRounds * leagueSize;

  for (let pickNum = 1; pickNum <= totalPicks; pickNum++) {
    // Resolve which manager is on the clock for this pick via draft order
    const draftPos = resolveDraftPosition(pickNum, leagueSize, totalRounds);
    const orderRow = await db.select({ managerId: draftOrder.managerId })
      .from(draftOrder)
      .where(and(eq(draftOrder.draftId, draft.id), eq(draftOrder.position, draftPos)))
      .limit(1);
    if (!orderRow[0]) {
      console.log(`  pick ${pickNum}: could not resolve manager at position ${draftPos}`);
      continue;
    }
    const managerId = orderRow[0].managerId;

    const counts = await getRosterCounts(league.id, managerId);
    const legalPos = legalPositions(counts);

    // Find first available player at a legal position (not yet rostered in league)
    const rosteredIds = (await db.select({ pid: rosters.playerId })
      .from(rosters)
      .where(eq(rosters.leagueId, league.id)))
      .map(r => r.pid);

    const [player] = await db
      .select({ id: players.id })
      .from(players)
      .where(and(
        inArray(players.position, legalPos as string[]),
        rosteredIds.length > 0
          ? notInArray(players.id, rosteredIds)
          : sql`true`,
      ))
      .limit(1);

    if (!player) throw new Error(`No available player at positions ${legalPos} for pick ${pickNum}`);

    await submitPick({ leagueId: league.id, draftType: "initial", managerId, playerId: player.id });
    if (pickNum % 32 === 0) console.log(`  ...pick ${pickNum}/${totalPicks}`);
  }

  console.log(`\n✓ Draft complete. 224 picks made.`);
  console.log(`\nLeague ID: ${league.id}`);
  console.log(`View draft board: http://localhost:3333/leagues/${league.id}/draft`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
