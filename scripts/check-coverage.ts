/**
 * Verify that API-Football has full player-stat coverage for the target WC season.
 * Run any time the paid plan status is uncertain (especially around season switch).
 *
 * Usage:
 *   npm run db:check-coverage
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { WC_LEAGUE_ID, WC_SEASON, apiFetch } from "../src/lib/api-football";

async function main() {
  const API_KEY = process.env.API_FOOTBALL_KEY?.trim();
  if (!API_KEY) {
    console.error("ERROR: API_FOOTBALL_KEY not set in .env.local");
    process.exit(1);
  }

  console.log(`\nChecking API-Football coverage — league ${WC_LEAGUE_ID}, season ${WC_SEASON}\n`);

  const { data, headers } = await apiFetch(API_KEY, "/leagues", { id: WC_LEAGUE_ID });

  const remaining = headers.get("x-ratelimit-requests-remaining");

  const response = (data as {
    response: Array<{
      league: { id: number; name: string };
      seasons: Array<{
        year: number;
        current: boolean;
        coverage: {
          fixtures: {
            events: boolean;
            lineups: boolean;
            statistics_fixtures: boolean;
            statistics_players: boolean;
          };
          players: boolean;
          [k: string]: unknown;
        };
      }>;
    }>;
  }).response;

  const league = response[0];
  if (!league) {
    console.error("No league found in API response.");
    process.exit(1);
  }

  const season = league.seasons.find(s => s.year === WC_SEASON);
  if (!season) {
    const available = league.seasons.map(s => s.year).join(", ");
    console.error(`Season ${WC_SEASON} not found. Available years: ${available}`);
    process.exit(1);
  }

  const cov = season.coverage;
  console.log(`League : ${league.league.name} (ID ${league.league.id})`);
  console.log(`Season : ${WC_SEASON}  (current: ${season.current})`);
  console.log(`\nFull coverage object:\n${JSON.stringify(cov, null, 2)}`);

  const checks: Array<{ flag: string; val: boolean; required: boolean }> = [
    { flag: "coverage.fixtures.statistics_players", val: cov.fixtures.statistics_players, required: true },
    { flag: "coverage.players",                     val: cov.players,                     required: true },
    { flag: "coverage.fixtures.lineups",             val: cov.fixtures.lineups,            required: true },
    { flag: "coverage.fixtures.events",              val: cov.fixtures.events,             required: true },
    { flag: "coverage.fixtures.statistics_fixtures", val: cov.fixtures.statistics_fixtures, required: false },
  ];

  console.log("\n── Flag verdicts ─────────────────────────────────────────");
  let anyRequiredFailed = false;
  for (const c of checks) {
    const tag = c.required ? "[REQUIRED]     " : "[nice-to-have] ";
    const verdict = c.val ? "PASS ✓" : c.required ? "FAIL ✗" : "false ";
    if (c.required && !c.val) anyRequiredFailed = true;
    console.log(`  ${verdict}  ${tag}  ${c.flag}`);
  }

  console.log("\n── Quota ─────────────────────────────────────────────────");
  console.log(`  x-ratelimit-requests-remaining: ${remaining ?? "(header absent)"}`);

  console.log("\n── Verdict ───────────────────────────────────────────────");
  if (anyRequiredFailed) {
    console.error("  FAIL — required flags missing. Do not proceed with 2026 seed.");
    process.exit(1);
  }
  console.log("  PASS — all required coverage flags are true.");
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
