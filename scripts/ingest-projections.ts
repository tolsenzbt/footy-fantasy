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
  "MEX:Jose Rangel":        "Raúl Rangel",       // RotoWire wrong first name; Mexico's only Rangel (GK)
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
    .replace(/ı/g, "i")     // ı (Turkish dotless i, U+0131) → i
    .replace(/İ/g, "I")     // İ (Turkish dotted I, U+0130) → I (NFD will add dot, strip below)
    .replace(/ß/g, "ss")          // German sharp s
    .replace(/[Øø]/g, "o")        // Scandinavian ø/Ø (no NFD decomposition)
    .replace(/[Ææ]/g, "ae")       // Scandinavian æ/Æ (no NFD decomposition)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[-‑‐]/g, " ") // hyphen variants → space
    .replace(/\./g, "")              // strip periods (Jr., etc.)
    .replace(/[''`‘’]/g, "") // strip apostrophes
    .replace(/\s+/g, " ")            // collapse whitespace
    .trim();
}

// Secondary key: transliteration folding for spelling-variant matching.
// Applied to the output of normalizeName.
function translitKey(norm: string): string {
  let s = norm;
  // Digraph folding (applied first, before y-rules and double-collapse)
  s = s.replace(/kh/g, "k");
  s = s.replace(/gh/g, "g");
  s = s.replace(/ph/g, "f");
  s = s.replace(/ck/g, "k");
  // c → k (consistent on both sides; handles zico/ziko, conor/connor post-double-fold)
  s = s.replace(/c/g, "k");
  // y rules applied BEFORE vowel-digraph folding so "sergeyev" → y-removal → "sergeev" → ee→i
  // y between two vowels: remove (sergeyev → sergeev, nasrullayev → nasrullaev)
  s = s.replace(/([aeiou])y([aeiou])/g, "$1$2");
  // y mid-word not between two vowels: → i (zrayq → zraiq)
  s = s.replace(/(?<=\w)y(?=\w)/g, "i");
  // y at word end: → i (fakhoury/fakhouri, hamdy/hamdi)
  s = s.replace(/y\b/g, "i");
  // Vowel digraph folding (after y-rules)
  s = s.replace(/oo/g, "u");
  s = s.replace(/ou/g, "u");
  s = s.replace(/ee/g, "i");
  s = s.replace(/eo/g, "u");  // Korean: hyeon → hyun
  s = s.replace(/aw/g, "a");  // Arabic diphthong: dawoud → daoud (then ou→u = daud)
  // w → v (after aw→a; handles Central Asian w-spellings)
  s = s.replace(/w/g, "v");
  // Universal double-letter collapse (vowels AND consonants: aa→a, mm→m, etc.)
  s = s.replace(/(.)\1+/g, "$1");
  // Strip standalone Arabic/patronymic particles
  s = s.replace(/\b(bin|bint|abu|ibn|al|el|abd)\b/g, "");
  // Normalize spaces
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Last-resort key: vowel-stripped consonant skeleton.
// Used only for long names (≥ 3 tokens) where translit still fails.
function skeletonKey(s: string): string {
  return s
    .replace(/[aeiou]/g, "")  // strip all vowels
    .replace(/(.)\1+/g, "$1") // collapse repeated chars
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fuzzy token matching ──────────────────────────────────────────────────────
// a matches b if: exact, OR one is a prefix of other (min len 3, ≥40% of longer),
// OR one is a suffix of other (min len 4). The 40% ratio prevents short particles
// like "abu" (3) from prefix-matching "abualnadi" (9): 3 < ceil(9*0.4)=4 → reject.
// "nur" (3) prefix of "nuredin" (7) still passes: 3 ≥ ceil(7*0.4)=3.
function fuzzyTokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3) return false;
  // Prefix: also require shorter ≥ 40% of longer to avoid particle-prefix collisions
  if (longer.startsWith(shorter) && shorter.length >= Math.ceil(longer.length * 0.4)) return true;
  if (shorter.length >= 4 && longer.endsWith(shorter)) return true; // suffix
  return false;
}

// All tokens in `smaller` fuzzy-match some token in `larger`
function fuzzySubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) => larger.some((lt) => fuzzyTokenMatch(st, lt)));
}

// All tokens in `smaller` exactly appear in `larger`
function exactSubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) => larger.includes(st));
}

// Skeleton subset: exact OR prefix (min len 2). Used in step 7 for same-token-count name pairs
// where first names differ only by suffix (andy/andrew, cammy/cameron).
function skelSubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) =>
    larger.some((lt) => {
      if (st === lt) return true;
      const [srt, lng] = st.length <= lt.length ? [st, lt] : [lt, st];
      return srt.length >= 2 && lng.startsWith(srt);
    })
  );
}

// Token match allowing skeleton fallback: fuzzy OR identical vowel-stripped skeleton.
// Skeleton path requires ≥2 shared bigrams to prevent collisions like "bono"/"bunu" (both→"bn")
// from matching when they're structurally unrelated words.
function fuzzyOrSkelTokenMatch(a: string, b: string): boolean {
  if (fuzzyTokenMatch(a, b)) return true;
  const sA = skeletonKey(a);
  const sB = skeletonKey(b);
  if (sA !== sB || sA.length === 0) return false;
  // Count shared bigrams in the original tokens
  const bigramsOf = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 1 < s.length; i++) set.add(s[i] + s[i + 1]);
    return set;
  };
  const ba = bigramsOf(a);
  const bb = bigramsOf(b);
  let shared = 0;
  for (const bg of ba) if (bb.has(bg)) shared++;
  return shared >= 2;
}

function fuzzyOrSkelSubset(smaller: string[], larger: string[]): boolean {
  return smaller.every((st) => larger.some((lt) => fuzzyOrSkelTokenMatch(st, lt)));
}

// ── Batch helper ─────────────────────────────────────────────────────────────
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
type DbPlayer = {
  id: string;
  name: string;
  nationId: string;
  position: string;
};

interface MatchSuccess {
  kind: "match";
  player: DbPlayer;
  step: string;
}
interface MatchAmbiguous {
  kind: "ambiguous";
  reason: string;
  candidates: string[];
}

function resolveWithPos(
  candidates: DbPlayer[],
  csvPositions: FantasyPosition[],
  step: string
): MatchSuccess | MatchAmbiguous | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { kind: "match", player: candidates[0], step };
  const filtered = candidates.filter((p) =>
    csvPositions.includes(p.position as FantasyPosition)
  );
  if (filtered.length === 1) return { kind: "match", player: filtered[0], step };
  if (filtered.length > 1)
    return {
      kind: "ambiguous",
      reason: `${step}: ${filtered.length} pos-filtered matches`,
      candidates: filtered.map((p) => p.name),
    };
  // position filter wiped everyone — position mismatch, but single original candidate
  return { kind: "match", player: candidates[0], step };
}

function matchPlayer(
  row: CsvRow,
  nationPlayers: DbPlayer[]
): MatchSuccess | MatchAmbiguous | null {
  const csvPositions = csvPosToDbPositions(row.pos);
  const csvNorm = normalizeName(row.name);
  const csvTranslit = translitKey(csvNorm);
  const csvTokensNorm = csvNorm.split(/\s+/).filter(Boolean);
  const csvTokensTranslit = csvTranslit.split(/\s+/).filter(Boolean);

  // Step 1: Exact normalized
  {
    const cands = nationPlayers.filter((p) => normalizeName(p.name) === csvNorm);
    const r = resolveWithPos(cands, csvPositions, "exact-norm");
    if (r) return r;
  }

  // Step 2: Token-sorted normalized
  {
    const csvSort = [...csvTokensNorm].sort().join(" ");
    const cands = nationPlayers.filter((p) => {
      const dbNorm = normalizeName(p.name);
      return dbNorm.split(/\s+/).filter(Boolean).sort().join(" ") === csvSort;
    });
    const r = resolveWithPos(cands, csvPositions, "token-sort-norm");
    if (r) return r;
  }

  // Step 3: Exact translit
  {
    const cands = nationPlayers.filter(
      (p) => translitKey(normalizeName(p.name)) === csvTranslit
    );
    const r = resolveWithPos(cands, csvPositions, "exact-translit");
    if (r) return r;
  }

  // Step 4: Token-sorted translit
  {
    const csvSort = [...csvTokensTranslit].sort().join(" ");
    const cands = nationPlayers.filter((p) => {
      const dbT = translitKey(normalizeName(p.name)).split(/\s+/).filter(Boolean);
      return [...dbT].sort().join(" ") === csvSort;
    });
    const r = resolveWithPos(cands, csvPositions, "token-sort-translit");
    if (r) return r;
  }

  // Step 5: Fuzzy subset on normalized tokens
  {
    const cands = nationPlayers.filter((p) => {
      const dbT = normalizeName(p.name).split(/\s+/).filter(Boolean);
      return fuzzySubset(csvTokensNorm, dbT) || fuzzySubset(dbT, csvTokensNorm);
    });
    const r = resolveWithPos(cands, csvPositions, "subset-norm");
    if (r) return r;
  }

  // Step 6: Fuzzy+skeleton subset on translit tokens
  // fuzzyOrSkelSubset allows a token to match via fuzzy prefix/suffix OR identical vowel-stripped skeleton,
  // catching vowel-variant pairs like atiah/ateah, ehsan/ihsan, amanov/amonov.
  {
    const cands = nationPlayers.filter((p) => {
      const dbT = translitKey(normalizeName(p.name)).split(/\s+/).filter(Boolean);
      return fuzzyOrSkelSubset(csvTokensTranslit, dbT) || fuzzyOrSkelSubset(dbT, csvTokensTranslit);
    });
    const r = resolveWithPos(cands, csvPositions, "subset-translit");
    if (r) return r;
  }

  // Step 7: Skeleton subset — handles nickname/formal-name pairs with same token count
  // (andy/andrew, cammy/cameron). Equal-token-count guard prevents mononyms from grabbing
  // longer DB names (e.g. "Bono"→1 token can't match "Yassine Bounou"→2 tokens).
  {
    const csvSkelTokens = skeletonKey(csvTranslit).split(/\s+/).filter(Boolean);
    if (csvSkelTokens.length >= 2) {
      const cands = nationPlayers.filter((p) => {
        const dbSkelTokens = skeletonKey(translitKey(normalizeName(p.name)))
          .split(/\s+/)
          .filter(Boolean);
        if (dbSkelTokens.length !== csvSkelTokens.length) return false;
        return skelSubset(csvSkelTokens, dbSkelTokens) || skelSubset(dbSkelTokens, csvSkelTokens);
      });
      const r = resolveWithPos(cands, csvPositions, "subset-skeleton");
      if (r) return r;
    }
  }

  return null;
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

    const result = matchPlayer(row, nationPlayers);

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
