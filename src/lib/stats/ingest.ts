import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  nations,
  players,
  realFixtures,
  fantasyRounds,
  playerMatchStats,
  playerMatchScores,
  rawApiResponses,
  waiverProcessingEvents,
} from "@/db/schema";
import {
  fetchAllFixtures,
  fetchFixtureEvents,
  fetchFixturePlayers,
  type ApiAllFixturesItem,
} from "@/lib/api-football";
import { scorePlayer } from "@/lib/scoring/engine";
import { resolveMatchups } from "@/lib/matchups/resolve";
import { computeStandings } from "@/lib/standings/compute";
import { resolveBracket } from "@/lib/bracket/resolve";
import { recomputeAllNationStatus } from "@/lib/nation-status";
import { deriveAllPlayerRawStats } from "./conceded";
import { mapRound, ROUND_ORDER, type FantasyRoundId } from "./round-map";

export const ROUND_SETTLE_HOURS = 1;
const SETTLE_MS = ROUND_SETTLE_HOURS * 3600 * 1000;

const TERMINAL_STATUSES = new Set(["FT", "AET", "PEN"]);

export type SweepResult = {
  noOp?: boolean;
  polled?: number;
  resolved?: number;
  error?: string;
};

export type FixtureRow = {
  id: string;
  apiFootballId: number;
  round: string;
  kickoffAt: Date;
  status: string;
  finalizedAt: Date | null;
  homeNationApiId: number;
  awayNationApiId: number;
};

export type RoundRow = {
  leagueId: string;
  fantasyRoundId: string;
  fantasyRound: string;
};

export type UpsertScoreArgs = {
  fixtureId: string;
  playerId: string;
  points: number;
  preserveOverride: boolean;
  updatedAt: Date;
};

export type SweepDeps = {
  getInWindowFixtures: (now: Date) => Promise<FixtureRow[]>;
  getSettledUnresolvedRounds: (now: Date) => Promise<RoundRow[]>;
  getLastResponseHash: (fixtureId: string, newHash: string) => Promise<boolean>;
  storeRawPayload: (fixtureId: string, payload: unknown, hash: string, fetchedAt: Date) => Promise<void>;
  setFinalizedAt: (fixtureId: string, at: Date) => Promise<void>;
  getPlayersByApiIds: (apiIds: number[]) => Promise<Array<{ id: string; apiFootballId: number; fantasyPosition: string }>>;
  upsertPlayerMatchStats: (args: unknown) => Promise<void>;
  upsertPlayerMatchScore: (args: UpsertScoreArgs) => Promise<void>;
  setStatsIngestedAt: (fantasyRoundId: string, at: Date) => Promise<void>;
  insertWaiverProcessingEvent: (args: { leagueId: string; fantasyRoundId: string; scheduledAt: Date }) => Promise<void>;
  upsertRealFixtures: (fixtures: ApiAllFixturesItem[]) => Promise<void>;
  setEliminatedAtRound: (fantasyRound: string, now: Date) => Promise<void>;
  existingOverridePoints: (fixtureId: string, playerId: string) => Promise<string | null>;
};

// ─── Production deps (built lazily on first real run) ─────────────────────────

async function buildRealDeps(allFixturesData: ApiAllFixturesItem[]): Promise<SweepDeps> {
  const nationRows = await db
    .select({ id: nations.id, apiFootballId: nations.apiFootballId })
    .from(nations);
  const nationByApiId = new Map(nationRows.map((n) => [n.apiFootballId, n.id]));

  // Index winner flags by fixture apiId for knockout elimination
  const winnerByApiId = new Map<number, { home: boolean | null; away: boolean | null }>(
    allFixturesData.map((f) => [
      f.fixture.id,
      { home: f.teams.home.winner, away: f.teams.away.winner },
    ]),
  );

  return {
    getInWindowFixtures: async (now) => {
      const settleThreshold = new Date(now.getTime() - SETTLE_MS);
      return db
        .select({
          id: realFixtures.id,
          apiFootballId: realFixtures.apiFootballId,
          round: realFixtures.round,
          kickoffAt: realFixtures.kickoffAt,
          status: realFixtures.status,
          finalizedAt: realFixtures.finalizedAt,
          homeNationApiId: sql<number>`(SELECT api_football_id FROM nations WHERE id = ${realFixtures.homeNationId})`,
          awayNationApiId: sql<number>`(SELECT api_football_id FROM nations WHERE id = ${realFixtures.awayNationId})`,
        })
        .from(realFixtures)
        .where(
          or(
            and(isNull(realFixtures.finalizedAt), sql`${realFixtures.kickoffAt} <= ${now}`),
            and(isNotNull(realFixtures.finalizedAt), gte(realFixtures.finalizedAt, settleThreshold)),
          ),
        );
    },

    getSettledUnresolvedRounds: async (now) => {
      const settleThreshold = new Date(now.getTime() - SETTLE_MS);
      const result = await db.execute(
        sql`
          SELECT fr.league_id, fr.id AS fantasy_round_id, fr.round AS fantasy_round
          FROM fantasy_rounds fr
          WHERE fr.stats_ingested_at IS NULL
            AND EXISTS (SELECT 1 FROM real_fixtures rf WHERE rf.round = fr.round)
            AND NOT EXISTS (
              SELECT 1 FROM real_fixtures rf
              WHERE rf.round = fr.round
                AND (rf.finalized_at IS NULL OR rf.finalized_at > ${settleThreshold})
            )
          ORDER BY CASE fr.round
            WHEN 'group_md1' THEN 0 WHEN 'group_md2' THEN 1 WHEN 'group_md3' THEN 2
            WHEN 'qf' THEN 3 WHEN 'sf' THEN 4 WHEN 'final' THEN 5 ELSE 99
          END
        `,
      );
      // Drizzle execute returns an array-like RowList; iterate it directly
      return Array.from(result).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          leagueId: row.league_id as string,
          fantasyRoundId: row.fantasy_round_id as string,
          fantasyRound: row.fantasy_round as string,
        };
      });
    },

    getLastResponseHash: async (fixtureId, newHash) => {
      const rows = await db
        .select({ responseHash: rawApiResponses.responseHash })
        .from(rawApiResponses)
        .where(
          and(eq(rawApiResponses.fixtureId, fixtureId), eq(rawApiResponses.responseHash, newHash)),
        )
        .limit(1);
      return rows.length > 0;
    },

    storeRawPayload: async (fixtureId, payload, hash, fetchedAt) => {
      await db
        .insert(rawApiResponses)
        .values({ fixtureId, payload: payload as Record<string, unknown>, responseHash: hash, fetchedAt })
        .onConflictDoNothing();
    },

    setFinalizedAt: async (fixtureId, at) => {
      await db
        .update(realFixtures)
        .set({ finalizedAt: at, updatedAt: at })
        .where(and(eq(realFixtures.id, fixtureId), isNull(realFixtures.finalizedAt)));
    },

    getPlayersByApiIds: async (apiIds) => {
      if (apiIds.length === 0) return [];
      const rows = await db
        .select({ id: players.id, apiFootballId: players.apiFootballId, fantasyPosition: players.fantasyPosition })
        .from(players)
        .where(inArray(players.apiFootballId, apiIds));
      return rows;
    },

    upsertPlayerMatchStats: async (args) => {
      type StatsInsert = typeof playerMatchStats.$inferInsert;
      const a = args as StatsInsert;
      const { fixtureId: _f, playerId: _p, ...rest } = a;
      await db
        .insert(playerMatchStats)
        .values(a)
        .onConflictDoUpdate({
          target: [playerMatchStats.fixtureId, playerMatchStats.playerId],
          set: rest,
        });
    },

    upsertPlayerMatchScore: async ({ fixtureId, playerId, points, updatedAt }) => {
      await db
        .insert(playerMatchScores)
        .values({ fixtureId, playerId, points: String(points), updatedAt })
        .onConflictDoUpdate({
          target: [playerMatchScores.fixtureId, playerMatchScores.playerId],
          set: {
            points: sql`CASE WHEN ${playerMatchScores.overridePoints} IS NULL THEN ${String(points)} ELSE ${playerMatchScores.points} END`,
            updatedAt,
          },
        });
    },

    setStatsIngestedAt: async (fantasyRoundId, at) => {
      await db
        .update(fantasyRounds)
        .set({ statsIngestedAt: at, updatedAt: at })
        .where(eq(fantasyRounds.id, fantasyRoundId));
    },

    insertWaiverProcessingEvent: async ({ leagueId, fantasyRoundId, scheduledAt }) => {
      await db
        .insert(waiverProcessingEvents)
        .values({ leagueId, fantasyRoundId, scheduledAt, status: "pending" })
        .onConflictDoNothing();
    },

    upsertRealFixtures: async (fixtures) => {
      const now = new Date();
      for (const f of fixtures) {
        const round = mapRound(f.league.round);
        if (!round) continue;
        const homeNationId = nationByApiId.get(f.teams.home.id);
        const awayNationId = nationByApiId.get(f.teams.away.id);
        if (!homeNationId || !awayNationId) continue;

        const kickoffAt = new Date(f.fixture.date);
        const isTerminal = TERMINAL_STATUSES.has(f.fixture.status.short);
        const homeScore = f.score.fulltime.home;
        const awayScore = f.score.fulltime.away;

        await db
          .insert(realFixtures)
          .values({
            apiFootballId: f.fixture.id,
            round,
            homeNationId,
            awayNationId,
            kickoffAt,
            status: f.fixture.status.short,
            homeScore,
            awayScore,
          })
          .onConflictDoUpdate({
            target: realFixtures.apiFootballId,
            set: {
              kickoffAt,
              status: f.fixture.status.short,
              homeScore,
              awayScore,
              updatedAt: now,
              // finalizedAt intentionally NOT set here — authoritative setter is
              // pollAndScoreFixture on first observed terminal-status transition only.
            },
          });

        void isTerminal; // referenced to suppress unused-var warning if linter runs
      }
    },

    setEliminatedAtRound: async (fantasyRound, now) => {
      if (fantasyRound === "group_md3") {
        // Guard: if no qf-round fixtures exist, skip (R32 schedule not yet published)
        const qfFixtures = await db
          .select({ homeNationId: realFixtures.homeNationId, awayNationId: realFixtures.awayNationId })
          .from(realFixtures)
          .where(eq(realFixtures.round, "qf"));

        if (qfFixtures.length === 0) {
          console.warn("setEliminatedAtRound group_md3: no qf fixtures found; skipping elimination update");
          return;
        }

        const advancingIds = new Set(qfFixtures.flatMap((f) => [f.homeNationId, f.awayNationId]));
        const allNationRows = await db.select({ id: nations.id }).from(nations);
        const eliminatedIds = allNationRows.map((n) => n.id).filter((id) => !advancingIds.has(id));
        if (eliminatedIds.length === 0) return;

        await db
          .update(nations)
          .set({ eliminatedAtRound: "group_md3", updatedAt: now })
          .where(and(isNull(nations.eliminatedAtRound), inArray(nations.id, eliminatedIds)));
      } else if (fantasyRound === "qf" || fantasyRound === "sf" || fantasyRound === "final") {
        const roundFixtures = await db
          .select({
            id: realFixtures.id,
            apiFootballId: realFixtures.apiFootballId,
            homeNationId: realFixtures.homeNationId,
            awayNationId: realFixtures.awayNationId,
          })
          .from(realFixtures)
          .where(and(eq(realFixtures.round, fantasyRound as FantasyRoundId), isNotNull(realFixtures.finalizedAt)));

        for (const fixture of roundFixtures) {
          const winners = winnerByApiId.get(fixture.apiFootballId);
          if (!winners) continue;

          let loserNationId: string | undefined;
          if (winners.home === false) loserNationId = fixture.homeNationId;
          else if (winners.away === false) loserNationId = fixture.awayNationId;
          else continue; // null/null — data not yet settled, skip

          await db
            .update(nations)
            .set({ eliminatedAtRound: fantasyRound as FantasyRoundId, updatedAt: now })
            .where(and(eq(nations.id, loserNationId), isNull(nations.eliminatedAtRound)));
        }
      }
    },

    existingOverridePoints: async (fixtureId, playerId) => {
      const rows = await db
        .select({ overridePoints: playerMatchScores.overridePoints })
        .from(playerMatchScores)
        .where(
          and(eq(playerMatchScores.fixtureId, fixtureId), eq(playerMatchScores.playerId, playerId)),
        )
        .limit(1);
      return rows[0]?.overridePoints ?? null;
    },
  };
}

// ─── Sweep entry point ────────────────────────────────────────────────────────

export async function runIngestSweep(
  apiKey: string,
  deps?: SweepDeps,
): Promise<SweepResult> {
  // Fixture refresh: upsert all WC fixtures (new knockout fixtures, status updates)
  const allFixturesData = await fetchAllFixtures(apiKey);

  const effectiveDeps = deps ?? (await buildRealDeps(allFixturesData));

  await effectiveDeps.upsertRealFixtures(allFixturesData);

  const now = new Date();
  const inWindowFixtures = await effectiveDeps.getInWindowFixtures(now);
  const settledRounds = await effectiveDeps.getSettledUnresolvedRounds(now);

  if (inWindowFixtures.length === 0 && settledRounds.length === 0) {
    return { noOp: true };
  }

  // Step 2: Poll + score all in-window fixtures concurrently
  await Promise.all(
    inWindowFixtures.map((fixture) => pollAndScoreFixture(apiKey, fixture, now, effectiveDeps)),
  );

  // Step 3: Re-query settled rounds (step 2 may have set finalizedAt on newly-terminal fixtures)
  const allSettledRounds = await effectiveDeps.getSettledUnresolvedRounds(now);
  const sortedRounds = [...allSettledRounds].sort(
    (a, b) =>
      (ROUND_ORDER[a.fantasyRound as FantasyRoundId] ?? 99) -
      (ROUND_ORDER[b.fantasyRound as FantasyRoundId] ?? 99),
  );

  for (const round of sortedRounds) {
    await resolveRound(round, now, effectiveDeps);
  }

  return { polled: inWindowFixtures.length, resolved: allSettledRounds.length };
}

// ─── Poll + score one fixture ─────────────────────────────────────────────────

async function pollAndScoreFixture(
  apiKey: string,
  fixture: FixtureRow,
  now: Date,
  deps: SweepDeps,
): Promise<void> {
  const [eventsPayload, playersPayload] = await Promise.all([
    fetchFixtureEvents(apiKey, fixture.apiFootballId),
    fetchFixturePlayers(apiKey, fixture.apiFootballId),
  ]);

  // Finalization detection: first observed terminal-status transition
  const apiStatus = eventsPayload.fixture?.status?.short ?? "";
  if (TERMINAL_STATUSES.has(apiStatus) && fixture.finalizedAt === null) {
    await deps.setFinalizedAt(fixture.id, now);
  }

  // Hash-based idempotency: skip if payload is unchanged
  const payloadStr = JSON.stringify({ events: eventsPayload, players: playersPayload });
  const hash = createHash("sha256").update(payloadStr).digest("hex");
  const alreadyStored = await deps.getLastResponseHash(fixture.id, hash);
  if (alreadyStored) return;

  await deps.storeRawPayload(fixture.id, { events: eventsPayload, players: playersPayload }, hash, now);

  const rawStatsMap = deriveAllPlayerRawStats(
    eventsPayload.response ?? [],
    playersPayload.response ?? [],
    fixture.homeNationApiId,
    fixture.awayNationApiId,
  );

  const apiIds = [...rawStatsMap.keys()];
  const playerRows = await deps.getPlayersByApiIds(apiIds);

  const positionMap: Record<string, "GK" | "DEF" | "MID" | "FWD"> = {
    G: "GK", D: "DEF", M: "MID", F: "FWD",
  };

  for (const playerRow of playerRows) {
    const raw = rawStatsMap.get(playerRow.apiFootballId);
    if (!raw) continue;

    await deps.upsertPlayerMatchStats({
      fixtureId: fixture.id,
      playerId: playerRow.id,
      minutesPlayed: raw.minutesPlayed,
      goals: raw.goals,
      assists: raw.assists,
      cleanSheet: raw.cleanSheet,
      saves: raw.saves,
      penaltySaves: raw.penaltySaves,
      penaltiesMissed: raw.penaltiesMissed,
      goalsConceded: raw.goalsConceded,
      concededWhileOnPitch: raw.concededWhileOnPitch,
      yellowCards: raw.yellowCards,
      redCard: raw.redCard,
      ownGoals: raw.ownGoals,
      updatedAt: now,
    });

    const enginePosition = positionMap[raw.position] ?? (playerRow.fantasyPosition as "GK" | "DEF" | "MID" | "FWD");
    const points = scorePlayer(
      {
        minutesPlayed: raw.minutesPlayed,
        goals: raw.goals,
        assists: raw.assists,
        concededWhileOnPitch: raw.concededWhileOnPitch,
        saves: raw.saves,
        penaltiesSaved: raw.penaltySaves,
        penaltiesMissed: raw.penaltiesMissed,
        yellowCards: raw.yellowCards,
        redCards: raw.redCard ? 1 : 0,
        ownGoals: raw.ownGoals,
      },
      enginePosition,
    );

    await deps.upsertPlayerMatchScore({
      fixtureId: fixture.id,
      playerId: playerRow.id,
      points,
      preserveOverride: true,
      updatedAt: now,
    });
  }
}

// ─── Resolve a settled round ──────────────────────────────────────────────────

async function resolveRound(round: RoundRow, now: Date, deps: SweepDeps): Promise<void> {
  await recomputeAllNationStatus();
  await deps.setEliminatedAtRound(round.fantasyRound, now);

  await resolveMatchups(round.leagueId, round.fantasyRoundId);
  await computeStandings(round.leagueId);
  await resolveBracket(round.leagueId);

  await deps.setStatsIngestedAt(round.fantasyRoundId, now);

  // Schedule waiver processing event — final has no waiver round
  if (round.fantasyRound !== "final") {
    const scheduledAt = nextDayAt13UTC(now);
    await deps.insertWaiverProcessingEvent({
      leagueId: round.leagueId,
      fantasyRoundId: round.fantasyRoundId,
      scheduledAt,
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextDayAt13UTC(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 13, 0, 0, 0),
  );
}
