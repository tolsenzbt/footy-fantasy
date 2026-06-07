import "server-only";
import { db } from "@/db";
import { drafts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

export type InitDraftOwnershipResult = {
  rosteredInserted: number;
  onWaiversInserted: number;
  totalRows: number;
};

/**
 * Populates waiver_player_status for an initial draft that has completed.
 *
 * Two passes, both idempotent (INSERT … WHERE NOT EXISTS):
 *   1. Rostered — every player in rosters for this league that has no status row yet
 *      gets status='rostered'.
 *   2. On-waivers — every active player NOT on any roster in this league that has no
 *      status row yet gets status='on_waivers', eligible_at = draft.completedAt + 24h
 *      (§8 "initial draft aftermath").
 *
 * Safe to call multiple times and on either a freshly-fixed draft (Fix A ensures each
 * pick already wrote the rostered row, making pass 1 a no-op) or a legacy broken draft
 * (backfill mode, inserts all 224+ rostered rows).
 */
export async function initDraftOwnership(
  leagueId: string,
): Promise<InitDraftOwnershipResult> {
  const [draft] = await db
    .select({ completedAt: drafts.completedAt })
    .from(drafts)
    .where(and(eq(drafts.leagueId, leagueId), eq(drafts.type, "initial")))
    .limit(1);

  if (!draft) throw new Error(`No initial draft found for league ${leagueId}`);
  if (!draft.completedAt) throw new Error(`Initial draft for league ${leagueId} is not yet complete`);

  const eligibleAt = new Date(draft.completedAt.getTime() + 24 * 60 * 60 * 1000);

  // Pass 1: backfill missing rostered rows
  const rosteredResult = await db.execute(sql`
    INSERT INTO waiver_player_status (id, league_id, player_id, status, eligible_at, drop_reason, dropped_by_manager_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.league_id, r.player_id, 'rostered', NULL, NULL, NULL, NOW(), NOW()
    FROM rosters r
    WHERE r.league_id = ${leagueId}
      AND NOT EXISTS (
        SELECT 1 FROM waiver_player_status wps
        WHERE wps.league_id = r.league_id
          AND wps.player_id = r.player_id
      )
  `);

  // Pass 2: backfill missing on_waivers rows for undrafted active players
  const onWaiversResult = await db.execute(sql`
    INSERT INTO waiver_player_status (id, league_id, player_id, status, eligible_at, drop_reason, dropped_by_manager_id, created_at, updated_at)
    SELECT gen_random_uuid(), ${leagueId}, p.id, 'on_waivers', ${eligibleAt.toISOString()}, NULL, NULL, NOW(), NOW()
    FROM players p
    WHERE p.active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM rosters r
        WHERE r.league_id = ${leagueId}
          AND r.player_id = p.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM waiver_player_status wps
        WHERE wps.league_id = ${leagueId}
          AND wps.player_id = p.id
      )
  `);

  // postgres.js reports affected rows on the `count` property of the result array
  const rosteredInserted = Number((rosteredResult as unknown as { count: number }).count ?? 0);
  const onWaiversInserted = Number((onWaiversResult as unknown as { count: number }).count ?? 0);

  // Total rows now in waiver_player_status for this league
  const [{ total }] = await db.execute(sql`
    SELECT COUNT(*) AS total FROM waiver_player_status WHERE league_id = ${leagueId}
  `) as unknown as [{ total: string }];

  return {
    rosteredInserted,
    onWaiversInserted,
    totalRows: Number(total),
  };
}
