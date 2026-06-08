import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { db, client } from "../src/db";
import {
  players as playersTable,
  nations as nationsTable,
  playerProjections as playerProjectionsTable,
  playerRankings as playerRankingsTable,
} from "../src/db/schema";
import { sql } from "drizzle-orm";
import { scorePlayer, type FantasyPosition } from "../src/lib/scoring/engine";
import {
  normalizeName,
  matchPlayerByName,
  chunkArray,
  type DbPlayer,
  type MatchSuccess,
  type MatchAmbiguous,
} from "./lib/name-matcher";

// ── CSV code → nation name in DB ─────────────────────────────────────────────
const CSV_CODE_TO_NATION_NAME: Record<string, string> = {
  ALG: "Algeria",
  ARG: "Argentina",
  AUS: "Australia",
  AUT: "Austria",
  BEL: "Belgium",
  BIH: "Bosnia & Herzegovina",
  BRA: "Brazil",
  CAN: "Canada",
  CIV: "Ivory Coast",
  COD: "Congo DR",
  COL: "Colombia",
  CPV: "Cape Verde Islands",
  CRO: "Croatia",
  CUW: "Curaçao",
  CZE: "Czech Republic",
  ECU: "Ecuador",
  EGY: "Egypt",
  ENG: "England",
  ESP: "Spain",
  FRA: "France",
  GER: "Germany",
  GHA: "Ghana",
  HAI: "Haiti",
  IRN: "Iran",
  IRQ: "Iraq",
  JOR: "Jordan",
  JPN: "Japan",
  KOR: "South Korea",
  KSA: "Saudi Arabia",
  MAR: "Morocco",
  MEX: "Mexico",
  NED: "Netherlands",
  NOR: "Norway",
  NZL: "New Zealand",
  PAN: "Panama",
  PAR: "Paraguay",
  POR: "Portugal",
  QAT: "Qatar",
  RSA: "South Africa",
  SCO: "Scotland",
  SEN: "Senegal",
  SUI: "Switzerland",
  SWE: "Sweden",
  TUN: "Tunisia",
  TUR: "Türkiye",
  URU: "Uruguay",
  USA: "USA",
  UZB: "Uzbekistan",
};

// ── Explicit name overrides ───────────────────────────────────────────────────
// Applied after the rule-based matcher for confirmed pairs that exceed algorithmic reach
// (mononyms, nickname↔formal-name, word-split variants). Key: "CSV_CODE:CSV name".
// Leave null/omit for genuine non-matches (different player, not in squad, etc.).
const NAME_OVERRIDES: Record<string, string> = {
  "MAR:Bono":               "Yassine Bounou",    // mononym
  "MAR:Ez Abde":            "Abde Ezzalzouli",   // "ez" too short for prefix rule
  "SCO:Andrew Robertson":   "Andy Robertson",    // formal↔nickname
  "AUS:Cameron Devlin":     "Cammy Devlin",      // formal↔nickname
  "ESP:Alejandro Grimaldo": "Álex Grimaldo",     // different given name form
  "KSA:Nawaf Bu Washl":     "Nawaf Boushal",     // word-split vs. fused
  "UZB:Farruh Sayfiyev":    "Farrukh Sayfiev",  // h vs. kh transliteration
  "MEX:Jose Rangel":        "Raúl Rangel",       // RotoWire wrong first name; Mexico's only Rangel (GK),
  "JOR:Mohammad Abualnadi": "Mo Abualnadi"
};


// ── CSV parsing ───────────────────────────────────────────────────────────────
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

interface CsvRow {
  name: string;
  teamCode: string;
  pos: string;
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnGoal: number;
  chancesCreated: number;
  passes: number;
  crosses: number;
  accurateCrosses: number;
  interceptions: number;
  tackles: number;
  tacklesWon: number;
  blocks: number;
  clearances: number;
  cleanSheets: number;
  goalsConceded: number;
  saves: number;
  foulsSuffered: number;
  foulsCommitted: number;
  yellowCards: number;
  redCards: number;
}

function parseCsv(filePath: string): CsvRow[] {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(2).map((line) => {
    const f = parseCSVLine(line);
    return {
      name: f[0],
      teamCode: f[1],
      pos: f[2],
      minutes: parseFloat(f[3]),
      goals: parseFloat(f[4]),
      assists: parseFloat(f[5]),
      shots: parseFloat(f[6]),
      shotsOnGoal: parseFloat(f[7]),
      chancesCreated: parseFloat(f[8]),
      passes: parseFloat(f[9]),
      crosses: parseFloat(f[10]),
      accurateCrosses: parseFloat(f[11]),
      interceptions: parseFloat(f[12]),
      tackles: parseFloat(f[13]),
      tacklesWon: parseFloat(f[14]),
      blocks: parseFloat(f[15]),
      clearances: parseFloat(f[16]),
      cleanSheets: parseFloat(f[17]),
      goalsConceded: parseFloat(f[18]),
      saves: parseFloat(f[19]),
      foulsSuffered: parseFloat(f[20]),
      foulsCommitted: parseFloat(f[21]),
      yellowCards: parseFloat(f[22]),
      redCards: parseFloat(f[23]),
    };
  });
}

// ── CSV position → DB positions ───────────────────────────────────────────────
function csvPosToDbPositions(csvPos: string): FantasyPosition[] {
  return csvPos.split("/").flatMap((p) => {
    if (p === "G") return ["GK" as FantasyPosition];
    if (p === "D") return ["DEF" as FantasyPosition];
    if (p === "M") return ["MID" as FantasyPosition];
    if (p === "F") return ["FWD" as FantasyPosition];
    return [];
  });
}

// ── Matching pipeline ─────────────────────────────────────────────────────────

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = path.join(process.cwd(), "data/soccer-projections.csv");
  const rows = parseCsv(csvPath);
  console.log(`CSV data rows: ${rows.length}`);

  // ── Step 1: Build CSV code → nation_id map ───────────────────────────────
  const allNations = await db
    .select({ id: nationsTable.id, name: nationsTable.name })
    .from(nationsTable);
  const nationByName = new Map(allNations.map((n) => [n.name, n.id]));
  const nationNameById = new Map(allNations.map((n) => [n.id, n.name]));

  const codeToNationId = new Map<string, string>();
  const unmappedCodes: string[] = [];
  for (const [code, nationName] of Object.entries(CSV_CODE_TO_NATION_NAME)) {
    const id = nationByName.get(nationName);
    if (!id) unmappedCodes.push(`${code} → "${nationName}" NOT FOUND IN DB`);
    else codeToNationId.set(code, id);
  }
  if (unmappedCodes.length > 0) {
    console.error("STOP: unmapped nation codes:");
    unmappedCodes.forEach((m) => console.error("  " + m));
    await client.end();
    process.exit(1);
  }

  const csvCodes = new Set(rows.map((r) => r.teamCode));
  const missingFromMap = [...csvCodes].filter((c) => !codeToNationId.has(c));
  if (missingFromMap.length > 0) {
    console.error("STOP: CSV contains codes not in mapping:", missingFromMap);
    await client.end();
    process.exit(1);
  }
  console.log(`Codes mapped: ${codeToNationId.size}/48`);

  // ── Step 2: Load DB players grouped by nation ────────────────────────────
  const dbPlayers = await db
    .select({
      id: playersTable.id,
      name: playersTable.name,
      nationId: playersTable.nationId,
      position: playersTable.position,
    })
    .from(playersTable);

  const playersByNation = new Map<string, DbPlayer[]>();
  for (const p of dbPlayers) {
    if (!playersByNation.has(p.nationId)) playersByNation.set(p.nationId, []);
    playersByNation.get(p.nationId)!.push(p);
  }

  // ── Step 3: Match CSV rows → player_id ──────────────────────────────────
  interface Matched {
    csvRow: CsvRow;
    playerId: string;
    dbPosition: FantasyPosition;
    dbName: string;
    nationName: string;
    step: string;
  }
  interface Rejected {
    csvName: string;
    teamCode: string;
    pos: string;
    candidates: string[];
    reason: string;
  }

  const matched: Matched[] = [];
  const rejected: Rejected[] = [];

  for (const row of rows) {
    const nationId = codeToNationId.get(row.teamCode)!;
    const nationPlayers = playersByNation.get(nationId) ?? [];

    const result = matchPlayerByName(row.name, csvPosToDbPositions(row.pos), nationPlayers);

    if (result?.kind === "match") {
      matched.push({
        csvRow: row,
        playerId: result.player.id,
        dbPosition: result.player.position as FantasyPosition,
        dbName: result.player.name,
        nationName: nationNameById.get(nationId) ?? row.teamCode,
        step: result.step,
      });
      continue;
    }

    // Rule-based match failed — try explicit override map
    const overrideKey = `${row.teamCode}:${row.name}`;
    const overrideName = NAME_OVERRIDES[overrideKey];
    if (overrideName !== undefined) {
      const target = nationPlayers.find(
        (p) => normalizeName(p.name) === normalizeName(overrideName)
      );
      if (target) {
        matched.push({
          csvRow: row,
          playerId: target.id,
          dbPosition: target.position as FantasyPosition,
          dbName: target.name,
          nationName: nationNameById.get(nationId) ?? row.teamCode,
          step: "override",
        });
        continue;
      }
      console.warn(`  ⚠ override target not found in DB: "${overrideKey}" → "${overrideName}"`);
    }

    // Still unmatched
    rejected.push({
      csvName: row.name,
      teamCode: row.teamCode,
      pos: row.pos,
      candidates: result?.kind === "ambiguous" ? result.candidates : [],
      reason: result?.kind === "ambiguous" ? result.reason : "no match",
    });
  }

  console.log(`Matched: ${matched.length} / ${rows.length}`);
  console.log(`Rejected: ${rejected.length}`);

  // ── Collision guard: detect two CSV rows that resolved to the same player_id ─
  {
    const byId = new Map<string, Matched[]>();
    for (const m of matched) {
      const list = byId.get(m.playerId) ?? [];
      list.push(m);
      byId.set(m.playerId, list);
    }
    const collisions = [...byId.entries()].filter(([, ms]) => ms.length > 1);
    if (collisions.length > 0) {
      console.warn(`\n⚠ COLLISION: ${collisions.length} DB player(s) matched by multiple CSV rows:`);
      for (const [, ms] of collisions) {
        console.warn(`  DB "${ms[0].dbName}" (${ms[0].nationName}, ${ms[0].dbPosition}):`);
        for (const m of ms) {
          console.warn(`    - CSV "${m.csvRow.name}" (${m.csvRow.teamCode}/${m.csvRow.pos}) via ${m.step}`);
        }
      }
    } else {
      console.log("Collisions:  0 (all player_ids unique)");
    }
  }

  // Deduplicate for writes: last occurrence per player_id wins (consistent with sequential upsert).
  // Collisions are already surfaced above; extra rows are intentionally dropped from DB writes.
  const matchedForWrite = [...new Map(matched.map((m) => [m.playerId, m])).values()];

  // ── Step 4: Write player_projections (batched) ────────────────────────────
  console.log("\nWriting player_projections...");
  const projRows = matchedForWrite.map((m) => {
    const r = m.csvRow;
    return {
      playerId: m.playerId,
      minutes: String(r.minutes),
      goals: String(r.goals),
      assists: String(r.assists),
      shots: String(r.shots),
      shotsOnGoal: String(r.shotsOnGoal),
      chancesCreated: String(r.chancesCreated),
      passes: String(r.passes),
      crosses: String(r.crosses),
      accurateCrosses: String(r.accurateCrosses),
      interceptions: String(r.interceptions),
      tackles: String(r.tackles),
      tacklesWon: String(r.tacklesWon),
      blocks: String(r.blocks),
      clearances: String(r.clearances),
      cleanSheets: String(r.cleanSheets),
      goalsConceded: String(r.goalsConceded),
      saves: String(r.saves),
      foulsSuffered: String(r.foulsSuffered),
      foulsCommitted: String(r.foulsCommitted),
      yellowCards: String(r.yellowCards),
      redCards: String(r.redCards),
    };
  });
  for (const chunk of chunkArray(projRows, 200)) {
    await db
      .insert(playerProjectionsTable)
      .values(chunk)
      .onConflictDoUpdate({
        target: playerProjectionsTable.playerId,
        set: {
          minutes:        sql`excluded.minutes`,
          goals:          sql`excluded.goals`,
          assists:        sql`excluded.assists`,
          shots:          sql`excluded.shots`,
          shotsOnGoal:    sql`excluded.shots_on_goal`,
          chancesCreated: sql`excluded.chances_created`,
          passes:         sql`excluded.passes`,
          crosses:        sql`excluded.crosses`,
          accurateCrosses:sql`excluded.accurate_crosses`,
          interceptions:  sql`excluded.interceptions`,
          tackles:        sql`excluded.tackles`,
          tacklesWon:     sql`excluded.tackles_won`,
          blocks:         sql`excluded.blocks`,
          clearances:     sql`excluded.clearances`,
          cleanSheets:    sql`excluded.clean_sheets`,
          goalsConceded:  sql`excluded.goals_conceded`,
          saves:          sql`excluded.saves`,
          foulsSuffered:  sql`excluded.fouls_suffered`,
          foulsCommitted: sql`excluded.fouls_committed`,
          yellowCards:    sql`excluded.yellow_cards`,
          redCards:       sql`excluded.red_cards`,
          updatedAt:      sql`now()`,
        },
      });
  }
  console.log(`Wrote ${matchedForWrite.length} rows to player_projections.`);

  // ── Step 5: Score matched players via §6 engine ──────────────────────────
  interface ScoredEntry {
    playerId: string;
    name: string;
    nationName: string;
    position: FantasyPosition;
    projectedPoints: number;
  }

  const scored: ScoredEntry[] = matchedForWrite.map((m) => {
    const r = m.csvRow;
    const pts = scorePlayer(
      {
        minutesPlayed: r.minutes,
        goals: r.goals,
        assists: r.assists,
        concededWhileOnPitch: r.goalsConceded,
        saves: r.saves,
        penaltiesSaved: 0,
        penaltiesMissed: 0,
        yellowCards: r.yellowCards,
        redCards: r.redCards,
        ownGoals: 0,
      },
      m.dbPosition
    );
    return {
      playerId: m.playerId,
      name: m.dbName,
      nationName: m.nationName,
      position: m.dbPosition,
      projectedPoints: pts,
    };
  });

  scored.sort((a, b) => b.projectedPoints - a.projectedPoints);

  // ── Step 6: Write player_rankings ─────────────────────────────────────────
  const existingRankings = await db
    .select({
      playerId: playerRankingsTable.playerId,
      oRankOverridden: playerRankingsTable.oRankOverridden,
    })
    .from(playerRankingsTable);
  const overriddenSet = new Set(
    existingRankings.filter((r) => r.oRankOverridden).map((r) => r.playerId)
  );

  console.log("\nWriting player_rankings...");
  // Split into two groups: o_rank_overridden rows (skip oRank update) vs. normal rows.
  const rankNormal: { playerId: string; projectedPoints: string; oRank: number }[] = [];
  const rankOverridden: { playerId: string; projectedPoints: string }[] = [];
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const ptsStr = s.projectedPoints.toFixed(4);
    if (overriddenSet.has(s.playerId)) {
      rankOverridden.push({ playerId: s.playerId, projectedPoints: ptsStr });
    } else {
      rankNormal.push({ playerId: s.playerId, projectedPoints: ptsStr, oRank: i + 1 });
    }
  }
  for (const chunk of chunkArray(rankNormal, 200)) {
    await db
      .insert(playerRankingsTable)
      .values(chunk)
      .onConflictDoUpdate({
        target: playerRankingsTable.playerId,
        set: {
          projectedPoints: sql`excluded.projected_points`,
          oRank:           sql`excluded.o_rank`,
          updatedAt:       sql`now()`,
        },
      });
  }
  if (rankOverridden.length > 0) {
    for (const chunk of chunkArray(rankOverridden, 200)) {
      await db
        .insert(playerRankingsTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: playerRankingsTable.playerId,
          set: {
            projectedPoints: sql`excluded.projected_points`,
            updatedAt:       sql`now()`,
          },
        });
    }
  }
  console.log(`Wrote ${scored.length} rows to player_rankings.`);

  // ── Step 7: Report ────────────────────────────────────────────────────────
  const N = scored.length;
  console.log("\n════════════════════════════════════════");
  console.log("PROJECTIONS INGEST REPORT");
  console.log("════════════════════════════════════════");
  const overrideCount = matched.filter((m) => m.step === "override").length;
  const collisionDrop = matched.length - matchedForWrite.length;
  console.log(`Codes mapped:       ${codeToNationId.size}/48`);
  console.log(
    `CSV rows:           ${rows.length} total | ${matched.length} matched | ${rejected.length} rejected`
  );
  console.log(`  → rule-based:     ${matched.length - overrideCount}`);
  console.log(`  → overrides:      ${overrideCount}`);
  if (collisionDrop > 0) {
    console.log(`  → collision drops: ${collisionDrop} (see ⚠ above)`);
  }
  console.log(`Players scored:     ${N}`);
  console.log(`O-Rank range:       1..${N}`);

  console.log("\nTop 20 by O-Rank:");
  console.log("  Rank  Name                          Nation       Pos   Pts");
  console.log("  ────  ──────────────────────────── ──────────── ────  ────");
  for (let i = 0; i < Math.min(20, scored.length); i++) {
    const s = scored[i];
    console.log(
      `  ${String(i + 1).padStart(4)}  ${s.name.padEnd(30)} ${s.nationName.padEnd(12)} ${s.position.padEnd(4)}  ${s.projectedPoints.toFixed(1)}`
    );
  }

  console.log(`\nRejected rows (${rejected.length}):`);
  for (const r of rejected) {
    const cands =
      r.candidates.length > 0
        ? ` → candidates: [${r.candidates.join(" | ")}]`
        : "";
    console.log(
      `  ${r.csvName} | ${r.teamCode} | ${r.pos} | ${r.reason}${cands}`
    );
  }
}

main()
  .then(async () => {
    await client.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await client.end();
    process.exit(1);
  });
