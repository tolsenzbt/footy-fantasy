/**
 * Fetches the official 2026 FIFA World Cup squads from Wikipedia and writes
 * a frozen snapshot to data/wc-squads-2026.json.
 *
 * This file is frozen at fetch time. Downstream steps read this file;
 * they do NOT re-fetch.
 *
 * Run via:
 *   npm run db:fetch-wc-squads
 */

import fs from "fs";
import path from "path";

const WIKI_URL = "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_squads";
const OUT_FILE = path.join(process.cwd(), "data", "wc-squads-2026.json");

interface NationSquad {
  nation: string;
  players: Array<{ name: string; position: "GK" | "DF" | "MF" | "FW" }>;
}

interface OutputFile {
  metadata: {
    source: string;
    fetchedAt: string;
    totalNations: number;
    totalPlayers: number;
  };
  squads: NationSquad[];
  flat: Array<{ nation: string; name: string; position: "GK" | "DF" | "MF" | "FW" }>;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#160;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#\d+;/g, (m) => String.fromCodePoint(parseInt(m.slice(2, -1), 10)))
    .replace(/&#x[\da-fA-F]+;/g, (m) => String.fromCodePoint(parseInt(m.slice(3, -1), 16)));
}

function extractText(html: string): string {
  // Remove display:none spans (hidden sort keys)
  let s = html.replace(/<span[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "");
  // Remove footnote superscripts
  s = s.replace(/<sup[\s\S]*?<\/sup>/gi, "");
  // Remove all remaining tags
  s = s.replace(/<[^>]*>/g, "");
  // Decode entities
  s = decodeEntities(s);
  // Normalize whitespace
  return s.replace(/\s+/g, " ").trim();
}

// ── Player name cleaning ──────────────────────────────────────────────────────

function cleanName(raw: string): string {
  let s = raw;
  // Strip (captain) / (c) variants
  s = s.replace(/\s*\(captain\)\s*/gi, "");
  s = s.replace(/\s*\(\s*c\s*\)\s*/gi, "");
  // Strip bracketed annotations like [fa], [a], [n 1], etc.
  s = s.replace(/\s*\[[^\]]{0,20}\]\s*/g, "");
  return s.replace(/\s+/g, " ").trim();
}

// ── Position extraction ───────────────────────────────────────────────────────

const VALID_POSITIONS = new Set(["GK", "DF", "MF", "FW"]);

function extractPosition(tdHtml: string): "GK" | "DF" | "MF" | "FW" | null {
  // Position is the text of the <a> link inside the position <td>
  // e.g. <td><span style="display:none">1</span><a href="...">GK</a></td>
  const linkMatch = tdHtml.match(/<a[^>]*>([^<]+)<\/a>/i);
  if (linkMatch) {
    const pos = linkMatch[1].trim().toUpperCase();
    if (VALID_POSITIONS.has(pos)) return pos as "GK" | "DF" | "MF" | "FW";
  }
  // Fallback: extract text and look for position token
  const text = extractText(tdHtml).toUpperCase();
  for (const pos of ["GK", "DF", "MF", "FW"]) {
    if (text.includes(pos)) return pos as "GK" | "DF" | "MF" | "FW";
  }
  return null;
}

// ── Parse a nat-fs-player row ─────────────────────────────────────────────────

function parsePlayerRow(trHtml: string): { name: string; position: "GK" | "DF" | "MF" | "FW" } | null {
  // Extract all <td> and <th scope="row"> cells
  // Structure: td[0]=No., td[1]=Position, th[scope=row]=Player, td[2]=DOB, ...

  // Find the position cell: 2nd <td> in the row
  const tdMatches = [...trHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)];
  if (tdMatches.length < 2) return null;

  const posTdHtml = tdMatches[1][2]; // index 1 = second td = position
  const position = extractPosition(posTdHtml);
  if (!position) return null;

  // Find the player name: in <th ... scope="row">
  const thMatch = trHtml.match(/<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/i);
  if (!thMatch) return null;

  const nameRaw = extractText(thMatch[1]);
  const name = cleanName(nameRaw);
  if (!name) return null;

  return { name, position };
}

// ── Main parse ────────────────────────────────────────────────────────────────

function parseWikiPage(html: string): NationSquad[] {
  const squads: NationSquad[] = [];

  // Split by mw-heading3 divs to get nation sections.
  // Pattern: <div class="mw-heading mw-heading3"><h3 id="...">Nation Name</h3></div>
  // The div is always on one line based on inspection.
  const sectionSplit = html.split(/(<div[^>]*class="[^"]*mw-heading\s+mw-heading3[^"]*"[^>]*>[\s\S]*?<\/div>)/g);

  for (let i = 1; i < sectionSplit.length - 1; i += 2) {
    const headingDiv = sectionSplit[i];
    const sectionContent = sectionSplit[i + 1] ?? "";

    // Extract nation name from <h3 id="...">Nation Name</h3>
    const h3Match = headingDiv.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h3Match) continue;

    const nationRaw = extractText(h3Match[1]);
    if (!nationRaw) continue;

    // Skip non-squad sections (e.g. "Notes", "References", "External links", etc.)
    // Squad sections always contain nat-fs-player rows
    const playerRowMatches = [...sectionContent.matchAll(/<tr[^>]*class="[^"]*nat-fs-player[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (playerRowMatches.length === 0) continue;

    const players: Array<{ name: string; position: "GK" | "DF" | "MF" | "FW" }> = [];

    for (const rowMatch of playerRowMatches) {
      const player = parsePlayerRow(rowMatch[1]);
      if (player) players.push(player);
    }

    if (players.length === 0) continue;

    squads.push({ nation: nationRaw, players });
  }

  return squads;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("2026 FIFA World Cup Squads — Wikipedia Freeze");
  console.log("=".repeat(70));

  console.log(`\nFetching: ${WIKI_URL}`);
  const res = await fetch(WIKI_URL, {
    headers: {
      "User-Agent": "footy-fantasy-bot/1.0 (pre-launch squad freeze)",
      "Accept-Language": "en",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const html = await res.text();
  console.log(`  Fetched ${(html.length / 1024).toFixed(0)} KB`);

  console.log("\nParsing squad tables...");
  const squads = parseWikiPage(html);

  // ── Validation gate ───────────────────────────────────────────────────────
  console.log("\n=== Validation Gate ===");

  const nationCount = squads.length;
  console.log(`  Nations parsed: ${nationCount} (expected 48)`);

  if (nationCount !== 48) {
    console.error(`\n  ✗ ERROR: expected 48 nations, got ${nationCount}`);
    squads.forEach((s, i) =>
      console.error(`    ${i + 1}. ${s.nation} (${s.players.length} players)`)
    );
    process.exit(1);
  }

  let totalPlayers = 0;
  let outsideRange = 0;
  console.log("\n  Per-nation player counts:");

  for (const s of squads) {
    const count = s.players.length;
    totalPlayers += count;
    const flag = count < 23 || count > 26 ? "  ← OUTSIDE 23-26 RANGE" : "";
    if (flag) outsideRange++;
    console.log(`    ${s.nation.padEnd(32)} ${String(count).padStart(2)}${flag}`);
  }

  console.log(`\n  Total players: ${totalPlayers} (expected ~1,230–1,248)`);

  if (outsideRange > 0) {
    console.warn(`  ⚠ ${outsideRange} nations outside 23–26 range — review above`);
  } else {
    console.log("  ✓ All nations have 23–26 players");
  }

  // ── Write output ──────────────────────────────────────────────────────────
  const flat = squads.flatMap((s) =>
    s.players.map((p) => ({ nation: s.nation, name: p.name, position: p.position }))
  );

  const output: OutputFile = {
    metadata: {
      source: WIKI_URL,
      fetchedAt: new Date().toISOString(),
      totalNations: nationCount,
      totalPlayers,
    },
    squads,
    flat,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n  ✓ Written: ${OUT_FILE}`);
  console.log(`    ${nationCount} nations, ${totalPlayers} players`);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
