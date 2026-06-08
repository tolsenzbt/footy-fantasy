/**
 * Squad reconciliation report — Step 4.
 *
 * Reads data/wc-squads-2026.json (frozen Wikipedia snapshot) and compares
 * against the reseeded API-Football players in the DB.
 *
 * For each nation, classifies as:
 *   EXACT     — every wiki player matches an API player AND no API extras
 *   SUPERSET  — every wiki player has a match, but API pool has extras
 *   GAP       — one or more wiki players have NO match in API pool
 *
 * Matching is normalized (lowercase, strip accents, strip non-alpha) — rough
 * pass for diagnosis only.
 *
 * Run:
 *   tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/reconcile-squads.ts
 */

import fs from "fs";
import path from "path";
import { db, client } from "../src/db";
import { nations as nationsTable, players as playersTable } from "../src/db/schema";
import { eq } from "drizzle-orm";

const SQUADS_FILE = path.join(process.cwd(), "data", "wc-squads-2026.json");

interface PlayerEntry {
  nation: string;
  name: string;
  position: "GK" | "DF" | "MF" | "FW";
}

interface NationSquad {
  nation: string;
  players: Array<{ name: string; position: string }>;
}

interface SquadsFile {
  metadata: { source: string; fetchedAt: string; totalNations: number; totalPlayers: number };
  squads: NationSquad[];
  flat: PlayerEntry[];
}

// ── Normalization for rough matching ─────────────────────────────────────────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([\da-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function normalize(name: string): string {
  return decodeHtmlEntities(name)
    .toLowerCase()
    // Strip diacritics via NFD decomposition (explicit Unicode range)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Keep only letters and spaces
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// API-Football stores names as "X. LastName" (initial + dot + last name),
// or sometimes as a mononym ("Trincão", "Alisson", "Pele").
// Wikipedia stores full names ("FirstName LastName").
// Match heuristic (rough pass — purpose is to find COMPLETELY absent players):
//   - Exact normalized match, OR
//   - Last words match AND first chars match, OR
//   - API is a mononym matching the wiki's last word
function namesMatch(wikiNorm: string, apiNorm: string): boolean {
  if (wikiNorm === apiNorm) return true;

  const wikiWords = wikiNorm.split(" ");
  const apiWords = apiNorm.split(" ");

  const wikiLast = wikiWords[wikiWords.length - 1];
  const apiLast = apiWords[apiWords.length - 1];

  // API mononym: single word — match if it appears anywhere in the wiki words
  // e.g. api "trincao" matches wiki "francisco trincao"
  if (apiWords.length === 1) return wikiWords.includes(apiNorm);

  // Wiki mononym: match if it appears anywhere in the API words
  // e.g. wiki "alisson" matches api "alisson becker"
  if (wikiWords.length === 1) return apiWords.includes(wikiNorm);

  // General: last words must match AND first chars must match
  if (wikiLast !== apiLast) return false;
  return wikiNorm[0] === apiNorm[0];
}

// ── Nation name matching ──────────────────────────────────────────────────────

function normalizeNation(name: string): string {
  return decodeHtmlEntities(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Known mismatches between Wikipedia and API-Football nation names.
// Key = normalized wiki name, value = normalized DB name to look up instead.
const NATION_ALIASES: Record<string, string> = {
  "turkey":                  "turkiye",
  "united states":           "usa",
  "dr congo":                "congo dr",
  "cape verde":              "cape verde islands",
  "bosnia and herzegovina":  "bosnia herzegovina",
  "ivory coast":             "ivory coast",  // same, listed for clarity
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("2026 WC Squad Reconciliation Report");
  console.log("=".repeat(70));

  // Load the frozen wiki squads
  if (!fs.existsSync(SQUADS_FILE)) {
    throw new Error(`Squads file not found: ${SQUADS_FILE}\nRun scripts/fetch-wc-squads.ts first.`);
  }
  const squadsFile: SquadsFile = JSON.parse(fs.readFileSync(SQUADS_FILE, "utf-8"));
  console.log(`\nLoaded ${squadsFile.squads.length} nations from ${SQUADS_FILE}`);
  console.log(`  Fetched at: ${squadsFile.metadata.fetchedAt}`);
  console.log(`  Total wiki players: ${squadsFile.metadata.totalPlayers}`);

  // Load all DB nations and players
  const dbNations = await db.select().from(nationsTable);
  const dbPlayers = await db.select().from(playersTable);

  console.log(`\nDB: ${dbNations.length} nations, ${dbPlayers.length} players`);

  // Build: dbNationId → normalizedName, dbNationId → player names[]
  const dbNationByNormName = new Map<string, { id: string; name: string }>();
  for (const n of dbNations) {
    dbNationByNormName.set(normalizeNation(n.name), { id: n.id, name: n.name });
  }

  const dbPlayersByNationId = new Map<string, string[]>();
  for (const p of dbPlayers) {
    if (!dbPlayersByNationId.has(p.nationId)) {
      dbPlayersByNationId.set(p.nationId, []);
    }
    dbPlayersByNationId.get(p.nationId)!.push(p.name);
  }

  // ── Per-nation reconciliation ─────────────────────────────────────────────
  type Classification = "EXACT" | "SUPERSET" | "GAP";
  type NationResult = {
    wikiName: string;
    dbName: string | null;
    wikiCount: number;
    apiCount: number;
    classification: Classification;
    gapPlayers: string[];
    extraApiPlayers: string[];
  };

  const results: NationResult[] = [];
  let unmatchedNations = 0;

  for (const squad of squadsFile.squads) {
    const normWikiNation = normalizeNation(squad.nation);

    // Find DB nation — try exact normalized match first
    let dbNation = dbNationByNormName.get(normWikiNation) ?? null;

    // Try alias map for known wiki→DB name differences
    if (!dbNation) {
      const aliased = NATION_ALIASES[normWikiNation];
      if (aliased) dbNation = dbNationByNormName.get(aliased) ?? null;
    }

    // Try word-overlap fallback for remaining cases
    if (!dbNation) {
      for (const [dbNorm, dbN] of dbNationByNormName) {
        const wikiWords = new Set(normWikiNation.split(" ").filter((w) => w.length > 3));
        const dbWords = dbNorm.split(" ").filter((w) => w.length > 3);
        if (dbWords.some((w) => wikiWords.has(w))) {
          dbNation = dbN;
          break;
        }
      }
    }

    if (!dbNation) {
      console.warn(`  ⚠ No DB nation found for wiki nation: "${squad.nation}"`);
      unmatchedNations++;
      results.push({
        wikiName: squad.nation,
        dbName: null,
        wikiCount: squad.players.length,
        apiCount: 0,
        classification: "GAP",
        gapPlayers: squad.players.map((p) => p.name),
        extraApiPlayers: [],
      });
      continue;
    }

    const apiPlayerNames = dbPlayersByNationId.get(dbNation.id) ?? [];
    const apiNorms = apiPlayerNames.map(normalize);

    // For each wiki player, check if they have a match in API pool
    // using last-name + first-initial heuristic (handles "X. LastName" format)
    const gapPlayers: string[] = [];
    for (const wp of squad.players) {
      const normWiki = normalize(wp.name);
      const hasMatch = apiNorms.some((apiNorm) => namesMatch(normWiki, apiNorm));
      if (!hasMatch) {
        gapPlayers.push(wp.name);
      }
    }

    // Extra API players (in API pool but not matched by any wiki player)
    const extraApiPlayers = apiPlayerNames.filter((apiName) => {
      const apiNorm = normalize(apiName);
      return !squad.players.some((wp) => namesMatch(normalize(wp.name), apiNorm));
    });

    let classification: Classification;
    if (gapPlayers.length > 0) {
      classification = "GAP";
    } else if (extraApiPlayers.length > 0) {
      classification = "SUPERSET";
    } else {
      classification = "EXACT";
    }

    results.push({
      wikiName: squad.nation,
      dbName: dbNation.name,
      wikiCount: squad.players.length,
      apiCount: apiPlayerNames.length,
      classification,
      gapPlayers,
      extraApiPlayers,
    });
  }

  // ── Print per-nation table ────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("Per-Nation Reconciliation");
  console.log("=".repeat(70));

  const COL_NATION = 30;
  const COL_CLASS = 10;
  const COL_API = 5;
  const COL_WIKI = 5;
  const header = [
    "Nation (wiki)".padEnd(COL_NATION),
    "Class".padEnd(COL_CLASS),
    "API".padStart(COL_API),
    "Wiki".padStart(COL_WIKI),
  ].join("  ");
  console.log("\n  " + header);
  console.log("  " + "-".repeat(header.length));

  for (const r of results) {
    const row = [
      r.wikiName.padEnd(COL_NATION),
      r.classification.padEnd(COL_CLASS),
      String(r.apiCount).padStart(COL_API),
      String(r.wikiCount).padStart(COL_WIKI),
    ].join("  ");
    const indicator = r.classification === "GAP" ? "  ← GAP" : "";
    console.log(`  ${row}${indicator}`);

    if (r.gapPlayers.length > 0) {
      for (const p of r.gapPlayers) {
        console.log(`    ✗ missing: ${p}`);
      }
    }
  }

  // ── Global summary ────────────────────────────────────────────────────────
  const exactCount = results.filter((r) => r.classification === "EXACT").length;
  const supersetCount = results.filter((r) => r.classification === "SUPERSET").length;
  const gapCount = results.filter((r) => r.classification === "GAP").length;

  const totalGapPlayers = results.reduce((s, r) => s + r.gapPlayers.length, 0);

  console.log("\n" + "=".repeat(70));
  console.log("Global Summary");
  console.log("=".repeat(70));
  console.log(`\n  EXACT     : ${exactCount} nations`);
  console.log(`  SUPERSET  : ${supersetCount} nations (expected — API has full national pool, not just 26-man squad)`);
  console.log(`  GAP       : ${gapCount} nations (${totalGapPlayers} wiki players with no API match)`);
  if (unmatchedNations > 0) {
    console.warn(`\n  ⚠ ${unmatchedNations} wiki nations had NO corresponding DB nation — listed as GAP above`);
  }

  if (gapCount === 0) {
    console.log("\n  ✓ No gaps — every official squad member is in the API pool.");
  } else {
    console.log("\n  ⚠ GAP nations require attention before the draft pool is finalized.");
    console.log("    These players appear on the official squad but are absent from API-Football.");
    console.log("    Review each case: may be name mismatches, late call-ups, or missing data.");
  }
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error("\nFATAL:", err); await client.end(); process.exit(1); });
