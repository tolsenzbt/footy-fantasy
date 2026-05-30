import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

const { mockDb, mockValidateLineup } = vi.hoisted(() => ({
  mockDb: { transaction: vi.fn() },
  mockValidateLineup: vi.fn(),
}));

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("./validate", () => ({ validateLineup: mockValidateLineup }));

// Fluent select-chain mock (awaitable at any depth via .then binding).
function sel(result: unknown) {
  const terminal = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    for: vi.fn(),
    limit: vi.fn().mockReturnValue(terminal),
  };
  for (const m of ["from", "where", "innerJoin", "leftJoin", "for"]) {
    (chain[m] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  Object.assign(chain, { then: terminal.then.bind(terminal) });
  return chain;
}

// Import schema tables so the tx mock can identify inserts by table reference.
import { lineups, lineupSlots } from "@/db/schema";
import { setLineup } from "./actions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAGUE_ID = "league-uuid";
const MANAGER_ID = "manager-uuid";
const ROUND_ID = "round-uuid";
const LINEUP_ID = "lineup-uuid";

const STARTERS = ["p01","p02","p03","p04","p05","p06","p07","p08","p09","p10","p11"];
const BENCH    = ["p12","p13","p14"];

const validArgs = {
  leagueId: LEAGUE_ID,
  managerId: MANAGER_ID,
  fantasyRoundId: ROUND_ID,
  formation: "4-4-2",
  starterPlayerIds: STARTERS,
  benchPlayerIds: BENCH,
  captainPlayerId: "p01",
  vcPlayerId: "p02",
};

const existingLineupRow = {
  id: LINEUP_ID,
  leagueId: LEAGUE_ID,
  managerId: MANAGER_ID,
  fantasyRoundId: ROUND_ID,
  formation: "4-4-2",
  captainPlayerId: "p01",
  vcPlayerId: "p02",
  captainLockedAt: null as Date | null,
  vcLockedAt: null as Date | null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const existingSlotRows = [
  ...STARTERS.map(id => ({ playerId: id, slotType: "starter" as const, lockedAt: null })),
  ...BENCH.map(id => ({ playerId: id, slotType: "bench" as const, lockedAt: null })),
];

// Build tx mock with configurable select responses and insert tracking.
function makeTxMock(opts: {
  existingLineup?: typeof existingLineupRow | null;
  existingSlots?: Array<{ playerId: string; slotType: "starter" | "bench"; lockedAt: Date | null }>;
} = {}) {
  let selectCallCount = 0;
  const slotInsertArgs: unknown[] = [];
  let lineupInsertArgs: unknown = null;
  let updateSetArgs: unknown = null;
  let deleteCalled = false;

  const existing = opts.existingLineup ?? null;

  const tx = {
    select: vi.fn().mockImplementation(() => {
      const idx = selectCallCount++;
      const resultsByIdx: unknown[][] = [
        [], // 0: roster (validate is mocked so content doesn't matter)
        existing ? [existing] : [], // 1: existing lineup FOR UPDATE
        opts.existingSlots ?? existingSlotRows, // 2: slots (only reached if existing)
      ];
      return sel(resultsByIdx[idx] ?? []);
    }),

    insert: vi.fn().mockImplementation((table: unknown) => {
      if (table === lineups) {
        return {
          values: vi.fn().mockImplementation((vals: unknown) => {
            lineupInsertArgs = vals;
            return {
              returning: vi.fn().mockResolvedValue([{ id: LINEUP_ID }]),
            };
          }),
        };
      }
      // lineupSlots
      return {
        values: vi.fn().mockImplementation((vals: unknown[]) => {
          slotInsertArgs.push(...vals);
          return {
            returning: vi.fn().mockResolvedValue(
              vals.map((v: any) => ({
                playerId: v.playerId,
                slotType: v.slotType,
                lockedAt: v.lockedAt ?? null,
              }))
            ),
          };
        }),
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((vals: unknown) => {
        updateSetArgs = vals;
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    })),

    delete: vi.fn().mockImplementation(() => {
      deleteCalled = true;
      return { where: vi.fn().mockResolvedValue([]) };
    }),

    _slotInsertArgs: slotInsertArgs,
    get _lineupInsertArgs() { return lineupInsertArgs; },
    get _updateSetArgs() { return updateSetArgs; },
    get _deleteCalled() { return deleteCalled; },
  };
  return tx;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockValidateLineup.mockReturnValue({ ok: true });
  mockDb.transaction.mockImplementation(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) =>
    fn(makeTxMock())
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("validation failure", () => {
  it("throws the validation error message", async () => {
    mockValidateLineup.mockReturnValue({ ok: false, error: "Captain must be in starting XI" });
    await expect(setLineup(validArgs)).rejects.toThrow("Captain must be in starting XI");
  });
});

describe("fresh lineup (no existing)", () => {
  it("inserts lineup row and 14 slots, returns correct result", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
      capturedTx = makeTxMock({ existingLineup: null });
      return fn(capturedTx);
    });

    const result = await setLineup(validArgs);

    expect(result.lineupId).toBe(LINEUP_ID);
    expect(result.formation).toBe("4-4-2");
    expect(result.captainPlayerId).toBe("p01");
    expect(result.vcPlayerId).toBe("p02");
    expect(result.starters).toHaveLength(11);
    expect(result.bench).toHaveLength(3);

    // 14 slot rows inserted
    expect(capturedTx!._slotInsertArgs).toHaveLength(14);
    // No delete for fresh lineup
    expect(capturedTx!._deleteCalled).toBe(false);
    // Lineup was inserted, not updated
    expect(capturedTx!._lineupInsertArgs).toBeTruthy();
    expect(capturedTx!._updateSetArgs).toBeNull();
  });

  it("all inserted slots have null lockedAt", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
      capturedTx = makeTxMock({ existingLineup: null });
      return fn(capturedTx);
    });

    await setLineup(validArgs);

    const slots = capturedTx!._slotInsertArgs as Array<{ lockedAt: unknown }>;
    for (const s of slots) {
      expect(s.lockedAt).toBeNull();
    }
  });
});

describe("existing lineup update", () => {
  it("updates lineup row, deletes old slots, re-inserts 14 slots", async () => {
    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
      capturedTx = makeTxMock({ existingLineup: existingLineupRow });
      return fn(capturedTx);
    });

    const result = await setLineup(validArgs);

    expect(result.lineupId).toBe(LINEUP_ID);
    expect(capturedTx!._updateSetArgs).toBeTruthy();
    expect(capturedTx!._deleteCalled).toBe(true);
    expect(capturedTx!._slotInsertArgs).toHaveLength(14);
    expect(capturedTx!._lineupInsertArgs).toBeNull();
  });

  it("preserves lockedAt from previous slot", async () => {
    const lockedAt = new Date("2026-06-01T09:00:00Z");
    const slotsWithLock = existingSlotRows.map(s =>
      s.playerId === "p01" ? { ...s, lockedAt } : s
    );

    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
      capturedTx = makeTxMock({ existingLineup: existingLineupRow, existingSlots: slotsWithLock });
      return fn(capturedTx);
    });

    await setLineup(validArgs);

    const slots = capturedTx!._slotInsertArgs as Array<{ playerId: string; lockedAt: Date | null }>;
    const p01Slot = slots.find(s => s.playerId === "p01");
    expect(p01Slot?.lockedAt).toEqual(lockedAt);
    // Other slots have null
    const p02Slot = slots.find(s => s.playerId === "p02");
    expect(p02Slot?.lockedAt).toBeNull();
  });

  it("clears captainLockedAt when captain changes", async () => {
    const prevWithCaptainLock = {
      ...existingLineupRow,
      captainLockedAt: new Date("2026-06-01T09:00:00Z"),
    };

    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
      capturedTx = makeTxMock({ existingLineup: prevWithCaptainLock });
      return fn(capturedTx);
    });

    // Change captain from p01 to p02
    await setLineup({ ...validArgs, captainPlayerId: "p02", vcPlayerId: "p03" });

    const update = capturedTx!._updateSetArgs as { captainLockedAt: unknown };
    expect(update.captainLockedAt).toBeNull();
  });

  it("preserves captainLockedAt when captain stays the same", async () => {
    const captainLock = new Date("2026-06-01T09:00:00Z");
    const prevWithLock = { ...existingLineupRow, captainLockedAt: captainLock };

    let capturedTx: ReturnType<typeof makeTxMock>;
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
      capturedTx = makeTxMock({ existingLineup: prevWithLock });
      return fn(capturedTx);
    });

    await setLineup(validArgs);

    const update = capturedTx!._updateSetArgs as { captainLockedAt: unknown };
    expect(update.captainLockedAt).toEqual(captainLock);
  });
});

describe("slot ordering in result", () => {
  it("starters list has 11 entries, bench has 3", async () => {
    const result = await setLineup(validArgs);
    expect(result.starters).toHaveLength(11);
    expect(result.bench).toHaveLength(3);
  });

  it("starterPlayerIds order preserved in starters", async () => {
    const result = await setLineup(validArgs);
    const returnedIds = result.starters.map(s => s.playerId);
    expect(returnedIds).toEqual(STARTERS);
  });
});
