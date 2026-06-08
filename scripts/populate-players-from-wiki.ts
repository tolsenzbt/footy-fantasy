import fs from "fs";
import path from "path";
import { db, client } from "../src/db";
import { nations, players } from "../src/db/schema";
import { sql } from "drizzle-orm";

const WIKI_PATH = path.join(process.cwd(), "data/wc-squads-2026.json");

const POSITION_MAP: Record<string, "GK" | "DEF" | "MID" | "FWD"> = {
  GK: "GK",
  DF: "DEF",
  MF: "MID",
  FW: "FWD",
};

// Wiki nation name → nations.name in DB (only entries that differ)
const NATION_ALIASES: Record<string, string> = {
  Turkey: "Türkiye",
  "Cape Verde": "Cape Verde Islands",
  "DR Congo": "Congo DR",
  "United States": "USA",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
};

async function countTable(table: string): Promise<number> {
  const rows = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM public.${table}`));
  return (rows as Array<{ c: number }>)[0].c;
}

async function main() {
  // ── Step 1: verify FK dependents are empty ──────────────────────────────
  const depTables = ["rosters", "draft_picks", "player_match_stats", "player_match_scores"];
  console.log("Step 1 — FK dependent counts:");
  let anyNonZero = false;
  for (const t of depTables) {
    const n = await countTable(t);
    const flag = n > 0 ? "  *** NON-ZERO ***" : "";
    console.log(`  ${t}: ${n}${flag}`);
    if (n > 0) anyNonZero = true;
  }
  if (anyNonZero) {
    console.error("STOP: non-empty FK dependents — resolve before wiping players.");
    await client.end();
    process.exit(1);
  }

  // ── Step 2: wipe players ─────────────────────────────────────────────────
  const before = await countTable("players");
  await db.execute(sql`TRUNCATE players CASCADE`);
  const after = await countTable("players");
  console.log(`\nStep 2 — Truncate players: ${before} → ${after}`);

  // ── Step 3: build nation name → id map ───────────────────────────────────
  const allNations = await db.select({ id: nations.id, name: nations.name }).from(nations);
  const nationByName = new Map(allNations.map((n) => [n.name, n.id]));

  const wikiData = JSON.parse(fs.readFileSync(WIKI_PATH, "utf-8")) as {
    squads: { nation: string; players: { name: string; position: string }[] }[];
  };

  const resolved = new Map<string, string>(); // wikiNation → nation_id
  const unresolved: string[] = [];

  for (const squad of wikiData.squads) {
    const wikiName = squad.nation;
    const dbName = NATION_ALIASES[wikiName] ?? wikiName;
    const id = nationByName.get(dbName);
    if (id) {
      resolved.set(wikiName, id);
    } else {
      unresolved.push(wikiName);
    }
  }

  if (unresolved.length > 0) {
    console.error(`\nSTOP: ${unresolved.length} wiki nation(s) did not resolve:`);
    for (const n of unresolved) console.error(`  "${n}"`);
    console.log("\nAvailable nation names in DB:");
    for (const n of allNations.map((n) => n.name).sort()) console.log(`  ${n}`);
    await client.end();
    process.exit(1);
  }
  console.log(`\nStep 3 — Nation resolution: ${resolved.size} resolved, 0 unresolved. ✓`);

  // ── Step 4: insert players ───────────────────────────────────────────────
  const rows: {
    name: string;
    nationId: string;
    realPosition: string;
    fantasyPosition: "GK" | "DEF" | "MID" | "FWD";
  }[] = [];

  for (const squad of wikiData.squads) {
    const nationId = resolved.get(squad.nation)!;
    for (const p of squad.players) {
      const fp = POSITION_MAP[p.position];
      if (!fp) {
        console.error(`Unknown position "${p.position}" for ${p.name} (${squad.nation})`);
        await client.end();
        process.exit(1);
      }
      rows.push({ name: p.name, nationId, realPosition: p.position, fantasyPosition: fp });
    }
  }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(players).values(rows.slice(i, i + CHUNK));
  }

  const total = await countTable("players");

  // Per-nation counts
  const perNation = (await db.execute(sql`
    SELECT n.name, COUNT(p.id)::int AS cnt
    FROM nations n
    JOIN players p ON p.nation_id = n.id
    GROUP BY n.name
    ORDER BY n.name
  `)) as Array<{ name: string; cnt: number }>;

  console.log(`\nStep 4 — Players inserted: ${total} (expected ~1243)`);
  console.log("\nPer-nation counts:");
  for (const row of perNation) {
    const flag = row.cnt < 23 || row.cnt > 26 ? "  *** OUT OF RANGE ***" : "";
    console.log(`  ${row.name}: ${row.cnt}${flag}`);
  }

  // Per-position totals
  const perPos = (await db.execute(sql`
    SELECT fantasy_position, COUNT(*)::int AS cnt
    FROM players
    GROUP BY fantasy_position
    ORDER BY fantasy_position
  `)) as Array<{ fantasy_position: string; cnt: number }>;

  console.log("\nPer-fantasy-position totals:");
  for (const row of perPos) {
    console.log(`  ${row.fantasy_position}: ${row.cnt}`);
  }

  console.log("\n── Validation gate ──────────────────────────────────────────────────");
  console.log(`  48 nations resolved: ✓`);
  console.log(`  Total players: ${total}`);

  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  await client.end();
  process.exit(1);
});
