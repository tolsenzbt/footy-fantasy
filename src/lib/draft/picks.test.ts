import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

// vi.mock factories are hoisted before variable declarations, so we must define
// shared mock objects with vi.hoisted() to make them available in factories.
const { mockDb, mockGetDraftState, mockRunGroupDraw } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
  mockGetDraftState: vi.fn(),
  mockRunGroupDraw: vi.fn(),
}));

const { mockSubmitRedraftPick } = vi.hoisted(() => ({
  mockSubmitRedraftPick: vi.fn(),
}));

vi.mock("./state", () => ({ getDraftState: mockGetDraftState }));
vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/schedule/group-draw", () => ({ runGroupDraw: mockRunGroupDraw }));
vi.mock("./redraft", () => ({ submitRedraftPick: mockSubmitRedraftPick }));

// Build a fluent Drizzle select-chain mock that resolves `result` at .limit()
// or when awaited directly (for queries without .limit()).
function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
    for: vi.fn(),
    limit: vi.fn().mockReturnValue(terminal),
  };
  for (const m of ["from", "where", "innerJoin", "for"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  // Make awaitable without .limit() for position-count query
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

// Build a minimal tx mock; captures insert/update call args for inspection.
function makeTxMock(lockedDraftRow: unknown = activeDraftBase) {
  const insertMocks: ReturnType<typeof vi.fn>[] = [];
  const updateSetMocks: ReturnType<typeof vi.fn>[] = [];

  const tx = {
    select: vi.fn().mockReturnValue(sel([lockedDraftRow])),
    insert: vi.fn().mockImplementation(() => {
      const valuesFn = vi.fn().mockResolvedValue([]);
      insertMocks.push(valuesFn);
      return { values: valuesFn };
    }),
    update: vi.fn().mockImplementation(() => {
      const whereFn = vi.fn().mockResolvedValue([]);
      const setFn = vi.fn().mockReturnValue({ where: whereFn });
      updateSetMocks.push(setFn);
      return { set: setFn };
    }),
    _insertMocks: insertMocks,
    _updateSetMocks: updateSetMocks,
  };
  return tx;
}

import { submitPick } from "./picks";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAGUE_ID = "league-uuid";
const MANAGER_ID = "manager-uuid";
const PLAYER_ID = "player-uuid";
const DRAFT_ID = "draft-uuid";

const activeDraftBase = {
  id: DRAFT_ID,
  leagueId: LEAGUE_ID,
  type: "initial" as const,
  status: "active" as const,
  currentPickNumber: 1,
  pickClockSeconds: 28800,
  currentPickStartedAt: new Date(Date.now() - 1_000), // 1 second ago, not expired
  startsAt: new Date(Date.now() - 60_000),
  startedAt: new Date(Date.now() - 60_000),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const activeState = {
  draft: activeDraftBase,
  expiresAt: new Date(Date.now() + 28_799_000),
  isExpired: false,
  onTheClockManagerId: MANAGER_ID,
};

const fwdPlayer = {
  id: PLAYER_ID,
  name: "Test Player",
  fantasyPosition: "FWD" as const,
  active: true,
  nationId: "nation-uuid",
  realPosition: "ST",
  apiFootballId: 99999,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Setup a standard happy-path select sequence (4 pre-tx queries).
// Returns the tx mock so callers can inspect inserts/updates.
function setupSelects(opts: {
  player?: unknown;
  rosterExists?: unknown[];
  currentRoster?: unknown[];
  format?: string;
} = {}) {
  mockDb.select
    .mockReturnValueOnce(sel([opts.player ?? fwdPlayer]))
    .mockReturnValueOnce(sel(opts.rosterExists ?? []))
    .mockReturnValueOnce(sel(opts.currentRoster ?? []))
    .mockReturnValueOnce(sel([{ format: opts.format ?? "eight" }]));
}

beforeEach(() => {
  // resetAllMocks clears mockReturnValueOnce/mockImplementationOnce queues too —
  // tests that throw early would otherwise leave stale values for later tests.
  vi.resetAllMocks();
  // Re-establish the default transaction implementation after the reset.
  mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeTxMock())
  );
  // Default: runGroupDraw succeeds silently (only called on final pick).
  mockRunGroupDraw.mockResolvedValue({ slotsAssigned: 8, groupMatchupsCreated: 12, knockoutMatchupsCreated: 7, fantasyRoundsCreated: 6 });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("redraft routing", () => {
  it("delegates draftType=redraft to submitRedraftPick", async () => {
    mockSubmitRedraftPick.mockResolvedValueOnce({ pickNumber: 1, isComplete: false });
    const result = await submitPick({
      leagueId: LEAGUE_ID,
      draftType: "redraft",
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
    });
    expect(mockSubmitRedraftPick).toHaveBeenCalledWith({
      leagueId: LEAGUE_ID,
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
      dropPlayerId: undefined,
    });
    expect(result).toEqual({ pickNumber: 1, isComplete: false });
  });
});

describe("draft-status validation", () => {
  it("throws when draft is pending", async () => {
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      draft: { ...activeDraftBase, status: "pending" },
    });
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("not active");
  });

  it("throws when draft is complete", async () => {
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      draft: { ...activeDraftBase, status: "complete" },
    });
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("not active");
  });
});

describe("on-the-clock validation", () => {
  it("throws if managerId is not on the clock", async () => {
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      onTheClockManagerId: "other-manager",
    });
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("not on the clock");
  });
});

describe("player validation", () => {
  it("throws if player does not exist", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    mockDb.select.mockReturnValueOnce(sel([]));
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("does not exist");
  });

  it("throws if player is inactive", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    mockDb.select.mockReturnValueOnce(sel([{ ...fwdPlayer, active: false }]));
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("inactive");
  });

  it("throws if player is already rostered in this league", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    mockDb.select
      .mockReturnValueOnce(sel([fwdPlayer]))
      .mockReturnValueOnce(sel([{ id: "existing-roster-row" }]));
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("already on a roster");
  });
});

describe("position-max validation", () => {
  it("throws when picking a 3rd GK (max 2)", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    setupSelects({
      player: { ...fwdPlayer, fantasyPosition: "GK", name: "GK3" },
      currentRoster: [{ fantasyPosition: "GK" }, { fantasyPosition: "GK" }],
    });
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("exceeding the maximum of 2");
  });

  it("throws when picking a 6th DEF (max 5)", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    setupSelects({
      player: { ...fwdPlayer, fantasyPosition: "DEF", name: "DEF6" },
      currentRoster: Array(5).fill({ fantasyPosition: "DEF" }),
    });
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("exceeding the maximum of 5");
  });

  it("throws when picking a 4th FWD (max 3)", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    setupSelects({
      currentRoster: Array(3).fill({ fantasyPosition: "FWD" }),
    });
    await expect(
      submitPick({ leagueId: LEAGUE_ID, draftType: "initial", managerId: MANAGER_ID, playerId: PLAYER_ID })
    ).rejects.toThrow("exceeding the maximum of 3");
  });
});

describe("happy path — pick 1 of 112 (8-manager league)", () => {
  it("returns pickNumber=1, isFinalPick=false and advances draft to pick 2", async () => {
    mockGetDraftState.mockResolvedValue(activeState);

    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      capturedTx = makeTxMock();
      return fn(capturedTx);
    });
    setupSelects();

    const result = await submitPick({
      leagueId: LEAGUE_ID,
      draftType: "initial",
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
    });

    expect(result).toEqual({ pickNumber: 1, isFinalPick: false });

    // draft_picks insert
    const pickInsert = capturedTx!._insertMocks[0].mock.calls[0][0];
    expect(pickInsert.pickNumber).toBe(1);
    expect(pickInsert.managerId).toBe(MANAGER_ID);
    expect(pickInsert.playerId).toBe(PLAYER_ID);
    expect(pickInsert.droppedPlayerId).toBeNull();
    expect(pickInsert.clockExpired).toBe(false);

    // rosters insert
    const rosterInsert = capturedTx!._insertMocks[1].mock.calls[0][0];
    expect(rosterInsert.acquiredVia).toBe("initial_draft");

    // drafts update advances to pick 2
    const draftUpdate = capturedTx!._updateSetMocks[0].mock.calls[0][0];
    expect(draftUpdate.currentPickNumber).toBe(2);
    expect(draftUpdate.status).toBeUndefined();

    // leagues is NOT updated on non-final pick
    expect(capturedTx!._updateSetMocks).toHaveLength(1);
  });
});

describe("clockExpired flag", () => {
  it("records clockExpired=true when clock has elapsed, but pick still succeeds", async () => {
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      draft: {
        ...activeDraftBase,
        currentPickStartedAt: new Date(Date.now() - 99_999_000), // way past 8h
      },
    });

    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      capturedTx = makeTxMock();
      return fn(capturedTx);
    });
    setupSelects();

    const result = await submitPick({
      leagueId: LEAGUE_ID,
      draftType: "initial",
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
    });

    expect(result.pickNumber).toBe(1);
    expect(capturedTx!._insertMocks[0].mock.calls[0][0].clockExpired).toBe(true);
  });
});

describe("droppedPlayerId for initial draft", () => {
  it("warns and ignores droppedPlayerId; stores null in DB", async () => {
    mockGetDraftState.mockResolvedValue(activeState);
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      capturedTx = makeTxMock();
      return fn(capturedTx);
    });
    setupSelects();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await submitPick({
      leagueId: LEAGUE_ID,
      draftType: "initial",
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
      droppedPlayerId: "some-player-uuid",
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(capturedTx!._insertMocks[0].mock.calls[0][0].droppedPlayerId).toBeNull();
    warnSpy.mockRestore();
  });
});

describe("final pick", () => {
  it("transitions draft to complete on pick 112 (8-team) and triggers runGroupDraw", async () => {
    const totalPicks = 14 * 8; // 112
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      draft: { ...activeDraftBase, currentPickNumber: totalPicks },
    });

    let capturedTx: ReturnType<typeof makeTxMock>;
    const finalDraft = { ...activeDraftBase, currentPickNumber: totalPicks };
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      capturedTx = makeTxMock(finalDraft);
      return fn(capturedTx);
    });
    setupSelects();

    const result = await submitPick({
      leagueId: LEAGUE_ID,
      draftType: "initial",
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
    });

    expect(result).toEqual({ pickNumber: totalPicks, isFinalPick: true });

    // drafts update: status=complete, picks cleared
    const draftUpdate = capturedTx!._updateSetMocks[0].mock.calls[0][0];
    expect(draftUpdate.status).toBe("complete");
    expect(draftUpdate.currentPickNumber).toBeNull();
    expect(draftUpdate.currentPickStartedAt).toBeNull();
    expect(draftUpdate.completedAt).toBeInstanceOf(Date);

    // leagues.status is NOT touched — state machine transition is admin-driven.
    expect(capturedTx!._updateSetMocks).toHaveLength(1);

    // runGroupDraw is called (schedule_slots will be created)
    expect(mockRunGroupDraw).toHaveBeenCalledWith(LEAGUE_ID);
  });

  it("runGroupDraw failure does not roll back the pick", async () => {
    const totalPicks = 14 * 8;
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      draft: { ...activeDraftBase, currentPickNumber: totalPicks },
    });

    const finalDraft = { ...activeDraftBase, currentPickNumber: totalPicks };
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTxMock(finalDraft))
    );
    setupSelects();

    mockRunGroupDraw.mockRejectedValueOnce(new Error("draw exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await submitPick({
      leagueId: LEAGUE_ID,
      draftType: "initial",
      managerId: MANAGER_ID,
      playerId: PLAYER_ID,
    });

    // Pick succeeded despite runGroupDraw failing
    expect(result).toEqual({ pickNumber: totalPicks, isFinalPick: true });

    // Give the rejection handler a chance to run
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("concurrency — pick number mismatch inside transaction", () => {
  it("throws a clear error when the draft has already advanced past the expected pick", async () => {
    // getDraftState sees pick 5, but by the time the tx locks the row,
    // another caller has already advanced it to pick 6.
    mockGetDraftState.mockResolvedValue({
      ...activeState,
      draft: { ...activeDraftBase, currentPickNumber: 5 },
    });
    setupSelects();

    // Locked draft is at pick 6 — simulates the winning concurrent caller
    // having already committed.
    const advancedDraft = { ...activeDraftBase, currentPickNumber: 6 };
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTxMock(advancedDraft))
    );

    await expect(
      submitPick({
        leagueId: LEAGUE_ID,
        draftType: "initial",
        managerId: MANAGER_ID,
        playerId: PLAYER_ID,
      })
    ).rejects.toThrow("mismatch");
  });
});
