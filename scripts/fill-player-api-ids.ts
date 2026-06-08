/**
 * Fills players.api_football_id from the pre-cached /players/squads responses.
 *
 * Strategy: all 48 squad files are already in cache/api-football/ — zero new
 * API calls are made. We match wiki full-name players to abbreviated/full API
 * names using normalized string matching, then write back the id.
 *
 * Re-runnable: only players WHERE api_football_id IS NULL are processed.
 *
 * Usage:
 *   npm run db:fill-player-api-ids
 */

import fs from "fs";
import path from "path";
import { db, client } from "../src/db";
import { nations, players } from "../src/db/schema";
import { eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

const CACHE_DIR = path.join(process.cwd(), "cache", "api-football");

const API_POS_MAP: Record<string, "GK" | "DEF" | "MID" | "FWD"> = {
  Goalkeeper: "GK",
  Defender: "DEF",
  Midfielder: "MID",
  Attacker: "FWD",
};

type ApiPlayer = { id: number; name: string; position: string };

// ── Normalization ──────────────────────────────────────────────────────────────
// Lowercase + strip diacritics + hyphens→spaces + collapse whitespace.
// Also decodes HTML entities (API-Football returns e.g. "O&apos;Reilly").
function normalize(name: string): string {
  const decoded = name
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  return decoded
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/-/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ── Name-match confidence ──────────────────────────────────────────────────────
// Returns 'HIGH' (auto-accept eligible), 'MEDIUM' (reject-list candidate only),
// or null (no match).
function matchConfidence(
  wikiName: string,
  apiName: string
): "HIGH" | "MEDIUM" | null {
  const normWiki = normalize(wikiName);
  const normApi = normalize(apiName);
  const wikiTokens = normWiki.split(" ");
  const apiTokens = normApi.split(" ");

  // ── Abbreviated API name: "V. Lindelöf", "K. Nordfeldt", etc. ─────────────
  const abbrev = apiName.match(/^([A-Z])\. (.+)$/);
  if (abbrev) {
    const apiInitial = abbrev[1].toLowerCase();
    const apiSurname = normalize(abbrev[2]);
    const apiSurnameTokens = apiSurname.split(" ");

    if (!wikiTokens[0]) return null;
    if (apiInitial !== wikiTokens[0][0]) return null;

    // Match api_surname against any right-aligned suffix of the wiki tokens.
    // Handles: "Nordfeldt", "Widell Zetterström", "de Bruyne", "Al Aqidi".
    for (let n = apiSurnameTokens.length; n >= 1; n--) {
      const wikiSuffix = wikiTokens.slice(-n).join(" ");
      if (apiSurname === wikiSuffix) return "HIGH";
    }
    return null;
  }

  // ── Full API name (mononyms / Brazilian style) ─────────────────────────────
  if (normApi === normWiki) return "HIGH";

  // API is single token present in wiki (e.g. api="Ederson" in wiki="Ederson Moraes")
  if (apiTokens.length === 1 && wikiTokens.includes(normApi)) return "HIGH";
  // Wiki is single token present in API (e.g. wiki="Alisson" in api="Alisson Becker")
  if (wikiTokens.length === 1 && apiTokens.includes(normWiki)) return "HIGH";

  // All API tokens appear in wiki tokens (api is a name subset)
  if (apiTokens.every((t) => wikiTokens.includes(t))) return "HIGH";
  // All wiki tokens appear in API tokens (wiki is a name subset)
  if (wikiTokens.every((t) => apiTokens.includes(t))) return "HIGH";

  // Medium: meaningful token overlap (for reject-list candidates only)
  const wikiSet = new Set(wikiTokens);
  const overlap = apiTokens.filter((t) => wikiSet.has(t) && t.length > 2);
  const unionSize = new Set([...wikiTokens, ...apiTokens]).size;
  if (overlap.length >= 1 && overlap.length / unionSize >= 0.4) return "MEDIUM";

  return null;
}

type RejectEntry = {
  name: string;
  nation: string;
  position: string;
  reason: string;
  candidates: string[];
};

type MismatchEntry = {
  name: string;
  nation: string;
  wikiPosition: string;
  apiPosition: string;
  apiId: number;
};

async function main() {
  console.log("=".repeat(70));
  console.log("fill-player-api-ids — using cached squad files (0 API calls)");
  console.log("=".repeat(70));

  // Load nations
  const nationRows = await db
    .select({ id: nations.id, name: nations.name, apiFootballId: nations.apiFootballId })
    .from(nations);
  const nationMap = new Map(nationRows.map((n) => [n.id, n]));

  // Count already-filled and collect their API ids (to exclude from candidates)
  const alreadyFilled = (
    (await db.execute(
      sql`SELECT count(*)::int AS c FROM players WHERE api_football_id IS NOT NULL`
    )) as Array<{ c: number }>
  )[0].c;

  const usedApiIds = new Set<number>(
    (
      (await db.execute(
        sql`SELECT api_football_id FROM players WHERE api_football_id IS NOT NULL`
      )) as Array<{ api_football_id: number }>
    ).map((r) => r.api_football_id)
  );

  // Load players needing IDs
  const nullPlayers = await db
    .select({
      id: players.id,
      name: players.name,
      nationId: players.nationId,
      position: players.position,
    })
    .from(players)
    .where(isNull(players.apiFootballId));

  console.log(`\nPlayers already filled (skipped): ${alreadyFilled}`);
  console.log(`Players with null api_football_id:  ${nullPlayers.length}`);

  if (nullPlayers.length === 0) {
    console.log("\nAll players already have IDs.");
    await client.end();
    return;
  }

  // Load squad cache files
  const apiSquadByNationId = new Map<string, ApiPlayer[]>();
  for (const n of nationRows) {
    if (n.apiFootballId === null) continue;
    const file = path.join(CACHE_DIR, `players-squads-team-${n.apiFootballId}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`  WARN: no squad cache for ${n.name} (team ${n.apiFootballId})`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      response: Array<{ players: ApiPlayer[] }>;
    };
    apiSquadByNationId.set(n.id, raw.response[0]?.players ?? []);
  }

  // Group wiki players by nation
  const byNation = new Map<string, typeof nullPlayers>();
  for (const p of nullPlayers) {
    const list = byNation.get(p.nationId) ?? [];
    list.push(p);
    byNation.set(p.nationId, list);
  }

  const assignments: Array<{ playerId: string; apiId: number }> = [];
  const rejects: RejectEntry[] = [];
  const mismatches: MismatchEntry[] = [];

  // ── Per-nation matching ───────────────────────────────────────────────────
  for (const [nationId, wikiPlayers] of byNation) {
    const nation = nationMap.get(nationId)!;
    const apiSquad = apiSquadByNationId.get(nationId) ?? [];

    if (apiSquad.length === 0) {
      for (const wp of wikiPlayers) {
        rejects.push({
          name: wp.name, nation: nation.name, position: wp.position,
          reason: "no API squad cached", candidates: [],
        });
      }
      continue;
    }

    const wikiById = new Map(wikiPlayers.map((p) => [p.id, p]));

    // Step 1: collect HIGH-confidence candidates for each wiki player
    const highCandidates = new Map<string, ApiPlayer[]>(); // wiki id → []
    // Also collect all (HIGH|MEDIUM) for reject-list output
    const allCandidates = new Map<string, ApiPlayer[]>();

    for (const wp of wikiPlayers) {
      const high: ApiPlayer[] = [];
      const any: ApiPlayer[] = [];
      for (const ap of apiSquad) {
        // Skip API players whose id is already assigned to a filled player
        if (usedApiIds.has(ap.id)) continue;
        const conf = matchConfidence(wp.name, ap.name);
        if (conf === "HIGH") { high.push(ap); any.push(ap); }
        else if (conf === "MEDIUM") { any.push(ap); }
      }
      highCandidates.set(wp.id, high);
      allCandidates.set(wp.id, any);
    }

    // Step 2: build reverse map of HIGH matches — detect conflicts
    const apiIdCompetitors = new Map<number, string[]>(); // api id → wiki ids
    for (const [wikiId, cands] of highCandidates) {
      for (const ap of cands) {
        const list = apiIdCompetitors.get(ap.id) ?? [];
        list.push(wikiId);
        apiIdCompetitors.set(ap.id, list);
      }
    }

    // Step 3: resolve each wiki player
    for (const wp of wikiPlayers) {
      const highCands = highCandidates.get(wp.id) ?? [];
      const anyCands = allCandidates.get(wp.id) ?? [];

      if (highCands.length === 0) {
        rejects.push({
          name: wp.name, nation: nation.name, position: wp.position,
          reason: "no high-confidence name match",
          candidates: anyCands.map((ap) => `${ap.id}:${ap.name}(${ap.position})`),
        });
        continue;
      }

      // Resolve conflicts: filter to candidates where this wiki player wins
      const unambiguous: ApiPlayer[] = [];
      const contested: ApiPlayer[] = [];

      for (const ap of highCands) {
        const competitors = apiIdCompetitors.get(ap.id) ?? [];
        if (competitors.length === 1) {
          unambiguous.push(ap); // sole HIGH match
        } else {
          // Multiple wiki players matched this API player.
          // Keep only if this wp's position matches and no other competitor does.
          const apFp = API_POS_MAP[ap.position];
          const posMatchers = competitors.filter(
            (wid) => wikiById.get(wid)?.position === apFp
          );
          if (posMatchers.length === 1 && wp.position === apFp) {
            unambiguous.push(ap);
          } else {
            contested.push(ap);
          }
        }
      }

      if (unambiguous.length === 0) {
        const why = contested
          .map((ap) => {
            const others = (apiIdCompetitors.get(ap.id) ?? [])
              .filter((wid) => wid !== wp.id)
              .map((wid) => wikiById.get(wid)?.name ?? wid);
            return `${ap.id}:${ap.name}(${ap.position}) ↔ [${others.join(", ")}]`;
          })
          .join("; ");
        rejects.push({
          name: wp.name, nation: nation.name, position: wp.position,
          reason: `name conflict, position cannot disambiguate: ${why}`,
          candidates: highCands.map((ap) => `${ap.id}:${ap.name}(${ap.position})`),
        });
        continue;
      }

      if (unambiguous.length > 1) {
        // Multiple unambiguous by name — try position
        const posFiltered = unambiguous.filter(
          (ap) => API_POS_MAP[ap.position] === wp.position
        );
        if (posFiltered.length === 1) {
          assignments.push({ playerId: wp.id, apiId: posFiltered[0].id });
          usedApiIds.add(posFiltered[0].id);
          // No mismatch — position matched
        } else {
          rejects.push({
            name: wp.name, nation: nation.name, position: wp.position,
            reason: "multiple unambiguous candidates, position could not resolve",
            candidates: unambiguous.map((ap) => `${ap.id}:${ap.name}(${ap.position})`),
          });
        }
        continue;
      }

      // Single unambiguous candidate — auto-accept
      const ap = unambiguous[0];
      const apFp = API_POS_MAP[ap.position];
      assignments.push({ playerId: wp.id, apiId: ap.id });
      usedApiIds.add(ap.id);
      if (apFp !== wp.position) {
        mismatches.push({
          name: wp.name, nation: nation.name,
          wikiPosition: wp.position, apiPosition: apFp, apiId: ap.id,
        });
      }
    }
  }

  // ── Write back ────────────────────────────────────────────────────────────
  console.log(`\nMatching done. Writing ${assignments.length} assignments...`);
  for (const { playerId, apiId } of assignments) {
    await db
      .update(players)
      .set({ apiFootballId: apiId, updatedAt: new Date() })
      .where(eq(players.id, playerId));
  }
  console.log(`  ✓ ${assignments.length} rows updated (api_football_id only)`);

  const finalNull = (
    (await db.execute(
      sql`SELECT count(*)::int AS c FROM players WHERE api_football_id IS NULL`
    )) as Array<{ c: number }>
  )[0].c;

  const totalPlayers = (
    (await db.execute(
      sql`SELECT count(*)::int AS c FROM players`
    )) as Array<{ c: number }>
  )[0].c;

  // ── Closing report ─────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("CLOSING REPORT");
  console.log("=".repeat(70));
  console.log(`Total players:                    ${totalPlayers}`);
  console.log(`Auto-matched and filled this run: ${assignments.length}`);
  console.log(`Already filled (skipped):         ${alreadyFilled}`);
  console.log(`Still null after run:             ${finalNull}  ← punch-list count`);

  console.log(
    `\n── Position mismatches (informational — wiki vs API, no write) ──────`
  );
  if (mismatches.length === 0) {
    console.log("  None.");
  } else {
    for (const m of mismatches) {
      console.log(
        `  ${m.name} (${m.nation}) — wiki:${m.wikiPosition} api:${m.apiPosition} [id=${m.apiId}]`
      );
    }
  }

  console.log(`\n── Reject list (${rejects.length} players — still null) ─────────────────`);
  if (rejects.length === 0) {
    console.log("  None.");
  } else {
    for (const r of rejects) {
      const candStr =
        r.candidates.length > 0
          ? `candidates: [${r.candidates.join(", ")}]`
          : "no results";
      console.log(`  ${r.name} (${r.nation}, ${r.position})`);
      console.log(`    reason: ${r.reason}`);
      console.log(`    ${candStr}`);
    }
  }

  console.log("\n── Writes audit ──────────────────────────────────────────────────────");
  console.log("  Only players.api_football_id and players.updated_at were written.");
  console.log("  No other tables touched.");

  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  await client.end();
  process.exit(1);
});
