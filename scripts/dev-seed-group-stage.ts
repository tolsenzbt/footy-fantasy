/**
 * dev-seed-group-stage.ts
 *
 * Advances the dev-seed league through a fully-simulated group stage (MD1–MD3)
 * using real 2022 WC stats via the same positional-remap harness as val-md*-ingest.
 *
 * Steps:
 *   1. Run group draw → schedule_slots + fantasy_rounds + fantasy_matchups
 *   2. Flip leagues.status → group_stage
 *   3. Set MD1 lineups for all managers (4-4-2 or best-fit formation)
 *   4–6. Ingest MD1, MD2, MD3: pre-backdate → clear → API sweep → resolveMatchups → computeStandings
 *
 * All 16 managers roll over their MD1 lineup into MD2 and MD3 (no explicit changes).
 *
 * Usage:
 *   npm run db:dev-seed-group-stage [-- <leagueId>]
 *   If leagueId omitted, finds the league named "Dev League 2026".
 *
 * Time: ~10 min (72 API calls × 3s rate-limit gaps across 3 MDs)
 * Requires: API_FOOTBALL_KEY in .env.local
 *
 * Idempotent: each MD has a clear step that wipes prior scores before re-ingesting.
 * To start completely fresh: run db:cleanup-league <leagueId> && db:dev-seed, then re-run this.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import {
  leagues, leagueMemberships, rosters, players, fantasyRounds, fantasyMatchups,
  scheduleSlots, playerMatchStats, playerMatchScores, rawApiResponses,
  waiverProcessingEvents, realFixtures, groupStandings,
} from "../src/db/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { runGroupDraw } from "../src/lib/schedule/group-draw";
import { setLineup } from "../src/lib/lineup/actions";
import { fetchFixturePlayers } from "../src/lib/api-football";
import type { ApiTeamPlayersEntry } from "../src/lib/stats/conceded";
import {
  runIngestSweep, ROUND_SETTLE_HOURS,
  type SweepDeps, type FixtureRow, type UpsertScoreArgs,
} from "../src/lib/stats/ingest";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RemapEntry {
  fix2026Id: string;
  fix2026Label: string;
  src2022Id: number;
  home2026NationApiId: number;
  away2026NationApiId: number;
  home2022TeamId?: number;
  away2022TeamId?: number;
}

interface Player2026 {
  id: string;
  apiFootballId: number;
  position: string;
  name: string;
}

type RemapMap = Map<number, { id: string; apiFootballId: number; position: string }>;

// ─── REMAP Tables (fixture UUIDs are global — same across all leagues) ────────

const MD1_REMAP: RemapEntry[] = [
  { fix2026Id: "289bd88d-a6d6-4347-bd72-b174363945c3", fix2026Label: "Mexico vs South Africa",            src2022Id: 855739, home2026NationApiId: 16,   away2026NationApiId: 1531 },
  { fix2026Id: "2742735d-c522-4155-954d-a66b8b5e7a6d", fix2026Label: "South Korea vs Czech Republic",    src2022Id: 855744, home2026NationApiId: 17,   away2026NationApiId: 770  },
  { fix2026Id: "68487373-9d2c-4c02-a472-870fc4d4092a", fix2026Label: "Canada vs Bosnia & Herzegovina",   src2022Id: 855749, home2026NationApiId: 5529, away2026NationApiId: 1113 },
  { fix2026Id: "2e8c0a18-47db-42de-8915-e95bcb3992e3", fix2026Label: "USA vs Paraguay",                  src2022Id: 866681, home2026NationApiId: 2384, away2026NationApiId: 2380 },
  { fix2026Id: "37fdac84-1346-479e-a507-ab360a99ac1a", fix2026Label: "Qatar vs Switzerland",             src2022Id: 855736, home2026NationApiId: 1569, away2026NationApiId: 15   },
  { fix2026Id: "4da7bfb1-0c4c-4781-bfdf-2badf346995b", fix2026Label: "Brazil vs Morocco",                src2022Id: 855767, home2026NationApiId: 6,    away2026NationApiId: 31   },
  { fix2026Id: "2f49416d-468f-454e-8424-cecc22d2e8e6", fix2026Label: "Haiti vs Scotland",                src2022Id: 855738, home2026NationApiId: 2386, away2026NationApiId: 1108 },
  { fix2026Id: "68d7548f-c3c2-4a06-b80a-120996c00aeb", fix2026Label: "Australia vs Türkiye",             src2022Id: 871850, home2026NationApiId: 20,   away2026NationApiId: 777  },
  { fix2026Id: "4a220b26-a65d-4900-a8ad-d390227cb90c", fix2026Label: "Germany vs Curaçao",               src2022Id: 855741, home2026NationApiId: 25,   away2026NationApiId: 5530 },
  { fix2026Id: "87268f0d-745b-447f-8caa-b32cf034735b", fix2026Label: "Netherlands vs Japan",             src2022Id: 855734, home2026NationApiId: 1118, away2026NationApiId: 12   },
  { fix2026Id: "232d766b-f39c-4c7b-aaf4-e18c1c17dee4", fix2026Label: "Ivory Coast vs Ecuador",          src2022Id: 871851, home2026NationApiId: 1501, away2026NationApiId: 2382 },
  { fix2026Id: "16b5e570-57de-47a8-bbeb-d46bf5bb4299", fix2026Label: "Sweden vs Tunisia",                src2022Id: 855743, home2026NationApiId: 5,    away2026NationApiId: 28   },
  { fix2026Id: "f3a5ea00-969c-49bc-b9a0-72d1461a1c34", fix2026Label: "Spain vs Cape Verde Islands",      src2022Id: 855745, home2026NationApiId: 9,    away2026NationApiId: 1533 },
  { fix2026Id: "8120245d-fcb6-4fd3-99de-e2491b2c6894", fix2026Label: "Belgium vs Egypt",                 src2022Id: 855746, home2026NationApiId: 1,    away2026NationApiId: 32   },
  { fix2026Id: "dad15942-a72d-4525-8fcc-f4cc75d5484d", fix2026Label: "Saudi Arabia vs Uruguay",          src2022Id: 855737, home2026NationApiId: 23,   away2026NationApiId: 7    },
  { fix2026Id: "a102ed2a-ef23-4ed6-ad27-e6e34fcdb607", fix2026Label: "Iran vs New Zealand",              src2022Id: 855735, home2026NationApiId: 22,   away2026NationApiId: 4673 },
  { fix2026Id: "0a86db60-89b5-451e-a022-09c66b7a9a91", fix2026Label: "France vs Senegal",                src2022Id: 855747, home2026NationApiId: 2,    away2026NationApiId: 13   },
  { fix2026Id: "c389fc46-3d7b-44b6-b515-84a775c94cc2", fix2026Label: "Iraq vs Norway",                   src2022Id: 855748, home2026NationApiId: 1567, away2026NationApiId: 1090 },
  { fix2026Id: "7af74cb3-c9eb-472c-a97b-01d2045e863a", fix2026Label: "Argentina vs Algeria",             src2022Id: 855752, home2026NationApiId: 26,   away2026NationApiId: 1532 },
  { fix2026Id: "dd99df75-1ecf-4f59-bd21-d9aebddf5340", fix2026Label: "Austria vs Jordan",                src2022Id: 871852, home2026NationApiId: 775,  away2026NationApiId: 1548 },
  { fix2026Id: "b49d7207-a912-4e5a-b234-0a104e8dda03", fix2026Label: "Portugal vs Congo DR",             src2022Id: 855751, home2026NationApiId: 27,   away2026NationApiId: 1508 },
  { fix2026Id: "54d19d94-5ebe-4eb6-b2ea-4fc71cec8bfc", fix2026Label: "England vs Croatia",               src2022Id: 855754, home2026NationApiId: 10,   away2026NationApiId: 3    },
  { fix2026Id: "3d088b40-8425-4e69-a527-45c9f4c33668", fix2026Label: "Ghana vs Panama",                  src2022Id: 855755, home2026NationApiId: 1504, away2026NationApiId: 11   },
  { fix2026Id: "003bf5e4-a318-41f7-82f2-f99d547de5d6", fix2026Label: "Uzbekistan vs Colombia",           src2022Id: 855742, home2026NationApiId: 1568, away2026NationApiId: 8    },
];

const MD2_REMAP: RemapEntry[] = [
  { fix2026Id: "294d6a4a-0d88-4d87-9be6-cfb4df468f1e", fix2026Label: "Canada vs Qatar",                   src2022Id: 855760, home2026NationApiId: 5529, away2026NationApiId: 1569 },
  { fix2026Id: "c524d7f3-96db-4d65-8b3b-85890ecdbfce", fix2026Label: "Mexico vs South Korea",             src2022Id: 855757, home2026NationApiId: 16,   away2026NationApiId: 17   },
  { fix2026Id: "eafc90ee-52aa-41da-b919-94b86d3ac6e0", fix2026Label: "Brazil vs Haiti",                   src2022Id: 855758, home2026NationApiId: 6,    away2026NationApiId: 2386 },
  { fix2026Id: "cf94e23c-fd1a-450f-a923-0eb52b82238a", fix2026Label: "Scotland vs Morocco",               src2022Id: 855753, home2026NationApiId: 1108, away2026NationApiId: 31   },
  { fix2026Id: "d64cbfbd-ddcb-44a7-9501-fe623d536896", fix2026Label: "USA vs Australia",                  src2022Id: 855762, home2026NationApiId: 2384, away2026NationApiId: 20   },
  { fix2026Id: "729b1fef-2e26-4d93-a051-31b0f6bcadd1", fix2026Label: "Ecuador vs Curaçao",                src2022Id: 855761, home2026NationApiId: 2382, away2026NationApiId: 5530 },
  { fix2026Id: "745974e1-aedc-4075-90be-965121112af0", fix2026Label: "Germany vs Ivory Coast",            src2022Id: 871855, home2026NationApiId: 25,   away2026NationApiId: 1501 },
  { fix2026Id: "2cf89342-14a7-41b1-bfca-7cc2ab5e8332", fix2026Label: "Tunisia vs Japan",                  src2022Id: 855756, home2026NationApiId: 28,   away2026NationApiId: 12   },
  { fix2026Id: "92d039a4-f2f2-4579-97cb-4665ddec7f1d", fix2026Label: "Belgium vs Iran",                   src2022Id: 855766, home2026NationApiId: 1,    away2026NationApiId: 22   },
  { fix2026Id: "2d97391c-4798-4a07-a3bd-838d53e2e4e7", fix2026Label: "New Zealand vs Egypt",              src2022Id: 855750, home2026NationApiId: 4673, away2026NationApiId: 32   },
  { fix2026Id: "5e8c88a0-5b4d-49f9-bdbd-aea0f101d4b6", fix2026Label: "Spain vs Saudi Arabia",             src2022Id: 855768, home2026NationApiId: 9,    away2026NationApiId: 23   },
  { fix2026Id: "6329d56d-0bdf-40e8-b8aa-d6a3ac8acc5c", fix2026Label: "Uruguay vs Cape Verde Islands",     src2022Id: 855759, home2026NationApiId: 7,    away2026NationApiId: 1533 },
  { fix2026Id: "21cfb5a1-5f5c-4cd6-ae09-40909d574b4b", fix2026Label: "Argentina vs Austria",              src2022Id: 855764, home2026NationApiId: 26,   away2026NationApiId: 775  },
  { fix2026Id: "2786db1b-4bea-4764-819c-62f444bbdf9f", fix2026Label: "Jordan vs Algeria",                 src2022Id: 866682, home2026NationApiId: 1548, away2026NationApiId: 1532 },
  { fix2026Id: "c5795677-148f-4426-8234-b70188959e62", fix2026Label: "Norway vs Senegal",                  src2022Id: 855770, home2026NationApiId: 1090, away2026NationApiId: 13   },
  { fix2026Id: "4996eae9-4f1b-404a-abe3-1c02f17a7c23", fix2026Label: "England vs Ghana",                  src2022Id: 866683, home2026NationApiId: 10,   away2026NationApiId: 1504 },
  { fix2026Id: "c375022d-f2df-4cc7-840c-2a95947eb200", fix2026Label: "Panama vs Croatia",                 src2022Id: 855740, home2026NationApiId: 11,   away2026NationApiId: 3    },
  { fix2026Id: "b93b014d-07c9-4235-83c7-3a3dc58a7d8f", fix2026Label: "Portugal vs Uzbekistan",            src2022Id: 855771, home2026NationApiId: 27,   away2026NationApiId: 1568 },
  { fix2026Id: "1e65c1b0-9170-4402-83fb-70b2abafe2df", fix2026Label: "Czech Republic vs South Africa",    src2022Id: 855763, home2026NationApiId: 770,  away2026NationApiId: 1531 },
  { fix2026Id: "a70864cc-68fe-4bfd-89f7-60fec4ff6d35", fix2026Label: "Switzerland vs Bosnia & Herzegovina", src2022Id: 855772, home2026NationApiId: 15, away2026NationApiId: 1113 },
  { fix2026Id: "95e24ba5-ee5c-4636-9565-ff2f8fcd1983", fix2026Label: "Türkiye vs Paraguay",               src2022Id: 871853, home2026NationApiId: 777,  away2026NationApiId: 2380 },
  { fix2026Id: "d498476e-7690-4a73-9104-d2e1e68baa6d", fix2026Label: "Netherlands vs Sweden",             src2022Id: 855769, home2026NationApiId: 1118, away2026NationApiId: 5    },
  { fix2026Id: "fe848ec8-ab6e-4397-9ce8-e36694264c73", fix2026Label: "Colombia vs Congo DR",              src2022Id: 855765, home2026NationApiId: 8,    away2026NationApiId: 1508 },
  { fix2026Id: "11815d62-3fb2-4551-a655-9a7fbd416a3b", fix2026Label: "France vs Iraq",                   src2022Id: 871854, home2026NationApiId: 2,    away2026NationApiId: 1567 },
];

const MD3_REMAP: RemapEntry[] = [
  { fix2026Id: "cd1e19f4-1a86-4ba2-8310-d34cc5bb67c9", fix2026Label: "Czech Republic vs Mexico",        src2022Id: 855739, home2026NationApiId: 770,  away2026NationApiId: 16   },
  { fix2026Id: "70583f46-6d13-4dc0-827a-69a24b917fcf", fix2026Label: "South Africa vs South Korea",     src2022Id: 855744, home2026NationApiId: 1531, away2026NationApiId: 17   },
  { fix2026Id: "955230d9-aaa9-4276-b655-fc66ac09c44e", fix2026Label: "Bosnia & Herzegovina vs Qatar",   src2022Id: 855749, home2026NationApiId: 1113, away2026NationApiId: 1569 },
  { fix2026Id: "9411676f-810e-48e3-af00-200bfd35ddc3", fix2026Label: "Switzerland vs Canada",           src2022Id: 866681, home2026NationApiId: 15,   away2026NationApiId: 5529 },
  { fix2026Id: "d0eeb7d0-2ec6-4b7a-92cb-d4e8d3e8b79b", fix2026Label: "Morocco vs Haiti",               src2022Id: 855736, home2026NationApiId: 31,   away2026NationApiId: 2386 },
  { fix2026Id: "e0528a87-91ee-480c-8567-b241ee3227b6", fix2026Label: "Scotland vs Brazil",              src2022Id: 855767, home2026NationApiId: 1108, away2026NationApiId: 6    },
  { fix2026Id: "28a874a4-0b63-4eb3-9ef9-152376a73212", fix2026Label: "Türkiye vs USA",                  src2022Id: 855738, home2026NationApiId: 777,  away2026NationApiId: 2384 },
  { fix2026Id: "ef99d44e-bef3-4648-bd3f-0391e63930db", fix2026Label: "Paraguay vs Australia",           src2022Id: 871850, home2026NationApiId: 2380, away2026NationApiId: 20   },
  { fix2026Id: "3997efda-7d8a-4626-adc5-a6ccec6810a2", fix2026Label: "Ecuador vs Germany",              src2022Id: 855741, home2026NationApiId: 2382, away2026NationApiId: 25   },
  { fix2026Id: "cc9b3a5a-4d80-4d26-a071-a7acda00002d", fix2026Label: "Curaçao vs Ivory Coast",          src2022Id: 855734, home2026NationApiId: 5530, away2026NationApiId: 1501 },
  { fix2026Id: "789bd47d-8280-4bd3-a20f-47708e25e3ac", fix2026Label: "Japan vs Sweden",                 src2022Id: 871851, home2026NationApiId: 12,   away2026NationApiId: 5    },
  { fix2026Id: "58c95103-e955-4643-ab8c-cd23d4d6e4d7", fix2026Label: "Tunisia vs Netherlands",          src2022Id: 855743, home2026NationApiId: 28,   away2026NationApiId: 1118 },
  { fix2026Id: "9db748e4-8f5d-4f04-82d8-76e5b4c8a855", fix2026Label: "Egypt vs Iran",                  src2022Id: 855745, home2026NationApiId: 32,   away2026NationApiId: 22   },
  { fix2026Id: "5b4fbd40-6ece-4b26-9298-fc56ed1554fa", fix2026Label: "New Zealand vs Belgium",          src2022Id: 855746, home2026NationApiId: 4673, away2026NationApiId: 1    },
  { fix2026Id: "d8daed82-aef6-4fbd-8ed1-ae54eae0038d", fix2026Label: "Uruguay vs Spain",               src2022Id: 855737, home2026NationApiId: 7,    away2026NationApiId: 9    },
  { fix2026Id: "277dc3e2-e4b2-4ed4-a567-47251ae11256", fix2026Label: "Cape Verde Islands vs Saudi Arabia", src2022Id: 855735, home2026NationApiId: 1533, away2026NationApiId: 23 },
  { fix2026Id: "1ab4291a-3d19-414c-a11b-6aebfb409c1f", fix2026Label: "Senegal vs Iraq",                src2022Id: 855747, home2026NationApiId: 13,   away2026NationApiId: 1567 },
  { fix2026Id: "68dd6eb7-99ea-423f-9bec-e96a673f3048", fix2026Label: "Norway vs France",               src2022Id: 855748, home2026NationApiId: 1090, away2026NationApiId: 2    },
  { fix2026Id: "03e566b1-c607-44e6-a5a1-abef7c6b6a82", fix2026Label: "Jordan vs Argentina",            src2022Id: 855752, home2026NationApiId: 1548, away2026NationApiId: 26   },
  { fix2026Id: "54d6b72a-7bba-4386-9301-da6ee5042e48", fix2026Label: "Algeria vs Austria",             src2022Id: 871852, home2026NationApiId: 1532, away2026NationApiId: 775  },
  { fix2026Id: "3873de11-2140-4039-8d31-0f69b48d8224", fix2026Label: "Colombia vs Portugal",           src2022Id: 855751, home2026NationApiId: 8,    away2026NationApiId: 27   },
  { fix2026Id: "0326c118-df90-4c31-8905-8ab0f2c6fc9b", fix2026Label: "Congo DR vs Uzbekistan",         src2022Id: 855754, home2026NationApiId: 1508, away2026NationApiId: 1568 },
  { fix2026Id: "5f9601c9-9cc6-4fe3-962f-e39fba1f8f3e", fix2026Label: "Croatia vs Ghana",               src2022Id: 855755, home2026NationApiId: 3,    away2026NationApiId: 1504 },
  { fix2026Id: "aee2a959-aa64-478f-911e-a793343baabe", fix2026Label: "Panama vs England",              src2022Id: 855742, home2026NationApiId: 11,   away2026NationApiId: 10   },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const POS_MAP: Record<string, string> = { G: "GK", D: "DEF", M: "MID", F: "FWD" };
const SETTLE_MS = ROUND_SETTLE_HOURS * 3600 * 1000;
const DEV_LEAGUE_NAME = "Dev League 2026";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getRosteredPlayers(leagueId: string, nationApiId: number): Promise<Player2026[]> {
  const rows = await db.execute(sql`
    SELECT p.id, p.api_football_id, p.position, p.name
    FROM rosters r JOIN players p ON p.id = r.player_id JOIN nations n ON n.id = p.nation_id
    WHERE r.league_id = ${leagueId} AND n.api_football_id = ${nationApiId}
    ORDER BY p.position, p.name
  `);
  return Array.from(rows).map(r => {
    const row = r as Record<string, unknown>;
    return { id: row.id as string, apiFootballId: row.api_football_id as number, position: row.position as string, name: row.name as string };
  });
}

function buildPositionalRemap(
  src2022Players: ApiTeamPlayersEntry["players"],
  dest2026Players: Player2026[],
  label: string,
): RemapMap {
  const by2022 = new Map<string, Array<{ id: number; isStarter: boolean }>>();
  for (const p of src2022Players) {
    const pos = POS_MAP[p.statistics[0].games.position];
    if (!pos) continue;
    if (!by2022.has(pos)) by2022.set(pos, []);
    by2022.get(pos)!.push({ id: p.player.id, isStarter: !p.statistics[0].games.substitute });
  }
  for (const arr of by2022.values()) {
    arr.sort((a, b) => a.isStarter === b.isStarter ? a.id - b.id : a.isStarter ? -1 : 1);
  }

  const by2026 = new Map<string, Player2026[]>();
  for (const p of dest2026Players) {
    if (!by2026.has(p.position)) by2026.set(p.position, []);
    by2026.get(p.position)!.push(p);
  }

  const result: RemapMap = new Map();
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    const src = by2022.get(pos) ?? [];
    const dest = by2026.get(pos) ?? [];
    const n = Math.min(src.length, dest.length);
    for (let i = 0; i < n; i++) {
      result.set(src[i].id, { id: dest[i].id, apiFootballId: src[i].id, position: pos });
    }
    const dropped = src.length - n;
    const padded = dest.length - n;
    const status = (dropped > 0 || padded > 0) ? ` [DROP ${dropped}, PAD ${padded}]` : " [exact]";
    process.stdout.write(`      ${label} ${pos}: src=${src.length} dest=${dest.length} used=${n}${status}\n`);
  }
  return result;
}

function buildRealDepsBase(): Omit<SweepDeps, "getInWindowFixtures" | "getSettledUnresolvedRounds" | "getPlayersByApiIds" | "upsertRealFixtures"> {
  return {
    getLastResponseHash: async (fixtureId, newHash) => {
      const rows = await db.select({ responseHash: rawApiResponses.responseHash }).from(rawApiResponses)
        .where(and(eq(rawApiResponses.fixtureId, fixtureId), eq(rawApiResponses.responseHash, newHash))).limit(1);
      return rows.length > 0;
    },
    storeRawPayload: async (fixtureId, payload, hash, fetchedAt) => {
      await db.insert(rawApiResponses).values({ fixtureId, payload: payload as Record<string, unknown>, responseHash: hash, fetchedAt }).onConflictDoNothing();
    },
    setFinalizedAt: async (fixtureId, at) => {
      await db.update(realFixtures).set({ finalizedAt: at, updatedAt: at })
        .where(and(eq(realFixtures.id, fixtureId), isNull(realFixtures.finalizedAt)));
    },
    upsertPlayerMatchStats: async (args) => {
      type StatsInsert = typeof playerMatchStats.$inferInsert;
      const raw = args as StatsInsert;
      const a: StatsInsert = { ...raw, saves: raw.saves ?? 0, penaltySaves: raw.penaltySaves ?? 0, penaltiesMissed: raw.penaltiesMissed ?? 0, goals: raw.goals ?? 0, assists: raw.assists ?? 0, goalsConceded: raw.goalsConceded ?? 0, yellowCards: raw.yellowCards ?? 0, ownGoals: raw.ownGoals ?? 0 };
      const { fixtureId: _f, playerId: _p, ...rest } = a;
      await db.insert(playerMatchStats).values(a).onConflictDoUpdate({ target: [playerMatchStats.fixtureId, playerMatchStats.playerId], set: rest });
    },
    upsertPlayerMatchScore: async ({ fixtureId, playerId, points, updatedAt }: UpsertScoreArgs) => {
      await db.insert(playerMatchScores).values({ fixtureId, playerId, points: String(points), updatedAt })
        .onConflictDoUpdate({ target: [playerMatchScores.fixtureId, playerMatchScores.playerId], set: { points: sql`CASE WHEN ${playerMatchScores.overridePoints} IS NULL THEN ${String(points)} ELSE ${playerMatchScores.points} END`, updatedAt } });
    },
    setStatsIngestedAt: async (fantasyRoundId, at) => {
      await db.update(fantasyRounds).set({ statsIngestedAt: at, updatedAt: at }).where(eq(fantasyRounds.id, fantasyRoundId));
    },
    insertWaiverProcessingEvent: async ({ leagueId, fantasyRoundId, scheduledAt }) => {
      await db.insert(waiverProcessingEvents).values({ leagueId, fantasyRoundId, scheduledAt, status: "pending" }).onConflictDoNothing();
    },
    setEliminatedAtRound: async (_fantasyRound, _now) => { /* no-op — no QF fixtures exist yet */ },
    existingOverridePoints: async (fixtureId, playerId) => {
      const rows = await db.select({ overridePoints: playerMatchScores.overridePoints }).from(playerMatchScores)
        .where(and(eq(playerMatchScores.fixtureId, fixtureId), eq(playerMatchScores.playerId, playerId))).limit(1);
      return rows[0]?.overridePoints ?? null;
    },
  };
}

// ─── Step: Group draw + status flip ──────────────────────────────────────────

async function stepGroupDraw(leagueId: string): Promise<void> {
  console.log("\n=== STEP 1: GROUP DRAW ===");

  const [existing] = await db.select({ id: scheduleSlots.id }).from(scheduleSlots)
    .where(eq(scheduleSlots.leagueId, leagueId)).limit(1);

  if (existing) {
    console.log("  schedule_slots already exist — skipping group draw");
  } else {
    const result = await runGroupDraw(leagueId);
    console.log(`  slots assigned: ${result.slotsAssigned}`);
    console.log(`  group matchups created: ${result.groupMatchupsCreated}`);
    console.log(`  fantasy rounds created: ${result.fantasyRoundsCreated}`);
  }

  // Flip status regardless (idempotent update)
  await db.update(leagues).set({ status: "group_stage", updatedAt: new Date() })
    .where(eq(leagues.id, leagueId));
  console.log("  leagues.status → group_stage");
}

// ─── Step: Auto-lineups for MD1 ───────────────────────────────────────────────

async function stepAutoLineups(leagueId: string): Promise<void> {
  console.log("\n=== STEP 2: AUTO-LINEUPS (MD1) ===");

  const [roundRow] = await db.select({ id: fantasyRounds.id }).from(fantasyRounds)
    .where(and(eq(fantasyRounds.leagueId, leagueId), eq(fantasyRounds.round, "group_md1"))).limit(1);
  if (!roundRow) throw new Error("group_md1 fantasy round not found — did group draw run?");
  const fantasyRoundId = roundRow.id;

  const managers = await db.select({ id: leagueMemberships.id, displayName: leagueMemberships.displayName })
    .from(leagueMemberships).where(eq(leagueMemberships.leagueId, leagueId));

  // Check if any lineups are already set for this round
  const [existingLineup] = await db.execute(sql`
    SELECT id FROM lineups WHERE league_id = ${leagueId} AND fantasy_round_id = ${fantasyRoundId} LIMIT 1
  `);
  if (existingLineup) {
    console.log(`  lineups already set for group_md1 — skipping`);
    return;
  }

  const formations = [
    { f: "4-4-2", gk: 1, def: 4, mid: 4, fwd: 2 },
    { f: "4-3-3", gk: 1, def: 4, mid: 3, fwd: 3 },
    { f: "4-5-1", gk: 1, def: 4, mid: 5, fwd: 1 },
    { f: "3-5-2", gk: 1, def: 3, mid: 5, fwd: 2 },
    { f: "3-4-3", gk: 1, def: 3, mid: 4, fwd: 3 },
    { f: "5-3-2", gk: 1, def: 5, mid: 3, fwd: 2 },
    { f: "5-4-1", gk: 1, def: 5, mid: 4, fwd: 1 },
  ];

  let ok = 0, skipped = 0;
  for (const manager of managers) {
    const rosterRows = await db.select({ playerId: players.id, name: players.name, pos: players.position })
      .from(rosters)
      .innerJoin(players, eq(players.id, rosters.playerId))
      .where(and(eq(rosters.leagueId, leagueId), eq(rosters.managerId, manager.id)))
      .orderBy(players.name);

    if (rosterRows.length !== 14) {
      console.log(`  SKIP ${manager.displayName}: ${rosterRows.length} players (expected 14)`);
      skipped++;
      continue;
    }

    const byPos: Record<string, string[]> = { GK: [], DEF: [], MID: [], FWD: [] };
    for (const p of rosterRows) byPos[p.pos].push(p.playerId);

    let chosen: (typeof formations)[0] | null = null;
    for (const form of formations) {
      if (byPos.GK.length >= form.gk && byPos.DEF.length >= form.def &&
          byPos.MID.length >= form.mid && byPos.FWD.length >= form.fwd) {
        chosen = form;
        break;
      }
    }
    if (!chosen) {
      console.log(`  SKIP ${manager.displayName}: no valid formation fits`);
      skipped++;
      continue;
    }

    const starterIds = [
      ...byPos.GK.slice(0, chosen.gk),
      ...byPos.DEF.slice(0, chosen.def),
      ...byPos.MID.slice(0, chosen.mid),
      ...byPos.FWD.slice(0, chosen.fwd),
    ];
    const starterSet = new Set(starterIds);
    const benchIds = rosterRows.filter(p => !starterSet.has(p.playerId)).map(p => p.playerId).slice(0, 3);

    await setLineup({ leagueId, managerId: manager.id, fantasyRoundId, formation: chosen.f, starterPlayerIds: starterIds, benchPlayerIds: benchIds, captainPlayerId: starterIds[0], vcPlayerId: starterIds[1] });
    ok++;
  }
  console.log(`  lineups set: ${ok}/${managers.length} (${skipped} skipped)`);
}

// ─── Step: Ingest one matchday ────────────────────────────────────────────────

async function stepIngestMatchday(
  leagueId: string,
  mdRound: string,
  remap: RemapEntry[],
  apiKey: string,
): Promise<void> {
  console.log(`\n=== STEP: INGEST ${mdRound.toUpperCase()} (${remap.length} fixtures) ===`);

  const fix2026Ids = remap.map(e => e.fix2026Id);
  const backdateTime = new Date(Date.now() - 2 * 3600 * 1000);

  // ── CLEAR ─────────────────────────────────────────────────────────────────
  console.log(`  Clearing prior ${mdRound} state...`);

  await db.update(fantasyRounds).set({ statsIngestedAt: null, updatedAt: new Date() })
    .where(and(eq(fantasyRounds.leagueId, leagueId), eq(fantasyRounds.round, mdRound as "group_md1" | "group_md2" | "group_md3")));

  await db.delete(playerMatchScores).where(inArray(playerMatchScores.fixtureId, fix2026Ids));
  await db.delete(playerMatchStats).where(inArray(playerMatchStats.fixtureId, fix2026Ids));
  await db.delete(rawApiResponses).where(inArray(rawApiResponses.fixtureId, fix2026Ids));

  const [mdRoundRow] = await db.select({ id: fantasyRounds.id }).from(fantasyRounds)
    .where(and(eq(fantasyRounds.leagueId, leagueId), eq(fantasyRounds.round, mdRound as "group_md1" | "group_md2" | "group_md3"))).limit(1);
  if (!mdRoundRow) throw new Error(`${mdRound} fantasy_round not found for league ${leagueId}`);

  await db.delete(waiverProcessingEvents)
    .where(and(eq(waiverProcessingEvents.leagueId, leagueId), eq(waiverProcessingEvents.fantasyRoundId, mdRoundRow.id)));

  await db.update(fantasyMatchups)
    .set({ homeScore: null, awayScore: null, winnerManagerId: null, updatedAt: new Date() })
    .where(and(eq(fantasyMatchups.leagueId, leagueId), eq(fantasyMatchups.fantasyRoundId, mdRoundRow.id)));

  await db.delete(groupStandings).where(eq(groupStandings.leagueId, leagueId));

  // ── PRE-BACKDATE (ensures fixtures are "settled" for resolveRound) ────────
  await db.update(realFixtures)
    .set({ finalizedAt: backdateTime, status: "FT", updatedAt: backdateTime })
    .where(inArray(realFixtures.id, fix2026Ids));
  console.log(`  Pre-backdated ${fix2026Ids.length} fixtures to ${backdateTime.toISOString()}`);

  // ── SEQUENTIAL SWEEP ──────────────────────────────────────────────────────
  const baseDeps = buildRealDepsBase();

  async function getSettledUnresolvedRoundsForLeague(now: Date) {
    const settleThreshold = new Date(now.getTime() - SETTLE_MS).toISOString();
    const result = await db.execute(sql`
      SELECT fr.league_id, fr.id AS fantasy_round_id, fr.round AS fantasy_round
      FROM fantasy_rounds fr
      WHERE fr.league_id = ${leagueId}
        AND fr.stats_ingested_at IS NULL
        AND EXISTS (SELECT 1 FROM real_fixtures rf WHERE rf.round = fr.round)
        AND NOT EXISTS (
          SELECT 1 FROM real_fixtures rf WHERE rf.round = fr.round
            AND (rf.finalized_at IS NULL OR rf.finalized_at > ${settleThreshold}::timestamptz)
        )
      ORDER BY CASE fr.round
        WHEN 'group_md1' THEN 0 WHEN 'group_md2' THEN 1 WHEN 'group_md3' THEN 2
        WHEN 'qf' THEN 3 WHEN 'sf' THEN 4 WHEN 'final' THEN 5 ELSE 99
      END
    `);
    return Array.from(result).map(r => {
      const row = r as Record<string, unknown>;
      return { leagueId: row.league_id as string, fantasyRoundId: row.fantasy_round_id as string, fantasyRound: row.fantasy_round as string };
    });
  }

  let totalPolled = 0, totalResolved = 0;

  for (let i = 0; i < remap.length; i++) {
    const entry = remap[i];
    const isLast = i === remap.length - 1;

    process.stdout.write(`  [${String(i + 1).padStart(2)}/${remap.length}] ${entry.fix2026Label.padEnd(46)}`);

    const playersResp = await fetchFixturePlayers(apiKey, entry.src2022Id);
    if (!playersResp.response || playersResp.response.length < 2) {
      throw new Error(`No player data for 2022 fixture ${entry.src2022Id} (${entry.fix2026Label})`);
    }
    const homeTeam = playersResp.response[0];
    const awayTeam = playersResp.response[1];
    entry.home2022TeamId = homeTeam.team.id;
    entry.away2022TeamId = awayTeam.team.id;

    const home2026Players = await getRosteredPlayers(leagueId, entry.home2026NationApiId);
    const away2026Players = await getRosteredPlayers(leagueId, entry.away2026NationApiId);

    const fixtureRemapMap: RemapMap = new Map();
    buildPositionalRemap(homeTeam.players, home2026Players, `${homeTeam.team.name}→[${entry.home2026NationApiId}]`).forEach((v, k) => fixtureRemapMap.set(k, v));
    buildPositionalRemap(awayTeam.players, away2026Players, `${awayTeam.team.name}→[${entry.away2026NationApiId}]`).forEach((v, k) => fixtureRemapMap.set(k, v));

    const fixtureRow: FixtureRow = {
      id: entry.fix2026Id,
      apiFootballId: entry.src2022Id,
      round: mdRound,
      kickoffAt: new Date(backdateTime.getTime() - 3600 * 1000),
      status: "FT",
      finalizedAt: backdateTime,
      homeNationApiId: entry.home2022TeamId,
      awayNationApiId: entry.away2022TeamId,
    };

    const batchDeps: SweepDeps = {
      ...baseDeps,
      getInWindowFixtures: async () => [fixtureRow],
      getSettledUnresolvedRounds: isLast ? getSettledUnresolvedRoundsForLeague : async () => [],
      getPlayersByApiIds: async (apiIds) => apiIds.flatMap(id => { const m = fixtureRemapMap.get(id); return m ? [m] : []; }),
      upsertRealFixtures: async () => {},
    };

    const result = await runIngestSweep(apiKey, batchDeps);
    process.stdout.write(` ${JSON.stringify(result)}\n`);
    totalPolled += result.polled ?? 0;
    totalResolved += result.resolved ?? 0;
    if (result.noOp) console.warn(`    WARNING: noOp on fixture ${i + 1}`);

    if (!isLast) await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`  ${mdRound} done: polled=${totalPolled} resolved=${totalResolved}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error("API_FOOTBALL_KEY not set in .env.local");

  // Resolve league ID
  let leagueId = process.argv[2];
  if (!leagueId) {
    const [row] = await db.select({ id: leagues.id }).from(leagues)
      .where(eq(leagues.name, DEV_LEAGUE_NAME)).limit(1);
    if (!row) throw new Error(`No league named "${DEV_LEAGUE_NAME}" found. Run db:dev-seed first.`);
    leagueId = row.id;
  }

  console.log(`\nDev-seed group stage extension`);
  console.log(`League: ${leagueId}`);
  console.log(`API calls: ~72 (24 fixtures × 3 MDs, 3s delay each)`);

  await stepGroupDraw(leagueId);
  await stepAutoLineups(leagueId);
  await stepIngestMatchday(leagueId, "group_md1", MD1_REMAP, apiKey);
  await stepIngestMatchday(leagueId, "group_md2", MD2_REMAP, apiKey);
  await stepIngestMatchday(leagueId, "group_md3", MD3_REMAP, apiKey);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== SUMMARY ===");

  const [sc] = await db.execute(sql`SELECT COUNT(*)::int as c FROM player_match_scores`);
  const [gc] = await db.execute(sql`SELECT COUNT(*)::int as c FROM group_standings WHERE league_id = ${leagueId}`);
  console.log(`player_match_scores: ${sc.c}  group_standings: ${gc.c}`);

  const standings = await db.execute(sql`
    SELECT gs.group_letter, gs.rank, lm.display_name, gs.wins, gs.losses, gs.draws,
           CAST(gs.points_for AS NUMERIC) AS pf
    FROM group_standings gs JOIN league_memberships lm ON lm.id = gs.manager_id
    WHERE gs.league_id = ${leagueId}
    ORDER BY gs.group_letter, gs.rank
    LIMIT 8
  `);
  console.log("\n  Group standings sample (first 2 groups):");
  console.log(`  ${"Grp".padEnd(4)} ${"Rnk".padEnd(4)} ${"Manager".padEnd(14)} ${"W-L-D".padEnd(8)} PF`);
  let lastGrp = "";
  for (const r of standings) {
    const row = r as Record<string, unknown>;
    if (String(row.group_letter) !== lastGrp) { console.log(); lastGrp = String(row.group_letter); }
    console.log(`  ${String(row.group_letter).padEnd(4)} ${String(row.rank).padEnd(4)} ${String(row.display_name).padEnd(14)} ${row.wins}-${row.losses}-${row.draws}      ${Number(row.pf).toFixed(2)}`);
  }

  const matchups = await db.execute(sql`
    SELECT lm_h.display_name AS home, lm_a.display_name AS away,
           fm.home_score, fm.away_score, fr.round
    FROM fantasy_matchups fm
    JOIN fantasy_rounds fr ON fr.id = fm.fantasy_round_id
    LEFT JOIN league_memberships lm_h ON lm_h.id = fm.home_manager_id
    LEFT JOIN league_memberships lm_a ON lm_a.id = fm.away_manager_id
    WHERE fm.league_id = ${leagueId} AND fm.home_score IS NOT NULL
    ORDER BY fr.round, fm.match_index
    LIMIT 6
  `);
  console.log("\n  Sample matchup results (first 6 scored):");
  for (const r of matchups) {
    const row = r as Record<string, unknown>;
    console.log(`  [${row.round}] ${String(row.home).padEnd(14)} vs ${String(row.away).padEnd(14)} ${Number(row.home_score).toFixed(2)} - ${Number(row.away_score).toFixed(2)}`);
  }

  const [league] = await db.select({ status: leagues.status }).from(leagues).where(eq(leagues.id, leagueId));
  console.log(`\n  leagues.status: ${league.status}`);
  console.log(`\nView group draw: http://localhost:3333/leagues/${leagueId}/group-draw`);
  console.log(`View draft board: http://localhost:3333/leagues/${leagueId}/draft`);
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error("\nFATAL:", err.message ?? err); await client.end(); process.exit(1); });
