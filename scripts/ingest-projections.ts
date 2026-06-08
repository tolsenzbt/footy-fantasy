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
import { scorePlayer, type FantasyPosition } from "../src/lib/scoring/engine";

// ── CSV code → nation name in DB ─────────────────────────────────────────────
// DB fifaCode column has collisions (AUS→Australia+Austria, IRA→Iran+Iraq),
// so we map by nation name, not by fifaCode.
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

// ── Name normalization ────────────────────────────────────────────────────────
function decodeHtml(s: string): string {
  return s
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&agrave;/gi, "à")
    .replace(/&egrave;/gi, "è")
    .replace(/&auml;/gi, "ä")
    .replace(/&ouml;/gi, "ö")
    .replace(/&uuml;/gi, "ü")
    .replace(/&amp;/gi, "&");
}

function normalizeName(name: string): string {
  return decodeHtml(name)
    .replace(/[Øø]/g, "o")   // ø/Ø have no NFD decomposition
    .replace(/[Ææ]/g, "ae")  // æ/Æ have no NFD decomposition
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['']/g, "")
    .trim();
}

function tokenSort(name: string): string {
  return normalizeName(name)
    .split(/\s+/)
    .sort()
    .join(" ");
}

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
  // Skip two header rows: group row + column-name row
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
    if (!id) {
      unmappedCodes.push(`${code} → "${nationName}" NOT FOUND IN DB`);
    } else {
      codeToNationId.set(code, id);
    }
  }
  if (unmappedCodes.length > 0) {
    console.error("STOP: unmapped nation codes:");
    unmappedCodes.forEach((m) => console.error("  " + m));
    await client.end();
    process.exit(1);
  }

  // Verify every CSV code in the file has a mapping
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

  const playersByNation = new Map<string, typeof dbPlayers>();
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
    const normCsv = normalizeName(row.name);
    const tokenCsv = tokenSort(row.name);

    // Exact normalized match
    const exactMatches = nationPlayers.filter(
      (p) => normalizeName(p.name) === normCsv
    );

    if (exactMatches.length === 1) {
      matched.push({
        csvRow: row,
        playerId: exactMatches[0].id,
        dbPosition: exactMatches[0].position as FantasyPosition,
        dbName: exactMatches[0].name,
        nationName: nationNameById.get(nationId) ?? row.teamCode,
      });
      continue;
    }

    if (exactMatches.length > 1) {
      // Soft disambiguate by position
      const csvPositions = csvPosToDbPositions(row.pos);
      const filtered = exactMatches.filter((p) =>
        csvPositions.includes(p.position as FantasyPosition)
      );
      if (filtered.length === 1) {
        matched.push({
          csvRow: row,
          playerId: filtered[0].id,
          dbPosition: filtered[0].position as FantasyPosition,
          dbName: filtered[0].name,
          nationName: nationNameById.get(nationId) ?? row.teamCode,
        });
        continue;
      }
      rejected.push({
        csvName: row.name,
        teamCode: row.teamCode,
        pos: row.pos,
        candidates: exactMatches.map((p) => p.name),
        reason: `${exactMatches.length} exact matches, position ambiguous`,
      });
      continue;
    }

    // Token-sorted fallback (handles name-order differences)
    const tokenMatches = nationPlayers.filter(
      (p) => tokenSort(p.name) === tokenCsv
    );
    if (tokenMatches.length === 1) {
      matched.push({
        csvRow: row,
        playerId: tokenMatches[0].id,
        dbPosition: tokenMatches[0].position as FantasyPosition,
        dbName: tokenMatches[0].name,
        nationName: nationNameById.get(nationId) ?? row.teamCode,
      });
      continue;
    }
    if (tokenMatches.length > 1) {
      const csvPositions = csvPosToDbPositions(row.pos);
      const filtered = tokenMatches.filter((p) =>
        csvPositions.includes(p.position as FantasyPosition)
      );
      if (filtered.length === 1) {
        matched.push({
          csvRow: row,
          playerId: filtered[0].id,
          dbPosition: filtered[0].position as FantasyPosition,
          dbName: filtered[0].name,
          nationName: nationNameById.get(nationId) ?? row.teamCode,
        });
        continue;
      }
      rejected.push({
        csvName: row.name,
        teamCode: row.teamCode,
        pos: row.pos,
        candidates: tokenMatches.map((p) => p.name),
        reason: `${tokenMatches.length} token matches, position ambiguous`,
      });
      continue;
    }

    rejected.push({
      csvName: row.name,
      teamCode: row.teamCode,
      pos: row.pos,
      candidates: [],
      reason: "no match",
    });
  }

  console.log(`Matched: ${matched.length} / ${rows.length}`);
  console.log(`Rejected: ${rejected.length}`);

  // ── Step 4: Write player_projections ─────────────────────────────────────
  console.log("\nWriting player_projections...");
  for (const m of matched) {
    const r = m.csvRow;
    const vals = {
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
    await db
      .insert(playerProjectionsTable)
      .values(vals)
      .onConflictDoUpdate({
        target: playerProjectionsTable.playerId,
        set: {
          minutes: vals.minutes,
          goals: vals.goals,
          assists: vals.assists,
          shots: vals.shots,
          shotsOnGoal: vals.shotsOnGoal,
          chancesCreated: vals.chancesCreated,
          passes: vals.passes,
          crosses: vals.crosses,
          accurateCrosses: vals.accurateCrosses,
          interceptions: vals.interceptions,
          tackles: vals.tackles,
          tacklesWon: vals.tacklesWon,
          blocks: vals.blocks,
          clearances: vals.clearances,
          cleanSheets: vals.cleanSheets,
          goalsConceded: vals.goalsConceded,
          saves: vals.saves,
          foulsSuffered: vals.foulsSuffered,
          foulsCommitted: vals.foulsCommitted,
          yellowCards: vals.yellowCards,
          redCards: vals.redCards,
          updatedAt: new Date(),
        },
      });
  }
  console.log(`Wrote ${matched.length} rows to player_projections.`);

  // ── Step 5: Score matched players via §6 engine ──────────────────────────
  interface ScoredEntry {
    playerId: string;
    name: string;
    nationName: string;
    position: FantasyPosition;
    projectedPoints: number;
  }

  const scored: ScoredEntry[] = matched.map((m) => {
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

  // Sort descending by projected points
  scored.sort((a, b) => b.projectedPoints - a.projectedPoints);

  // ── Step 6: Write player_rankings ─────────────────────────────────────────
  const existingRankings = await db
    .select({
      playerId: playerRankingsTable.playerId,
      oRankOverridden: playerRankingsTable.oRankOverridden,
    })
    .from(playerRankingsTable);
  const overriddenSet = new Set(
    existingRankings
      .filter((r) => r.oRankOverridden)
      .map((r) => r.playerId)
  );

  console.log("\nWriting player_rankings...");
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const rank = i + 1;
    const isOverridden = overriddenSet.has(s.playerId);
    const ptsStr = s.projectedPoints.toFixed(4);

    if (isOverridden) {
      await db
        .insert(playerRankingsTable)
        .values({ playerId: s.playerId, projectedPoints: ptsStr })
        .onConflictDoUpdate({
          target: playerRankingsTable.playerId,
          set: { projectedPoints: ptsStr, updatedAt: new Date() },
        });
    } else {
      await db
        .insert(playerRankingsTable)
        .values({ playerId: s.playerId, projectedPoints: ptsStr, oRank: rank })
        .onConflictDoUpdate({
          target: playerRankingsTable.playerId,
          set: {
            projectedPoints: ptsStr,
            oRank: rank,
            updatedAt: new Date(),
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
  console.log(`Codes mapped:       ${codeToNationId.size}/48`);
  console.log(
    `CSV rows:           ${rows.length} total | ${matched.length} matched | ${rejected.length} rejected`
  );
  console.log(`Players scored:     ${N}`);
  console.log(`O-Rank range:       1..${N}`);

  console.log("\nTop 20 by O-Rank:");
  console.log(
    "  Rank  Name                          Nation       Pos   Pts"
  );
  console.log(
    "  ────  ──────────────────────────── ──────────── ────  ────"
  );
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
