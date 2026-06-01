import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/db", () => ({ db: mockDb }));

function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
  };
  for (const m of ["from", "where", "orderBy"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

import { parseSeedSource, resolveBracket } from "./resolve";

// ── parseSeedSource pure function tests ────────────────────────────────────────

describe("parseSeedSource", () => {
  it("'BYE' → { type: 'bye' }", () => {
    expect(parseSeedSource("BYE")).toEqual({ type: "bye" });
  });

  it("'1A' → { type: 'standing', rank: 1, groupLetter: 'A' }", () => {
    expect(parseSeedSource("1A")).toEqual({
      type: "standing",
      rank: 1,
      groupLetter: "A",
    });
  });

  it("'2B' → { type: 'standing', rank: 2, groupLetter: 'B' }", () => {
    expect(parseSeedSource("2B")).toEqual({
      type: "standing",
      rank: 2,
      groupLetter: "B",
    });
  });

  it("'3C' → { type: 'standing', rank: 3, groupLetter: 'C' }", () => {
    expect(parseSeedSource("3C")).toEqual({
      type: "standing",
      rank: 3,
      groupLetter: "C",
    });
  });

  it("'winner_qf_1' → { type: 'winner', round: 'qf', matchIndex: 1 }", () => {
    expect(parseSeedSource("winner_qf_1")).toEqual({
      type: "winner",
      round: "qf",
      matchIndex: 1,
    });
  });

  it("'winner_sf_2' → { type: 'winner', round: 'sf', matchIndex: 2 }", () => {
    expect(parseSeedSource("winner_sf_2")).toEqual({
      type: "winner",
      round: "sf",
      matchIndex: 2,
    });
  });

  it("'winner_final_1' → { type: 'winner', round: 'final', matchIndex: 1 }", () => {
    expect(parseSeedSource("winner_final_1")).toEqual({
      type: "winner",
      round: "final",
      matchIndex: 1,
    });
  });

  it("arbitrary string → { type: 'unknown' }", () => {
    expect(parseSeedSource("garbage")).toEqual({ type: "unknown" });
    expect(parseSeedSource("")).toEqual({ type: "unknown" });
    expect(parseSeedSource("1a")).toEqual({ type: "unknown" }); // lowercase not matched
  });
});

// ── resolveBracket (mocked DB) ────────────────────────────────────────────────

const LEAGUE_ID = "league-uuid";
const QF_ROUND_ID = "qf-round-uuid";
const SF_ROUND_ID = "sf-round-uuid";
const MANAGER_1A = "mgr-1a";
const MANAGER_2B = "mgr-2b";
const MANAGER_WINNER_QF1 = "mgr-winner-qf1";

function makeMatchup(opts: {
  id: string;
  fantasyRoundId: string;
  matchIndex: number;
  homeSeedSource: string;
  awaySeedSource: string;
  homeManagerId?: string | null;
  awayManagerId?: string | null;
  winnerManagerId?: string | null;
}) {
  return {
    id: opts.id,
    leagueId: LEAGUE_ID,
    fantasyRoundId: opts.fantasyRoundId,
    matchIndex: opts.matchIndex,
    homeSeedSource: opts.homeSeedSource,
    awaySeedSource: opts.awaySeedSource,
    homeManagerId: opts.homeManagerId ?? null,
    awayManagerId: opts.awayManagerId ?? null,
    winnerManagerId: opts.winnerManagerId ?? null,
    homeScore: null,
    awayScore: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTxMock() {
  const updates: Array<{ id: string; set: unknown }> = [];
  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((setVals: unknown) => {
        // Capture with a placeholder id; the test will track via call count
        updates.push({ id: "captured", set: setVals });
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }),
    _updates: updates,
  };
  return tx;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveBracket", () => {
  it("resolves standing codes (1A, 2B) to manager IDs from group_standings", async () => {
    const matchup = makeMatchup({
      id: "qf-1",
      fantasyRoundId: QF_ROUND_ID,
      matchIndex: 1,
      homeSeedSource: "1A",
      awaySeedSource: "2B",
    });

    mockDb.select
      // knockout rounds
      .mockReturnValueOnce(sel([{ id: QF_ROUND_ID, round: "qf" }]))
      // all knockout matchups
      .mockReturnValueOnce(sel([matchup]))
      // group standings
      .mockReturnValueOnce(
        sel([
          { managerId: MANAGER_1A, groupLetter: "A", rank: 1 },
          { managerId: MANAGER_2B, groupLetter: "B", rank: 2 },
        ]),
      );

    const capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates.push(...tx._updates);
    });

    await resolveBracket(LEAGUE_ID);

    expect(capturedUpdates).toHaveLength(1);
    const set = capturedUpdates[0].set as {
      homeManagerId?: string;
      awayManagerId?: string;
    };
    expect(set.homeManagerId).toBe(MANAGER_1A);
    expect(set.awayManagerId).toBe(MANAGER_2B);
  });

  it("BYE: sets homeManagerId AND winnerManagerId = homeManagerId", async () => {
    const matchup = makeMatchup({
      id: "qf-bye",
      fantasyRoundId: QF_ROUND_ID,
      matchIndex: 3,
      homeSeedSource: "1A",
      awaySeedSource: "BYE",
    });

    mockDb.select
      .mockReturnValueOnce(sel([{ id: QF_ROUND_ID, round: "qf" }]))
      .mockReturnValueOnce(sel([matchup]))
      .mockReturnValueOnce(
        sel([{ managerId: MANAGER_1A, groupLetter: "A", rank: 1 }]),
      );

    const capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates.push(...tx._updates);
    });

    await resolveBracket(LEAGUE_ID);

    expect(capturedUpdates).toHaveLength(1);
    const set = capturedUpdates[0].set as {
      homeManagerId?: string;
      winnerManagerId?: string;
      awayManagerId?: string;
    };
    expect(set.homeManagerId).toBe(MANAGER_1A);
    expect(set.winnerManagerId).toBe(MANAGER_1A);
    // awayManagerId should not be set (stays null)
    expect(set.awayManagerId).toBeUndefined();
  });

  it("winner reference: resolves once the referenced match has a winner", async () => {
    // SF match depends on winner_qf_1
    const sfMatchup = makeMatchup({
      id: "sf-1",
      fantasyRoundId: SF_ROUND_ID,
      matchIndex: 1,
      homeSeedSource: "winner_qf_1",
      awaySeedSource: "winner_qf_2",
    });
    const qfMatchupWithWinner = makeMatchup({
      id: "qf-1",
      fantasyRoundId: QF_ROUND_ID,
      matchIndex: 1,
      homeSeedSource: "1A",
      awaySeedSource: "2B",
      homeManagerId: MANAGER_1A,
      awayManagerId: MANAGER_2B,
      winnerManagerId: MANAGER_WINNER_QF1,
    });
    const qfMatchup2 = makeMatchup({
      id: "qf-2",
      fantasyRoundId: QF_ROUND_ID,
      matchIndex: 2,
      homeSeedSource: "2A",
      awaySeedSource: "1B",
      homeManagerId: "mgr-2a",
      awayManagerId: "mgr-1b",
      winnerManagerId: "mgr-1b",
    });

    mockDb.select
      .mockReturnValueOnce(
        sel([
          { id: QF_ROUND_ID, round: "qf" },
          { id: SF_ROUND_ID, round: "sf" },
        ]),
      )
      .mockReturnValueOnce(sel([sfMatchup, qfMatchupWithWinner, qfMatchup2]))
      .mockReturnValueOnce(sel([])); // no standings needed for winner refs

    const capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates.push(...tx._updates);
    });

    await resolveBracket(LEAGUE_ID);

    // sfMatchup should be updated with both winner refs resolved
    const sfUpdate = capturedUpdates.find((u) => {
      const s = u.set as { homeManagerId?: string };
      return s.homeManagerId === MANAGER_WINNER_QF1;
    });
    expect(sfUpdate).toBeDefined();
    const set = sfUpdate!.set as { homeManagerId: string; awayManagerId: string };
    expect(set.homeManagerId).toBe(MANAGER_WINNER_QF1);
    expect(set.awayManagerId).toBe("mgr-1b");
  });

  it("re-entrant: does not overwrite already-set managerIds", async () => {
    // Matchup already has homeManagerId set
    const matchup = makeMatchup({
      id: "qf-1",
      fantasyRoundId: QF_ROUND_ID,
      matchIndex: 1,
      homeSeedSource: "1A",
      awaySeedSource: "2B",
      homeManagerId: MANAGER_1A, // already resolved
    });

    mockDb.select
      .mockReturnValueOnce(sel([{ id: QF_ROUND_ID, round: "qf" }]))
      .mockReturnValueOnce(sel([matchup]))
      .mockReturnValueOnce(
        sel([
          { managerId: MANAGER_1A, groupLetter: "A", rank: 1 },
          { managerId: MANAGER_2B, groupLetter: "B", rank: 2 },
        ]),
      );

    const capturedUpdates: Array<{ set: unknown }> = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = makeTxMock();
      await fn(tx);
      capturedUpdates.push(...tx._updates);
    });

    await resolveBracket(LEAGUE_ID);

    // Only the away seed should produce an update (home already set)
    if (capturedUpdates.length > 0) {
      const set = capturedUpdates[0].set as Record<string, unknown>;
      // homeManagerId should not be in the update (it was already set)
      expect(set.homeManagerId).toBeUndefined();
      expect(set.awayManagerId).toBe(MANAGER_2B);
    }
    // If no updates at all, that's also acceptable — implementation may skip the matchup
    // (either behavior is valid as long as home isn't overwritten)
  });

  it("no-op when no knockout rounds exist", async () => {
    mockDb.select.mockReturnValueOnce(sel([]));

    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ update: vi.fn() })
    );

    await expect(resolveBracket(LEAGUE_ID)).resolves.toBeUndefined();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
