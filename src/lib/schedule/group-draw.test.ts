import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("crypto", () => ({ randomInt: vi.fn((min: number, max: number) => min) }));

const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), transaction: vi.fn() },
}));

vi.mock("@/db", () => ({ db: mockDb }));

// Fluent select-chain mock that resolves at .limit() or when awaited directly.
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
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

// Import schemas so we can compare table references in the tx mock.
import {
  scheduleSlots,
  fantasyRounds,
  fantasyMatchups,
} from "@/db/schema";
import { runGroupDraw } from "./group-draw";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAGUE_ID = "league-uuid";

const draftingLeague = {
  id: LEAGUE_ID,
  format: "eight" as const,
  status: "drafting" as const,
};

const completeDraft = {
  id: "draft-uuid",
  leagueId: LEAGUE_ID,
  type: "initial" as const,
  status: "complete" as const,
};

function makeMemberships(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `manager-${i + 1}`,
    leagueId: LEAGUE_ID,
    role: "manager" as const,
  }));
}

// Round rows returned by tx.insert(fantasyRounds).values(...).returning()
const ROUND_IDS = {
  group_md1: "round-gmd1",
  group_md2: "round-gmd2",
  group_md3: "round-gmd3",
  qf: "round-qf",
  sf: "round-sf",
  final: "round-final",
};
const ROUND_ROWS = Object.entries(ROUND_IDS).map(([round, id]) => ({ id, round }));

// Build a tx mock that tracks inserts by table reference.
function makeTxMock() {
  const slotInsertArgs: unknown[] = [];
  const groupMatchupArgs: unknown[] = [];
  const knockoutMatchupArgs: unknown[] = [];
  let matchupCallCount = 0;

  const tx = {
    select: vi.fn().mockReturnValue(sel([draftingLeague])),
    insert: vi.fn().mockImplementation((table: unknown) => {
      if (table === scheduleSlots) {
        return {
          values: vi.fn().mockImplementation((vals: unknown[]) => {
            slotInsertArgs.push(...vals);
            return Promise.resolve([]);
          }),
        };
      }
      if (table === fantasyRounds) {
        return {
          values: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockResolvedValue(ROUND_ROWS),
          })),
        };
      }
      // fantasyMatchups — first call = group, second = knockout
      const callIdx = matchupCallCount++;
      return {
        values: vi.fn().mockImplementation((vals: unknown[]) => {
          if (callIdx === 0) groupMatchupArgs.push(...vals);
          else knockoutMatchupArgs.push(...vals);
          return Promise.resolve([]);
        }),
      };
    }),
    _slotInsertArgs: slotInsertArgs,
    _groupMatchupArgs: groupMatchupArgs,
    _knockoutMatchupArgs: knockoutMatchupArgs,
  };
  return tx;
}

// ── Standard pre-tx select setup ─────────────────────────────────────────────

// Selects in order: league, draft, existing-slot check, memberships.
function setupSelects(opts: {
  league?: unknown;
  draft?: unknown;
  existingSlot?: unknown;
  memberships?: unknown[];
} = {}) {
  mockDb.select
    .mockReturnValueOnce(sel([opts.league ?? draftingLeague]))
    .mockReturnValueOnce(sel([opts.draft ?? completeDraft]))
    .mockReturnValueOnce(sel(opts.existingSlot !== undefined ? [opts.existingSlot] : []))
    .mockReturnValueOnce(sel(opts.memberships ?? makeMemberships(8)));
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.transaction.mockImplementation(
    async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) =>
      fn(makeTxMock())
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("precondition rejections", () => {
  it("throws when league not found", async () => {
    mockDb.select.mockReturnValueOnce(sel([]));
    await expect(runGroupDraw(LEAGUE_ID)).rejects.toThrow("not found");
  });

  it("throws when league status is not 'drafting'", async () => {
    mockDb.select.mockReturnValueOnce(sel([{ ...draftingLeague, status: "setup" }]));
    await expect(runGroupDraw(LEAGUE_ID)).rejects.toThrow("must be 'drafting'");
  });

  it("throws when no initial draft exists", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([draftingLeague]))
      .mockReturnValueOnce(sel([]));
    await expect(runGroupDraw(LEAGUE_ID)).rejects.toThrow("must be complete");
  });

  it("throws when draft is not complete", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([draftingLeague]))
      .mockReturnValueOnce(sel([{ ...completeDraft, status: "active" }]));
    await expect(runGroupDraw(LEAGUE_ID)).rejects.toThrow("must be complete");
  });

  it("throws when schedule_slots already exist (idempotency guard)", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([draftingLeague]))
      .mockReturnValueOnce(sel([completeDraft]))
      .mockReturnValueOnce(sel([{ id: "existing-slot" }]));
    await expect(runGroupDraw(LEAGUE_ID)).rejects.toThrow("already run");
  });
});

describe("happy path — 8-team", () => {
  it("returns correct counts", async () => {
    setupSelects();
    const result = await runGroupDraw(LEAGUE_ID);
    expect(result).toEqual({
      slotsAssigned: 8,
      groupMatchupsCreated: 12,
      knockoutMatchupsCreated: 7,
      fantasyRoundsCreated: 6,
    });
  });

  it("inserts 8 schedule_slots with correct fields", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects();
    await runGroupDraw(LEAGUE_ID);

    const slots = capturedTx!._slotInsertArgs as Array<{
      leagueId: string;
      slotCode: string;
      groupLetter: string;
      positionInGroup: number;
      managerId: string;
    }>;
    expect(slots).toHaveLength(8);
    // Every slot has leagueId and a non-null managerId
    for (const s of slots) {
      expect(s.leagueId).toBe(LEAGUE_ID);
      expect(s.managerId).toBeTruthy();
      expect(s.groupLetter).toBe(s.slotCode[0]);
      expect(s.positionInGroup).toBe(parseInt(s.slotCode.slice(1), 10));
    }
  });

  it("inserts 12 group-stage matchups and 7 knockout matchups", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects();
    await runGroupDraw(LEAGUE_ID);

    expect(capturedTx!._groupMatchupArgs).toHaveLength(12);
    expect(capturedTx!._knockoutMatchupArgs).toHaveLength(7);
  });

  it("slot-to-manager mapping: every membership.id appears exactly once in slots", async () => {
    const members = makeMemberships(8);
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects({ memberships: members });
    await runGroupDraw(LEAGUE_ID);

    const assignedIds = (capturedTx!._slotInsertArgs as Array<{ managerId: string }>)
      .map(s => s.managerId)
      .sort();
    const memberIds = members.map(m => m.id).sort();
    expect(assignedIds).toEqual(memberIds);
  });

  it("8-team: exactly 2 qf matchups have awaySeedSource='BYE' with homeManagerId=null", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects();
    await runGroupDraw(LEAGUE_ID);

    const allKnockout = capturedTx!._knockoutMatchupArgs as Array<{
      fantasyRoundId: string;
      awaySeedSource: string;
      homeManagerId: unknown;
      awayManagerId: unknown;
    }>;

    const byeRows = allKnockout.filter(m => m.awaySeedSource === "BYE");
    expect(byeRows).toHaveLength(2);
    for (const row of byeRows) {
      expect(row.homeManagerId).toBeNull();
      expect(row.awayManagerId).toBeNull();
    }

    const byeHomeSeeds = allKnockout
      .filter(m => m.awaySeedSource === "BYE")
      .map(m => (m as unknown as { homeSeedSource: string }).homeSeedSource)
      .sort();
    expect(byeHomeSeeds).toEqual(["1A", "1B"]);
  });

  it("group matchups reference correct fantasyRoundIds from the inserted rounds", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects();
    await runGroupDraw(LEAGUE_ID);

    const groupArgs = capturedTx!._groupMatchupArgs as Array<{
      fantasyRoundId: string;
    }>;
    const validRoundIds = new Set([
      ROUND_IDS.group_md1,
      ROUND_IDS.group_md2,
      ROUND_IDS.group_md3,
    ]);
    for (const m of groupArgs) {
      expect(validRoundIds.has(m.fantasyRoundId)).toBe(true);
    }
  });

  it("group matchups have homeManagerId and awayManagerId populated (not null)", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects();
    await runGroupDraw(LEAGUE_ID);

    const groupArgs = capturedTx!._groupMatchupArgs as Array<{
      homeManagerId: unknown;
      awayManagerId: unknown;
    }>;
    for (const m of groupArgs) {
      expect(m.homeManagerId).toBeTruthy();
      expect(m.awayManagerId).toBeTruthy();
    }
  });

  it("knockout matchups have homeManagerId and awayManagerId null", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(
      async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        capturedTx = makeTxMock();
        return fn(capturedTx);
      }
    );
    setupSelects();
    await runGroupDraw(LEAGUE_ID);

    const koArgs = capturedTx!._knockoutMatchupArgs as Array<{
      homeManagerId: unknown;
      awayManagerId: unknown;
    }>;
    for (const m of koArgs) {
      expect(m.homeManagerId).toBeNull();
      expect(m.awayManagerId).toBeNull();
    }
  });
});

describe("12-team format", () => {
  const league12 = { ...draftingLeague, format: "twelve" as const };

  it("creates 12 slots, 18 group matchups, 7 knockout matchups, 6 rounds", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([league12]))
      .mockReturnValueOnce(sel([completeDraft]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel(makeMemberships(12)));
    const result = await runGroupDraw(LEAGUE_ID);
    expect(result).toEqual({
      slotsAssigned: 12,
      groupMatchupsCreated: 18,
      knockoutMatchupsCreated: 7,
      fantasyRoundsCreated: 6,
    });
  });
});

describe("16-team format", () => {
  const league16 = { ...draftingLeague, format: "sixteen" as const };

  it("creates 16 slots, 24 group matchups, 7 knockout matchups, 6 rounds", async () => {
    mockDb.select
      .mockReturnValueOnce(sel([league16]))
      .mockReturnValueOnce(sel([completeDraft]))
      .mockReturnValueOnce(sel([]))
      .mockReturnValueOnce(sel(makeMemberships(16)));
    const result = await runGroupDraw(LEAGUE_ID);
    expect(result).toEqual({
      slotsAssigned: 16,
      groupMatchupsCreated: 24,
      knockoutMatchupsCreated: 7,
      fantasyRoundsCreated: 6,
    });
  });
});
