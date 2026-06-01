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

function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
  };
  for (const m of ["from", "where", "innerJoin"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
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

function makeMatchup(
  overrides: Partial<{
    id: string;
    homeManagerId: string | null;
    awayManagerId: string | null;
    awaySeedSource: string | null;
  }> = {},
) {
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

function makeLineup(
  managerId: string,
  captainPlayerId: string | null = PLAYER_GK,
  vcPlayerId: string | null = PLAYER_DEF,
) {
  const starters = [
    { playerId: PLAYER_GK, playerName: "GK", fantasyPosition: "GK" as const, slotType: "starter" as const, lockedAt: null },
    { playerId: PLAYER_DEF, playerName: "DEF", fantasyPosition: "DEF" as const, slotType: "starter" as const, lockedAt: null },
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
    vcPlayerId,
    captainLockedAt: null,
    vcLockedAt: null,
    slots: starters,
    isFallback: false,
    fallbackRound: null,
  };
}

// player_match_scores row
function makeScoreRow(
  playerId: string,
  points: number,
  overridePoints: number | null = null,
) {
  return {
    id: `score-${playerId}`,
    fixtureId: FIXTURE_ID,
    playerId,
    points: String(points),
    overridePoints: overridePoints !== null ? String(overridePoints) : null,
    overrideReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// player_match_stats row (captain only — we only read minutesPlayed)
function makeCaptainStatsRow(playerId: string, minutesPlayed: number) {
  return {
    id: `stats-${playerId}`,
    fixtureId: FIXTURE_ID,
    playerId,
    minutesPlayed,
    goals: 0,
    assists: 0,
    goalsConceded: 0,
    saves: 0,
    penaltySaved: false,
    penaltyMissed: false,
    yellowCards: 0,
    redCard: false,
    ownGoals: 0,
    cleanSheet: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function allPlayerIds(lineup: ReturnType<typeof makeLineup>) {
  return lineup.slots.filter((s) => s.slotType === "starter").map((s) => s.playerId);
}

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

// Standard mock setup for a round with two managers (each with 11 starters):
// Queries in order:
//   1. matchups
//   2. round name
//   3. players → nationId
//   4. fixtures home  \  (Promise.all)
//   5. fixtures away  /
//   6. player_match_scores  \  (Promise.all)
//   7. captain stats         /
function setupMocks(opts: {
  matchups?: unknown[];
  scoreRows: unknown[];
  captainStatsRows?: unknown[];
  playerIds: string[];
}) {
  mockDb.select
    .mockReturnValueOnce(sel(opts.matchups ?? [makeMatchup()]))
    .mockReturnValueOnce(sel([{ round: ROUND_NAME }]))
    .mockReturnValueOnce(sel(opts.playerIds.map((pid) => ({ id: pid, nationId: NATION_HOME }))))
    .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_HOME, awayNationId: NATION_AWAY }]))
    .mockReturnValueOnce(sel([]))
    .mockReturnValueOnce(sel(opts.scoreRows))
    .mockReturnValueOnce(sel(opts.captainStatsRows ?? []));
}

beforeEach(() => vi.resetAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveMatchups", () => {
  it("captain gets 2x base score from player_match_scores", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, PLAYER_GK);
    const awayLineup = makeLineup(AWAY_MANAGER, PLAYER_GK);
    const playerIds = allPlayerIds(homeLineup);

    // GK base = 10, captain 2x = 20. Others base = 5 each (10 players × 5 = 50). Total = 70.
    const scoreRows = playerIds.map((pid) =>
      makeScoreRow(pid, pid === PLAYER_GK ? 10 : 5),
    );

    setupMocks({
      playerIds,
      scoreRows: [...scoreRows, ...scoreRows], // same for home and away manager
      captainStatsRows: [makeCaptainStatsRow(PLAYER_GK, 90)], // captain played
    });

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
    const update = capturedUpdates[0].set as { homeScore: string; awayScore: string; winnerManagerId: unknown };
    // Both lineups identical → draw
    expect(parseFloat(update.homeScore)).toBe(70); // 20 (capt 2x) + 50 (10×5)
    expect(parseFloat(update.awayScore)).toBe(70);
    expect(update.winnerManagerId).toBeNull();
  });

  it("draw: equal scores → winnerManagerId = null", async () => {
    const lineup = makeLineup(HOME_MANAGER, null); // no captain, no multiplier
    const playerIds = allPlayerIds(lineup);
    const scoreRows = playerIds.map((pid) => makeScoreRow(pid, 5));

    setupMocks({ playerIds, scoreRows: [...scoreRows] });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MANAGER, null))
      .mockResolvedValueOnce(makeLineup(AWAY_MANAGER, null));

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    const update = capturedUpdates[0].set as { winnerManagerId: unknown };
    expect(update.winnerManagerId).toBeNull();
  });

  it("missing score row: player with no player_match_scores row contributes 0", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, null);
    const awayLineup = makeLineup(AWAY_MANAGER, null);
    const playerIds = allPlayerIds(homeLineup);

    // Only seed scores for half the players; missing ones default to 0
    const scoreRows = playerIds.slice(0, 5).map((pid) => makeScoreRow(pid, 10));

    setupMocks({ playerIds, scoreRows });
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

    // Only 5 of 11 players have scores → 5 × 10 = 50
    const update = capturedUpdates[0].set as { homeScore: string };
    expect(parseFloat(update.homeScore)).toBe(50);
  });

  it("BYE row skipped: matchup with awaySeedSource='BYE' is not scored", async () => {
    const byeMatchup = makeMatchup({ id: "bye-1", awaySeedSource: "BYE" });
    const normalMatchup = makeMatchup({ id: "normal-1", matchIndex: 2 });
    const playerIds = allPlayerIds(makeLineup(HOME_MANAGER));
    const scoreRows = playerIds.map((pid) => makeScoreRow(pid, 5));

    setupMocks({ matchups: [byeMatchup, normalMatchup], playerIds, scoreRows });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MANAGER, null))
      .mockResolvedValueOnce(makeLineup(AWAY_MANAGER, null));

    let updateCount = 0;
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              updateCount++;
              return Promise.resolve([]);
            }),
          }),
        }),
      };
      await fn(tx);
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    // Only one write — the normal matchup
    expect(updateCount).toBe(1);
  });

  it("idempotent re-run: second call produces same scores as first", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, null);
    const awayLineup = makeLineup(AWAY_MANAGER, null);
    const playerIds = allPlayerIds(homeLineup);
    const scoreRows = playerIds.map((pid) => makeScoreRow(pid, 3));

    const allUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      allUpdates.push(...tx._updates);
    });

    for (let run = 0; run < 2; run++) {
      setupMocks({ playerIds, scoreRows });
      mockGetLineup
        .mockResolvedValueOnce(homeLineup)
        .mockResolvedValueOnce(awayLineup);
      await resolveMatchups(LEAGUE_ID, ROUND_ID);
    }

    expect(allUpdates).toHaveLength(2);
    const [first, second] = allUpdates.map((u) => u.set as { homeScore: string; awayScore: string });
    expect(first.homeScore).toBe(second.homeScore);
    expect(first.awayScore).toBe(second.awayScore);
  });

  it("override_points replaces base and still gets the 2x captain scaling", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, PLAYER_GK, PLAYER_DEF);
    const playerIds = allPlayerIds(homeLineup);

    // GK has base=10 but override=30; captain 2x applied to override → 60
    // Others: base=5 each (10 players × 5 = 50)
    const scoreRows = playerIds.map((pid) =>
      pid === PLAYER_GK ? makeScoreRow(pid, 10, 30) : makeScoreRow(pid, 5),
    );

    setupMocks({
      playerIds,
      scoreRows,
      captainStatsRows: [makeCaptainStatsRow(PLAYER_GK, 90)], // captain played
    });
    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(makeLineup(AWAY_MANAGER, null)); // away has no captain

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    const update = capturedUpdates[0].set as { homeScore: string; awayScore: string };
    // Home: GK override 30 × 2 = 60, plus 10 others × 5 = 50 → total 110
    expect(parseFloat(update.homeScore)).toBe(110);
    // Away shares same player IDs → PLAYER_GK base is 30 (override), no captain → 30 + 10×5 = 80
    expect(parseFloat(update.awayScore)).toBe(80);
  });

  it("captain played 0 min, VC exists → VC gets 2x (VC promotion)", async () => {
    // PLAYER_GK is captain (0 min), PLAYER_DEF is VC
    const homeLineup = makeLineup(HOME_MANAGER, PLAYER_GK, PLAYER_DEF);
    const playerIds = allPlayerIds(homeLineup);
    const scoreRows = playerIds.map((pid) => makeScoreRow(pid, 10));

    setupMocks({
      playerIds,
      scoreRows,
      captainStatsRows: [makeCaptainStatsRow(PLAYER_GK, 0)], // captain did NOT play
    });
    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(makeLineup(AWAY_MANAGER, null));

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    const update = capturedUpdates[0].set as { homeScore: string };
    // Captain played 0 → VC (PLAYER_DEF) gets 2x: 10 × 2 = 20, rest 10 × 1 = 100 total
    // Total = 20 + 100 = 120? No: 11 players, 1 VC gets 2x (20), 10 others get 1x (10 each = 100)
    // = 20 + 10×10 = 20 + 100 = 120
    expect(parseFloat(update.homeScore)).toBe(120);
  });

  it("captain played 0 min, no VC → no 2x for anyone", async () => {
    const homeLineup = makeLineup(HOME_MANAGER, PLAYER_GK, null); // no VC
    const playerIds = allPlayerIds(homeLineup);
    const scoreRows = playerIds.map((pid) => makeScoreRow(pid, 10));

    setupMocks({
      playerIds,
      scoreRows,
      captainStatsRows: [makeCaptainStatsRow(PLAYER_GK, 0)], // captain did NOT play
    });
    mockGetLineup
      .mockResolvedValueOnce(homeLineup)
      .mockResolvedValueOnce(makeLineup(AWAY_MANAGER, null));

    let capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates = tx._updates;
    });

    await resolveMatchups(LEAGUE_ID, ROUND_ID);

    const update = capturedUpdates[0].set as { homeScore: string };
    // No 2x: 11 × 10 = 110
    expect(parseFloat(update.homeScore)).toBe(110);
  });
});
