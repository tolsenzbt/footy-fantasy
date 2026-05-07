/**
 * Tournament reference data seed script.
 * Populates nations, real_fixtures, and players from API-Football.
 *
 * Usage:
 *   npm run db:seed              # seed everything (default)
 *   npm run db:seed -- --nations
 *   npm run db:seed -- --players
 *   npm run db:seed -- --fixtures
 *   npm run db:seed -- --all
 *   npm run db:seed -- --no-cache
 *   npm run db:seed -- --wipe    # TRUNCATE before seeding (for 2022→2026 swap)
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { db } from "../src/db";
import { nations, players, realFixtures } from "../src/db/schema";
import { recomputeAllNationStatus } from "../src/lib/nation-status";
import { sql } from "drizzle-orm";

// ─── SWITCH THESE TWO LINES WHEN UPGRADING TO PAID PLAN ───────────────────────
const WC_LEAGUE_ID = 1;   // FIFA World Cup
const WC_SEASON = 2022;   // SWITCH TO 2026 WHEN PAID PLAN IS ACTIVE (≈ June 1)
// ──────────────────────────────────────────────────────────────────────────────

const API_BASE = "https://v3.football.api-sports.io";
const CACHE_DIR = path.join(process.cwd(), "cache", "api-football");
// Free tier: 10 req/min → 7000ms gives safe headroom (≈8.5 req/min)
// Pro tier: 450 req/min → drop to ~150ms when flipping WC_SEASON to 2026
const RATE_LIMIT_MS = 7000;

const API_KEY = process.env.API_FOOTBALL_KEY?.trim();
if (!API_KEY) {
  console.error("ERROR: API_FOOTBALL_KEY not set in .env.local");
  process.exit(1);
}

// ── Parse flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_NATIONS  = args.includes("--nations");
const FLAG_PLAYERS  = args.includes("--players");
const FLAG_FIXTURES = args.includes("--fixtures");
const FLAG_ALL      = args.includes("--all") || (!FLAG_NATIONS && !FLAG_PLAYERS && !FLAG_FIXTURES);
const NO_CACHE      = args.includes("--no-cache");
const WIPE          = args.includes("--wipe");

const DO_NATIONS  = FLAG_ALL || FLAG_NATIONS;
const DO_FIXTURES = FLAG_ALL || FLAG_FIXTURES;
const DO_PLAYERS  = FLAG_ALL || FLAG_PLAYERS;

// ── Request counters ──────────────────────────────────────────────────────────
let cacheHits = 0;
let networkRequests = 0;

// ── Disk cache ────────────────────────────────────────────────────────────────
function cacheKey(endpoint: string, params: Record<string, string | number>): string {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}-${v}`)
    .join("-");
  const safe = endpoint.replace(/\//g, "-").replace(/^-/, "");
  return path.join(CACHE_DIR, `${safe}-${paramStr}.json`);
}

function readCache(file: string): unknown | null {
  if (NO_CACHE) return null;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  return null;
}

function writeCache(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── API fetch with caching and rate limiting ──────────────────────────────────
async function apiFetch(
  endpoint: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const file = cacheKey(endpoint, params);
  const cached = readCache(file);
  if (cached !== null) {
    console.log(`  [cache] ${endpoint} ${JSON.stringify(params)}`);
    cacheHits++;
    return cached;
  }

  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  console.log(`  [net]   ${endpoint} ${JSON.stringify(params)}`);
  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": API_KEY! },
  });

  if (!res.ok) throw new Error(`API error ${res.status} for ${url}`);
  const data = await res.json() as Record<string, unknown>;
  networkRequests++;

  if (data.errors && typeof data.errors === "object" && Object.keys(data.errors as object).length > 0) {
    throw new Error(`API returned errors: ${JSON.stringify(data.errors)}`);
  }

  writeCache(file, data);
  await sleep(RATE_LIMIT_MS);
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Prompt for confirmation ───────────────────────────────────────────────────
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [yes/no]: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// ── Phase 0: Coverage check ───────────────────────────────────────────────────
async function checkCoverage(): Promise<void> {
  console.log("\n=== Phase 0: Coverage check ===");
  const data = await apiFetch("/leagues", { id: WC_LEAGUE_ID }) as {
    response: Array<{
      league: { id: number; name: string };
      seasons: Array<{
        year: number;
        current: boolean;
        coverage: {
          fixtures: { statistics_players?: boolean };
          players?: boolean;
          [key: string]: unknown;
        };
      }>;
    }>;
  };

  const league = data.response[0];
  if (!league) throw new Error("League not found in API response");

  const season = league.seasons.find((s) => s.year === WC_SEASON);
  if (!season) {
    throw new Error(`Season ${WC_SEASON} not found for league ${WC_LEAGUE_ID}. Available: ${league.seasons.map(s => s.year).join(", ")}`);
  }

  const coverage = season.coverage;
  console.log(`  League: ${league.league.name} (ID ${WC_LEAGUE_ID})`);
  console.log(`  Season: ${WC_SEASON} (current=${season.current})`);
  console.log(`  Coverage: ${JSON.stringify(coverage, null, 4)}`);

  const statsPlayers = coverage.fixtures?.statistics_players === true;
  const coveragePlayers = coverage.players === true;

  if (!statsPlayers || !coveragePlayers) {
    console.error("\nERROR: Coverage check failed:");
    console.error(`  coverage.fixtures.statistics_players = ${statsPlayers} (required: true)`);
    console.error(`  coverage.players = ${coveragePlayers} (required: true)`);
    process.exit(1);
  }

  console.log("  ✓ Coverage check passed");
}

// ── Wipe tables ───────────────────────────────────────────────────────────────
async function wipeTables(): Promise<void> {
  console.log("\n=== WIPE MODE ===");
  console.log("This will TRUNCATE nations, players, and real_fixtures with CASCADE.");
  console.log("All league-side data (lineups, rosters, draft picks, etc.) will be deleted.");
  const ok = await confirm("Are you sure you want to wipe all tournament data?");
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }
  // Truncate in dependency order; CASCADE handles the rest
  await db.execute(sql`TRUNCATE TABLE players, real_fixtures, nations CASCADE`);
  console.log("  ✓ Tables wiped");
}

// ── Phase 1: Nations ──────────────────────────────────────────────────────────
type NationRow = { inserted: number; updated: number; total: number };

async function seedNations(): Promise<NationRow> {
  console.log("\n=== Phase 1: Nations ===");

  // 1a: Fetch teams
  const teamsData = await apiFetch("/teams", { league: WC_LEAGUE_ID, season: WC_SEASON }) as {
    response: Array<{ team: { id: number; name: string; code: string } }>;
  };
  const teams = teamsData.response;
  console.log(`  Fetched ${teams.length} teams`);

  // 1b: Fetch standings to get group letter assignments
  // Group letters are NOT available in the /teams or /fixtures endpoints —
  // only /standings has the "Group A" / "Group B" structure.
  const standingsData = await apiFetch("/standings", { league: WC_LEAGUE_ID, season: WC_SEASON }) as {
    response: Array<{
      league: {
        standings: Array<Array<{ group: string; team: { id: number } }>>;
      };
    }>;
  };

  // Build a map from apiFootballId → group letter
  const groupByTeamId = new Map<number, string>();
  const leagueStandings = standingsData.response[0]?.league.standings ?? [];
  for (const group of leagueStandings) {
    for (const entry of group) {
      // entry.group is e.g. "Group A" — extract the letter
      const match = entry.group.match(/Group\s+([A-Z])/i);
      if (match) groupByTeamId.set(entry.team.id, match[1].toUpperCase());
    }
  }
  console.log(`  Resolved group letters for ${groupByTeamId.size} teams from standings`);

  for (const { team } of teams) {
    const realGroup = groupByTeamId.get(team.id) ?? "";
    await db
      .insert(nations)
      .values({
        name: team.name,
        fifaCode: team.code ?? team.name.slice(0, 3).toUpperCase(),
        realGroup,
        apiFootballId: team.id,
      })
      .onConflictDoUpdate({
        target: nations.apiFootballId,
        set: {
          name: team.name,
          fifaCode: team.code ?? team.name.slice(0, 3).toUpperCase(),
          realGroup,
          updatedAt: new Date(),
        },
      });
  }

  const total = (await db.select({ count: sql<number>`count(*)` }).from(nations))[0].count;
  console.log(`  Nations upserted: ${teams.length} (total in DB: ${total})`);
  return { inserted: teams.length, updated: 0, total: Number(total) };
}

// ── Phase 2: Fixtures ─────────────────────────────────────────────────────────
type FixtureRow = { inserted: number; updated: number; total: number };

// Map API-Football round strings to our fantasy_round enum
// Group stage rounds map to group_md1/2/3; knockout rounds map accordingly.
function mapRound(roundStr: string): "group_md1" | "group_md2" | "group_md3" | "qf" | "sf" | "final" | null {
  const r = roundStr.toLowerCase();
  if (r.includes("group stage - 1") || r === "group stage - matchday 1") return "group_md1";
  if (r.includes("group stage - 2") || r === "group stage - matchday 2") return "group_md2";
  if (r.includes("group stage - 3") || r === "group stage - matchday 3") return "group_md3";
  // Handle "Group Stage - 1", "Group Stage - 2", "Group Stage - 3" patterns
  const matchRound = r.match(/group stage\s*-\s*(\d+)/);
  if (matchRound) {
    const n = parseInt(matchRound[1]);
    if (n === 1) return "group_md1";
    if (n === 2) return "group_md2";
    if (n === 3) return "group_md3";
  }
  // Fantasy qf = real R32, sf = real R16, final = real QF
  if (r.includes("round of 32") || r.includes("round of 16 - 2")) return "qf";   // 2022 WC has R16 not R32; 2026 has R32
  if (r.includes("round of 16")  && !r.includes("round of 16 - 2")) return "sf";
  if (r.includes("quarter-final") || r.includes("quarterfinal")) return "final";
  // 2026-specific: round of 32 = fantasy qf
  if (r.includes("round of 32")) return "qf";
  return null; // semis, 3rd place, actual final — after fantasy season ends
}

async function seedFixtures(): Promise<FixtureRow> {
  console.log("\n=== Phase 2: Fixtures ===");

  // Load all nations from DB to resolve FK
  const nationRows = await db.select({ id: nations.id, apiFootballId: nations.apiFootballId }).from(nations);
  const nationById = new Map(nationRows.map((n) => [n.apiFootballId, n.id]));

  let page = 1;
  let totalPages = 1;
  const allFixtures: unknown[] = [];

  while (page <= totalPages) {
    const data = await apiFetch("/fixtures", {
      league: WC_LEAGUE_ID,
      season: WC_SEASON,
      timezone: "UTC",
    }) as {
      response: unknown[];
      paging: { current: number; total: number };
    };
    totalPages = data.paging.total;
    allFixtures.push(...data.response);
    if (page >= totalPages) break;
    page++;
  }

  console.log(`  Fetched ${allFixtures.length} fixtures across ${totalPages} page(s)`);

  type ApiFixture = {
    fixture: { id: number; date: string; status: { short: string } };
    league: { round: string };
    teams: {
      home: { id: number; name: string };
      away: { id: number; name: string };
    };
    goals: { home: number | null; away: number | null };
  };

  let upserted = 0;
  let skipped = 0;

  for (const raw of allFixtures) {
    const fx = raw as ApiFixture;
    const round = mapRound(fx.league.round);

    if (round === null) {
      // Post-fantasy-season rounds (semis, 3rd place, WC final) — skip
      skipped++;
      continue;
    }

    const homeNationId = nationById.get(fx.teams.home.id);
    const awayNationId = nationById.get(fx.teams.away.id);

    if (!homeNationId || !awayNationId) {
      console.warn(`  WARNING: unknown nation in fixture ${fx.fixture.id} (home=${fx.teams.home.id}, away=${fx.teams.away.id}) — skipping`);
      skipped++;
      continue;
    }

    const isFinalized = ["FT", "AET", "PEN"].includes(fx.fixture.status.short);

    await db
      .insert(realFixtures)
      .values({
        round,
        homeNationId,
        awayNationId,
        kickoffAt: new Date(fx.fixture.date),
        status: isFinalized ? "finalized" : fx.fixture.status.short === "LIVE" ? "live" : "scheduled",
        apiFootballId: fx.fixture.id,
        homeScore: fx.goals.home ?? null,
        awayScore: fx.goals.away ?? null,
      })
      .onConflictDoUpdate({
        target: realFixtures.apiFootballId,
        set: {
          round,
          kickoffAt: new Date(fx.fixture.date),
          status: isFinalized ? "finalized" : fx.fixture.status.short === "LIVE" ? "live" : "scheduled",
          homeScore: fx.goals.home ?? null,
          awayScore: fx.goals.away ?? null,
          updatedAt: new Date(),
        },
      });

    upserted++;
  }

  const total = (await db.select({ count: sql<number>`count(*)` }).from(realFixtures))[0].count;
  console.log(`  Fixtures upserted: ${upserted}, skipped (post-season): ${skipped}, total in DB: ${total}`);
  return { inserted: upserted, updated: 0, total: Number(total) };
}

// ── Phase 4: Players / Squads ─────────────────────────────────────────────────
type PlayerRow = { inserted: number; updated: number; total: number };

const POSITION_MAP: Record<string, "GK" | "DEF" | "MID" | "FWD"> = {
  Goalkeeper: "GK",
  Defender: "DEF",
  Midfielder: "MID",
  Attacker: "FWD",
};

async function seedPlayers(): Promise<PlayerRow> {
  console.log("\n=== Phase 4: Players ===");
  console.log("  NOTE: /players/squads returns CURRENT squads, not historical 2022 squads.");
  console.log("  This is acceptable for shape/integration testing. Squads will be re-seeded for 2026.");

  const nationRows = await db
    .select({ id: nations.id, apiFootballId: nations.apiFootballId, name: nations.name })
    .from(nations);

  let upserted = 0;
  let nationCounter = 0;

  for (const nation of nationRows) {
    nationCounter++;
    console.log(`  [${nationCounter}/${nationRows.length}] Fetching squad for ${nation.name} (API ID ${nation.apiFootballId})`);

    const data = await apiFetch("/players/squads", { team: nation.apiFootballId }) as {
      response: Array<{
        team: { id: number };
        players: Array<{
          id: number;
          name: string;
          position: string;
        }>;
      }>;
    };

    const squadEntry = data.response[0];
    if (!squadEntry) {
      console.warn(`    WARNING: no squad data returned for team ${nation.apiFootballId}`);
      continue;
    }

    for (const player of squadEntry.players) {
      const fp = POSITION_MAP[player.position];
      if (!fp) {
        throw new Error(
          `Unknown position string "${player.position}" for player ${player.id} (${player.name}) — update POSITION_MAP`
        );
      }

      await db
        .insert(players)
        .values({
          name: player.name,
          nationId: nation.id,
          realPosition: player.position,
          fantasyPosition: fp,
          apiFootballId: player.id,
          active: true,
        })
        .onConflictDoUpdate({
          target: players.apiFootballId,
          set: {
            name: player.name,
            nationId: nation.id,
            realPosition: player.position,
            fantasyPosition: fp,
            active: true,
            updatedAt: new Date(),
          },
        });

      upserted++;
    }
  }

  const total = (await db.select({ count: sql<number>`count(*)` }).from(players))[0].count;
  console.log(`  Players upserted: ${upserted}, total in DB: ${total}`);
  return { inserted: upserted, updated: 0, total: Number(total) };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log(`Footy Fantasy seed — WC_LEAGUE_ID=${WC_LEAGUE_ID}, WC_SEASON=${WC_SEASON}`);
  console.log("=".repeat(60));

  if (WIPE) await wipeTables();

  // Phase 0: always run
  await checkCoverage();

  const results = {
    nations: { inserted: 0, updated: 0, total: 0 },
    fixtures: { inserted: 0, updated: 0, total: 0 },
    players: { inserted: 0, updated: 0, total: 0 },
    nationStatusSet: 0,
    nationStatusTotal: 0,
  };

  if (DO_NATIONS) results.nations = await seedNations();

  if (DO_FIXTURES) {
    results.fixtures = await seedFixtures();

    console.log("\n=== Phase 3: Nation status recompute ===");
    const { set, cleared, total } = await recomputeAllNationStatus();
    results.nationStatusSet = set;
    results.nationStatusTotal = total;
    if (set === 0) {
      console.log(`  WARNING: next_fixture_id is null for all ${total} nations.`);
      console.log(`  Expected for ${WC_SEASON} data — all fixtures are in the past.`);
    } else {
      console.log(`  next_fixture_id set for ${set}/${total} nations, cleared for ${cleared}`);
    }
  }

  if (DO_PLAYERS) results.players = await seedPlayers();

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`WC_LEAGUE_ID: ${WC_LEAGUE_ID}  WC_SEASON: ${WC_SEASON}`);
  console.log(`Nations:  ${results.nations.inserted} upserted, total=${results.nations.total}`);
  console.log(`Fixtures: ${results.fixtures.inserted} upserted, total=${results.fixtures.total}`);
  console.log(`Players:  ${results.players.inserted} upserted, total=${results.players.total}`);
  console.log(`Nations with next_fixture_id set: ${results.nationStatusSet} / ${results.nationStatusTotal}`);
  console.log(`API requests — cache hits: ${cacheHits}, network: ${networkRequests}, total: ${cacheHits + networkRequests}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
