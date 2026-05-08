/**
 * Creates a league with member profiles.
 * Edit the CONFIG block before running.
 *
 * Usage: tsx --env-file=.env.local scripts/seed-league.ts
 *
 * All emails must already exist in public.profiles (created via the auth trigger
 * after signing in with a magic link). The createdBy admin need not be listed
 * in managers unless they're playing as a regular manager.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db } from "../src/db";
import { profiles, leagues, leagueMemberships } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { leagueSizeFromFormat } from "../src/lib/draft/snake";

// ─── Edit this block before running ──────────────────────────────────────────

const CONFIG = {
  leagueName: "Footy Fantasy 2026",
  format: "twelve" as const, // 'eight' | 'twelve' | 'sixteen'
  createdByEmail: "<admin-email>", // must exist in profiles
  managers: [
    { email: "manager1@example.com", displayName: "Manager 1" },
    // Add remaining managers here. Count must match format (8, 12, or 16).
  ],
};

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const expectedCount = leagueSizeFromFormat(CONFIG.format);

  // 1. Validate manager count
  if (CONFIG.managers.length !== expectedCount) {
    console.error(
      `Error: format '${CONFIG.format}' requires exactly ${expectedCount} managers, but ${CONFIG.managers.length} listed.`
    );
    process.exit(1);
  }

  // 2. Look up createdBy profile
  const [adminProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.email, CONFIG.createdByEmail))
    .limit(1);

  if (!adminProfile) {
    console.error(
      `Error: admin email '${CONFIG.createdByEmail}' not found in profiles. Sign in first.`
    );
    process.exit(1);
  }

  // 3. Look up each manager profile
  const managerProfiles: Array<{
    email: string;
    displayName: string;
    profileId: string;
  }> = [];
  const missing: string[] = [];

  for (const m of CONFIG.managers) {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.email, m.email))
      .limit(1);

    if (!profile) {
      missing.push(m.email);
    } else {
      managerProfiles.push({
        email: m.email,
        displayName: m.displayName,
        profileId: profile.id,
      });
    }
  }

  if (missing.length > 0) {
    console.error(
      `Error: the following manager emails are missing from profiles:\n  ${missing.join("\n  ")}`
    );
    process.exit(1);
  }

  // 4. Refuse if league name already exists
  const [existingLeague] = await db
    .select()
    .from(leagues)
    .where(eq(leagues.name, CONFIG.leagueName))
    .limit(1);

  if (existingLeague) {
    console.error(
      `Error: a league named '${CONFIG.leagueName}' already exists (id: ${existingLeague.id}).`
    );
    process.exit(1);
  }

  // 5. Insert league + memberships in a transaction
  const result = await db.transaction(async (tx) => {
    const [league] = await tx
      .insert(leagues)
      .values({
        name: CONFIG.leagueName,
        format: CONFIG.format,
        status: "setup",
        createdBy: adminProfile.id,
      })
      .returning();

    const memberships = await tx
      .insert(leagueMemberships)
      .values(
        managerProfiles.map((m) => ({
          leagueId: league.id,
          userId: m.profileId,
          role: "manager" as const,
          displayName: m.displayName,
        }))
      )
      .returning();

    return { league, memberships };
  });

  // 6. Print summary
  console.log(`\nLeague created successfully.`);
  console.log(`  League ID : ${result.league.id}`);
  console.log(`  Name      : ${result.league.name}`);
  console.log(`  Format    : ${CONFIG.format} (${expectedCount} managers)`);
  console.log(`  Created by: ${CONFIG.createdByEmail}\n`);
  console.log(
    `${"Position".padEnd(10)}${"Display Name".padEnd(20)}${"Email".padEnd(30)}Membership ID`
  );
  console.log("─".repeat(90));
  result.memberships.forEach((m, i) => {
    const mgr = managerProfiles[i];
    console.log(
      `${String(i + 1).padEnd(10)}${m.displayName?.padEnd(20) ?? "".padEnd(20)}${mgr.email.padEnd(30)}${m.id}`
    );
  });
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
