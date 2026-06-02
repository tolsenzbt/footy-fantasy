import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockDb, mockGetLineup } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
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

import { getMatchupsForRound } from "./read";
import { scoreLineupBases } from "./score";

const LEAGUE_ID = "league-uuid";
const ROUND_ID = "round-uuid";
const FIXTURE_ID = "fixture-1";
const HOME_MGR = "home-mgr";
const AWAY_MGR = "away-mgr";
const PLAYER_GK = "player-gk";
const PLAYER_DEF = "player-def";
const NATION_ID = "nation-1";

function makeMatchup(overrides: Partial<{
  homeScore: string | null;
  awayScore: string | null;
  winnerManagerId: string | null;
  awaySeedSource: string | null;
}> = {}) {
  return {
    id: "matchup-1",
    leagueId: LEAGUE_ID,
    fantasyRoundId: ROUND_ID,
    homeManagerId: HOME_MGR,
    awayManagerId: AWAY_MGR,
    homeSeedSource: null,
    awaySeedSource: null,
    homeScore: null,
    awayScore: null,
    winnerManagerId: null,
    matchIndex: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeLineup(managerId: string, captainId: string | null = PLAYER_GK) {
  const mids = Array.from({ length: 9 }, (_, i) => ({
    playerId: `mid-${i}`,
    playerName: `MID${i}`,
    fantasyPosition: "MID" as const,
    slotType: "starter" as const,
    lockedAt: null,
  }));
  return {
    lineupId: `l-${managerId}`,
    leagueId: LEAGUE_ID,
    managerId,
    fantasyRoundId: ROUND_ID,
    round: "group_md1",
    formation: "4-4-2",
    captainPlayerId: captainId,
    vcPlayerId: PLAYER_DEF,
    captainLockedAt: null,
    vcLockedAt: null,
    isFallback: false,
    fallbackRound: null,
    slots: [
      { playerId: PLAYER_GK, playerName: "GK", fantasyPosition: "GK" as const, slotType: "starter" as const, lockedAt: null },
      { playerId: PLAYER_DEF, playerName: "DEF", fantasyPosition: "DEF" as const, slotType: "starter" as const, lockedAt: null },
      ...mids,
    ],
  };
}

// Mock call sequence (7 total) for a round with 2 managers:
// 1. matchups  2. round name  3. players+nations  4+5. fixtures (Promise.all)  6+7. scores+captainStats (Promise.all)
function setupMocks(opts: {
  matchups?: unknown[];
  scoreRows?: unknown[];
  captainStatsRows?: unknown[];
  isLive?: boolean;  // controls whether homeScore is null (live) or set (finalized)
}) {
  const matchup = makeMatchup(
    opts.isLive === false ? { homeScore: "60.00", awayScore: "50.00", winnerManagerId: HOME_MGR } : {}
  );
  const allPlayerIds = [PLAYER_GK, PLAYER_DEF, ...Array.from({ length: 9 }, (_, i) => `mid-${i}`)];

  mockDb.select
    .mockReturnValueOnce(sel(opts.matchups ?? [matchup]))
    .mockReturnValueOnce(sel([{ round: "group_md1" }]))
    .mockReturnValueOnce(sel(allPlayerIds.map((pid) => ({
      playerId: pid,
      nationId: NATION_ID,
      eliminatedAtRound: null,
      nextFixtureId: null,
    }))))
    .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_ID, awayNationId: "away-nation" }]))
    .mockReturnValueOnce(sel([]))  // fixtures away
    .mockReturnValueOnce(sel(opts.scoreRows ?? allPlayerIds.map((pid) => ({
      playerId: pid,
      fixtureId: FIXTURE_ID,
      points: "5",
      overridePoints: null,
    }))))
    .mockReturnValueOnce(sel(opts.captainStatsRows ?? [{ playerId: PLAYER_GK, fixtureId: FIXTURE_ID, minutesPlayed: 90 }]));
}

beforeEach(() => vi.resetAllMocks());

describe("getMatchupsForRound", () => {
  it("live round: computes scores from player_match_scores, isLive=true", async () => {
    setupMocks({ isLive: true });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MGR))
      .mockResolvedValueOnce(makeLineup(AWAY_MGR));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);

    expect(result).toHaveLength(1);
    expect(result[0].isLive).toBe(true);
    // home_score not yet stored for live rounds
    expect(result[0].homeScore).toBeNull();
    // computed total should be non-null
    expect(result[0].home!.total).toBeGreaterThan(0);
  });

  it("live round: computed total matches scoreLineupBases with same inputs", async () => {
    // GK base=10 (captain, will get 2x), others base=5 each
    const allPlayerIds = [PLAYER_GK, PLAYER_DEF, ...Array.from({ length: 9 }, (_, i) => `mid-${i}`)];
    const scoreRows = allPlayerIds.map((pid) => ({
      playerId: pid,
      fixtureId: FIXTURE_ID,
      points: pid === PLAYER_GK ? "10" : "5",
      overridePoints: null,
    }));

    setupMocks({
      isLive: true,
      scoreRows,
      captainStatsRows: [{ playerId: PLAYER_GK, fixtureId: FIXTURE_ID, minutesPlayed: 90 }],
    });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MGR, PLAYER_GK))
      .mockResolvedValueOnce(makeLineup(AWAY_MGR, PLAYER_GK));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);

    // Compute expected total using the shared helper directly
    const basesMap = new Map(allPlayerIds.map((pid) => [pid, pid === PLAYER_GK ? 10 : 5] as [string, number]));
    const expected = scoreLineupBases(
      allPlayerIds.map((id) => ({ playerId: id })),
      basesMap,
      PLAYER_GK,
      PLAYER_DEF,
      90,
    ).total;

    expect(result[0].home!.total).toBe(expected);  // 20 + 10×5 = 70
    expect(result[0].away!.total).toBe(expected);   // identical lineup
  });

  it("live round: per-player detail includes correct basePoints, multiplier, finalPoints", async () => {
    const allPlayerIds = [PLAYER_GK, PLAYER_DEF, ...Array.from({ length: 9 }, (_, i) => `mid-${i}`)];
    const scoreRows = allPlayerIds.map((pid) => ({
      playerId: pid, fixtureId: FIXTURE_ID, points: "10", overridePoints: null,
    }));

    setupMocks({ isLive: true, scoreRows });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MGR, PLAYER_GK))
      .mockResolvedValueOnce(makeLineup(AWAY_MGR));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);
    const gkDetail = result[0].home!.players.find((p) => p.playerId === PLAYER_GK)!;

    expect(gkDetail.basePoints).toBe(10);
    expect(gkDetail.multiplier).toBe(2);     // captain played (90 min)
    expect(gkDetail.finalPoints).toBe(20);
    expect(gkDetail.isCaptain).toBe(true);
  });

  it("finalized round: returns stored homeScore/awayScore, isLive=false", async () => {
    setupMocks({ isLive: false });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MGR))
      .mockResolvedValueOnce(makeLineup(AWAY_MGR));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);

    expect(result[0].isLive).toBe(false);
    expect(result[0].homeScore).toBe("60.00");
    expect(result[0].awayScore).toBe("50.00");
    expect(result[0].winnerManagerId).toBe(HOME_MGR);
  });

  it("finalized round: returns STORED total even when player_match_scores would compute differently", async () => {
    // Stored scores: home=60.00, away=50.00 (written by resolveMatchups)
    // Current player_match_scores: all players score 5 pts → computed home total = 55 (11×5, no cap)
    // Reader must return 60 for home, 50 for away — NOT the 55 recomputed value
    setupMocks({
      isLive: false,  // sets homeScore="60.00", awayScore="50.00"
      scoreRows: [PLAYER_GK, PLAYER_DEF, ...Array.from({ length: 9 }, (_, i) => `mid-${i}`)].map((pid) => ({
        playerId: pid, fixtureId: FIXTURE_ID, points: "5", overridePoints: null,
      })),
      captainStatsRows: [],  // captain didn't play → no 2x; computed total = 11×5 = 55 ≠ 60
    });
    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MGR, null))  // no captain → 55 computed
      .mockResolvedValueOnce(makeLineup(AWAY_MGR, null));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);

    // Stored total wins
    expect(result[0].home!.total).toBe(60);
    expect(result[0].away!.total).toBe(50);
    // But per-player breakdown is still present (computed from current scores)
    expect(result[0].home!.players).toHaveLength(11);
    expect(result[0].isLive).toBe(false);
  });

  it("BYE matchup: away = null, awaySeedSource = 'BYE'", async () => {
    const byeMatchup = makeMatchup({ awaySeedSource: "BYE" });
    const allPlayerIds = [PLAYER_GK, PLAYER_DEF, ...Array.from({ length: 9 }, (_, i) => `mid-${i}`)];
    const scoreRows = allPlayerIds.map((pid) => ({
      playerId: pid, fixtureId: FIXTURE_ID, points: "5", overridePoints: null,
    }));

    mockDb.select
      .mockReturnValueOnce(sel([byeMatchup]))
      .mockReturnValueOnce(sel([{ round: "qf" }]))
      .mockReturnValueOnce(sel(allPlayerIds.map((pid) => ({ playerId: pid, nationId: NATION_ID, eliminatedAtRound: null, nextFixtureId: null }))))
      .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_ID, awayNationId: "away-nation" }]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel(scoreRows))
      .mockReturnValueOnce(sel([{ playerId: PLAYER_GK, fixtureId: FIXTURE_ID, minutesPlayed: 90 }]));

    mockGetLineup.mockResolvedValueOnce(makeLineup(HOME_MGR));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);

    expect(result[0].away).toBeNull();
    expect(result[0].awaySeedSource).toBe("BYE");
    expect(result[0].home).not.toBeNull();
  });

  it("nation status included in per-player details", async () => {
    const allPlayerIds = [PLAYER_GK, PLAYER_DEF, ...Array.from({ length: 9 }, (_, i) => `mid-${i}`)];
    const scoreRows = allPlayerIds.map((pid) => ({
      playerId: pid, fixtureId: FIXTURE_ID, points: "5", overridePoints: null,
    }));

    const ELIM_ROUND = "group_md3";
    const NEXT_FIX = "next-fixture-uuid";

    mockDb.select
      .mockReturnValueOnce(sel([makeMatchup()]))
      .mockReturnValueOnce(sel([{ round: "group_md1" }]))
      .mockReturnValueOnce(sel(allPlayerIds.map((pid, i) => ({
        playerId: pid,
        nationId: NATION_ID,
        eliminatedAtRound: i === 0 ? ELIM_ROUND : null,   // GK's nation is eliminated
        nextFixtureId: i === 1 ? NEXT_FIX : null,         // DEF's nation has next fixture
      }))))
      .mockReturnValueOnce(sel([{ fixtureId: FIXTURE_ID, homeNationId: NATION_ID, awayNationId: "away-nation" }]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel(scoreRows))
      .mockReturnValueOnce(sel([{ playerId: PLAYER_GK, fixtureId: FIXTURE_ID, minutesPlayed: 90 }]));

    mockGetLineup
      .mockResolvedValueOnce(makeLineup(HOME_MGR))
      .mockResolvedValueOnce(makeLineup(AWAY_MGR));

    const result = await getMatchupsForRound(LEAGUE_ID, ROUND_ID);
    const gkDetail = result[0].home!.players.find((p) => p.playerId === PLAYER_GK)!;
    const defDetail = result[0].home!.players.find((p) => p.playerId === PLAYER_DEF)!;

    expect(gkDetail.nationEliminatedAtRound).toBe(ELIM_ROUND);
    expect(defDetail.nationNextFixtureId).toBe(NEXT_FIX);
  });
});
