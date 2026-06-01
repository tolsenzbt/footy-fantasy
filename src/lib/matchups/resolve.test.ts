import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockDb, mockGetLineup } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
  mockGetLineup: vi.fn(),
}));

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/lineup/read", () => ({ getLineup: mockGetLineup }));

// Fluent select-chain mock
function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
    orderBy: vi.fn(),
  };
  for (const m of ["from", "where", "innerJoin", "orderBy"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

// Fluent update-chain mock — captures set values
function makeUpdateMock() {
  const calls: Array<{ set: unknown }> = [];
  const mock = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((setVals: unknown) => {
        calls.push({ set: setVals });
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }),
    _calls: calls,
  };
  return mock;
}

import { resolveMatchups } from "./resolve";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAGUE_ID = "league-uuid";
const ROUND_ID = "round-uuid";
const ROUND_NAME = "group_md1";

const HOME_MANAGER = "home-mgr";
const AWAY_MANAGER = "away-mgr";
const MATCHUP_ID = "matchup-1";
const PLAYER_GK = "player-gk";
const PLAYER_DEF = "player-def";
const NATION_HOME = "nation-home";
const NATION_AWAY = "nation-away";
const FIXTURE_ID = "fixture-1";

function makeMatchup(overrides: Partial<{
  id: string;
  homeManagerId: string | null;
  awayManagerId: string | null;
  awaySeedSource: string | null;
}> = {}) {
  return {
    id: MATCHUP_ID,
    leagueId: LEAGUE_ID,
    fantasyRoundId: ROUND_ID,
    homeManagerId: HOME_MANAGER,
    awayManagerId: AWAY_MANAGER,
    awaySeedSource: null,
    homeSeedSource: null,
    homeScore: null,
    awayScore: null,
    winnerManagerId: null,
    matchIndex: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// A minimal 11-player lineup for a manager
function makeLineup(managerId: string, captainPlayerId: string | null = PLAYER_GK) {
  const starters = [
    { playerId: PLAYER_GK, playerName: "GK Player", fantasyPosition: "GK" as const, slotType: "starter" as const, lockedAt: null },
    { playerId: PLAYER_DEF, playerName: "DEF Player", fantasyPosition: "DEF" as const, slotType: "starter" as const, lockedAt: null },
    ...Array.from({ length: 9 }, (_, i) => ({
      playerId: `player-mid-${i}`,
      playerName: `MID ${i}`,
      fantasyPosition: "MID" as const,
      slotType: "starter" as const,
      lockedAt: null,
    })),
  ];
  return {
    lineupId: `lineup-${managerId}`,
    leagueId: LEAGUE_ID,
    managerId,
    fantasyRoundId: ROUND_ID,
    round: ROUND_NAME,
    formation: "4-4-2",
    captainPlayerId,
    vcPlayerId: PLAYER_DEF,
    captainLockedAt: null,
    vcLockedAt: null,
    slots: starters,
    isFallback: false,
    fallbackRound: null,
  };
}

function makeStatsRow(playerId: string, goals = 0, minutesPlayed = 90) {
  return {
    id: `stats-${playerId}`,
    fixtureId: FIXTURE_ID,
    playerId,
    minutesPlayed,
    goals,
    assists: 0,
    cleanSheet: false,
    saves: 0,
    penaltySaved: false,
    penaltyMissed: false,
    goalsConceded: 0,
    yellowCards: 0,
    redCard: false,
    ownGoals: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Build all player rows needed for a lineup
function allPlayerIds(lineup: ReturnType<typeof makeLineup>) {
  return lineup.slots.filter((s) => s.slotType === "starter").map((s) => s.playerId);
}

// ── Transaction mock factory ───────────────────────────────────────────────────

function makeTxMock() {
  const updates: Array<{ set: unknown }> = [];
  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((setVals: unknown) => {
        updates.push({ set: setVals });
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }),
    _updates: updates,
  };
  return tx;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveMatchups", () => {
  it("normal scoring: captain scored 2x, correct total", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, PLAYER_GK);
    const awayLineup = makeLineup(AWAY_MANAGER, PLAYER_GK);

    const playerIds = allPlayerIds(homeLineup);

    // Stats: GK scored 2 goals (10 pts/goal for GK), 90 min = 2 pts appearance
    // Captain GK: base = 2 + 20 = 22 pts, 2x = 44
    // DEF: 90 min = 2 pts + clean sheet 4 pts = 6 pts
    // 9 MIDs: 90 min each = 2 pts each = 18 pts
    // Total home = 44 + 6 + 18 = 68

    const statsRows = playerIds.map((pid) =>
      pid === PLAYER_GK
        ? makeStatsRow(pid, 2) // 2 goals
        : makeStatsRow(pid, 0), // rest 0 goals
    );

    mockDb.select
      // matchups
      .mockReturnValueOnce(sel([makeMatchup()]))
      // round name
      .mockReturnValueOnce(sel([{ round: ROUND_NAME }]))
      // players → nationId
      .mockReturnValueOnce(sel(playerIds.map((pid) => ({ id: pid, nationId: NATION_HOME }))))
      // fixtures home
      .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_HOME, awayNationId: NATION_AWAY }]))
      // fixtures away
      .mockReturnValueOnce(sel([]))
      // stats
      .mockReturnValueOnce(sel([...statsRows, ...statsRows])) // same for both managers
      // scores
      .mockReturnValueOnce(sel([]));

    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(awayLineup);

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    expect(capturedUpdates).toHaveLength(1);
    const update = capturedUpdates[0].set as { homeScore: string; awayScore: string; winnerManagerId: string };
    const homeScore = parseFloat(update.homeScore);
    const awayScore = parseFloat(update.awayScore);
    // Both lineups identical → same score → draw
    expect(homeScore).toBe(awayScore);
    expect(update.winnerManagerId).toBeNull();
    // base GK: 2 (90min) + 20 (2 goals×10 for GK) + 4 (clean sheet, 0 conceded) = 26, ×2 captain = 52
    // DEF: 2 (90min) + 4 (clean sheet) = 6
    // 9 MIDs: 2 (90min) + 1 (MID clean-sheet bonus, CLEAN_SHEET_PTS.MID=1) = 3 each = 27
    expect(homeScore).toBe(85); // 52 + 6 + 27 = 85
  });

  it("draw: both managers produce same score → winnerManagerId = null", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, null); // no captain
    const awayLineup = makeLineup(AWAY_MANAGER, null);

    const playerIds = allPlayerIds(homeLineup);
    const statsRows = playerIds.map((pid) => makeStatsRow(pid, 0));

    mockDb.select
      .mockReturnValueOnce(sel([makeMatchup()]))
      .mockReturnValueOnce(sel([{ round: ROUND_NAME }]))
      .mockReturnValueOnce(sel(playerIds.map((pid) => ({ id: pid, nationId: NATION_HOME }))))
      .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_HOME, awayNationId: NATION_AWAY }]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel([...statsRows]))
      .mockReturnValueOnce(sel([]));

    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(awayLineup);

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    const update = capturedUpdates[0].set as { homeScore: string; awayScore: string; winnerManagerId: unknown };
    expect(parseFloat(update.homeScore)).toBe(parseFloat(update.awayScore));
    expect(update.winnerManagerId).toBeNull();
  });

  it("missing stats row: player with no player_match_stats row scores 0 points", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, null);
    const awayLineup = makeLineup(AWAY_MANAGER, null);

    const playerIds = allPlayerIds(homeLineup);
    // No stats rows at all
    mockDb.select
      .mockReturnValueOnce(sel([makeMatchup()]))
      .mockReturnValueOnce(sel([{ round: ROUND_NAME }]))
      .mockReturnValueOnce(sel(playerIds.map((pid) => ({ id: pid, nationId: NATION_HOME }))))
      .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_HOME, awayNationId: NATION_AWAY }]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel([])) // empty stats
      .mockReturnValueOnce(sel([])); // empty scores

    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(awayLineup);

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    const update = capturedUpdates[0].set as { homeScore: string; awayScore: string };
    expect(parseFloat(update.homeScore)).toBe(0);
    expect(parseFloat(update.awayScore)).toBe(0);
  });

  it("BYE row skipped: matchup with awaySeedSource='BYE' is not processed", async () => {
    const byeMatchup = makeMatchup({ awaySeedSource: "BYE" });
    const normalMatchup = makeMatchup({ id: "matchup-2", matchIndex: 2 });

    const homeLineup = makeLineup(HOME_MANAGER, null);
    const playerIds = allPlayerIds(homeLineup);
    const statsRows = playerIds.map((pid) => makeStatsRow(pid, 0));

    mockDb.select
      .mockReturnValueOnce(sel([byeMatchup, normalMatchup]))
      .mockReturnValueOnce(sel([{ round: ROUND_NAME }]))
      .mockReturnValueOnce(sel(playerIds.map((pid) => ({ id: pid, nationId: NATION_HOME }))))
      .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_HOME, awayNationId: NATION_AWAY }]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel(statsRows))
      .mockReturnValueOnce(sel([]));

    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(makeLineup(AWAY_MANAGER, null));

    let capturedUpdates: Array<{ set: unknown; where?: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((setVals: unknown) => {
            const whereCapture = vi.fn().mockResolvedValue([]);
            capturedUpdates.push({ set: setVals });
            return { where: whereCapture };
          }),
        }),
        _updates: capturedUpdates,
      };
      await fn(tx);
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    // Only the normal matchup should be updated (not the BYE matchup)
    expect(capturedUpdates).toHaveLength(1);
  });

  it("idempotent re-run: running twice overwrites first result correctly", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, null);
    const awayLineup = makeLineup(AWAY_MANAGER, null);
    const playerIds = allPlayerIds(homeLineup);
    const statsRows = playerIds.map((pid) => makeStatsRow(pid, 0));

    const setupMocks = () => {
      mockDb.select
        .mockReturnValueOnce(sel([makeMatchup()]))
        .mockReturnValueOnce(sel([{ round: ROUND_NAME }]))
        .mockReturnValueOnce(sel(playerIds.map((pid) => ({ id: pid, nationId: NATION_HOME }))))
        .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_HOME, awayNationId: NATION_AWAY }]))
        .mockReturnValueOnce(sel([]))
        .mockReturnValueOnce(sel(statsRows))
        .mockReturnValueOnce(sel([]));

      mockGetLineup
        .mockResolvedValueOnce(homeLineup)
        .mockResolvedValueOnce(awayLineup);
    };

    const allUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      allUpdates.push(...tx._updates);
    });

    setupMocks();
    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    setupMocks();
    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    // Both runs should have produced an update
    expect(allUpdates).toHaveLength(2);
    // Both results should be equal (same scores)
    const [first, second] = allUpdates.map((u) => u.set as { homeScore: string; awayScore: string });
    expect(first.homeScore).toBe(second.homeScore);
    expect(first.awayScore).toBe(second.awayScore);
  });
});
