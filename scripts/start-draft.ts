/**
 * Locks a league and creates the initial draft with a randomly shuffled order.
 *
 * Usage:
 *   tsx --env-file=.env.local scripts/start-draft.ts <leagueId> [startsAtISO]
 *
 * leagueId    — UUID of the league (required)
 * startsAtISO — ISO timestamp when the draft becomes active, e.g.
 *               2026-06-07T18:00:00-04:00 (optional; leave null to set via DB later)
 *
 * The script is idempotent-safe: it refuses if a draft already exists.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomInt } from "crypto";
import { db } from "../src/db";
import { leagues, leagueMemberships, drafts, draftOrder } from "../src/db/schema";
import { eq, and } from "drizzle-orm";
import { leagueSizeFromFormat } from "../src/lib/draft/snake";

const PICK_CLOCK_SECONDS = 8 * 60 * 60; // 8 hours

async function main() {
  const [, , leagueId, startsAtArg] = process.argv;

  if (!leagueId) {
    console.error("Usage: tsx scripts/start-draft.ts <leagueId> [startsAtISO]");
    process.exit(1);
  }

  // Parse optional startsAt
  let startsAt: Date | null = null;
  if (startsAtArg) {
    startsAt = new Date(startsAtArg);
    if (isNaN(startsAt.getTime())) {
      console.error(`Error: invalid ISO timestamp '${startsAtArg}'.`);
      process.exit(1);
    }
  }

  // 1. Fetch the league
  const [league] = await db
    .select()
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  if (!league) {
    console.error(`Error: league '${leagueId}' not found.`);
    process.exit(1);
  }

  if (league.status !== "setup") {
    console.error(
      `Error: league status is '${league.status}', expected 'setup'. Cannot start draft.`
    );
    process.exit(1);
  }

  // 2. Verify manager count matches format
  const expectedCount = leagueSizeFromFormat(league.format);
  const members = await db
    .select()
    .from(leagueMemberships)
    .where(
      and(
        eq(leagueMemberships.leagueId, leagueId),
        eq(leagueMemberships.role, "manager")
      )
    );

  if (members.length !== expectedCount) {
    console.error(
      `Error: league format '${league.format}' requires ${expectedCount} managers but found ${members.length}.`
    );
    process.exit(1);
  }

  // 3. Refuse if draft already exists
  const [existingDraft] = await db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.leagueId, leagueId), eq(drafts.type, "initial"))
    )
    .limit(1);

  if (existingDraft) {
    console.error(
      `Error: an initial draft already exists for this league (id: ${existingDraft.id}).`
    );
    process.exit(1);
  }

  // 4. Fisher-Yates shuffle using crypto.randomInt
  const shuffled = [...members];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 5. Transactional insert
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx
      .update(leagues)
      .set({ status: "drafting", lockedAt: now, updatedAt: now })
      .where(eq(leagues.id, leagueId));

    const [draft] = await tx
      .insert(drafts)
      .values({
        leagueId,
        type: "initial",
        status: "pending",
        pickClockSeconds: PICK_CLOCK_SECONDS,
        startsAt,
        currentPickNumber: null,
        currentPickStartedAt: null,
      })
      .returning();

    const orderRows = await tx
      .insert(draftOrder)
      .values(
        shuffled.map((m, idx) => ({
          draftId: draft.id,
          position: idx + 1, // 1-indexed; position 1 picks first overall
          managerId: m.id,
        }))
      )
      .returning();

    return { draft, orderRows };
  });

  // 6. Print summary
  console.log(`\nDraft created successfully.`);
  console.log(`  Draft ID  : ${result.draft.id}`);
  console.log(`  League    : ${league.name} (${league.format})`);
  console.log(`  Starts at : ${startsAt ? startsAt.toISOString() : "(not set — update via DB)"}`);
  console.log(`  Pick clock: ${PICK_CLOCK_SECONDS / 3600}h per pick\n`);
  console.log(
    `${"Position".padEnd(10)}${"Display Name".padEnd(25)}Membership ID`
  );
  console.log("─".repeat(70));
  result.orderRows.forEach((row) => {
    const member = members.find((m) => m.id === row.managerId)!;
    console.log(
      `${String(row.position).padEnd(10)}${(member.displayName ?? member.userId).padEnd(25)}${row.managerId}`
    );
  });
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
